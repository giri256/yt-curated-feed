/**
 * background.js  —  MV3 Service Worker (plain JS, no bundler needed)
 *
 * Responsibilities:
 *  • Coordinate the channels-scraper content script (open tab, wait for results)
 *  • Resolve @handle channel IDs to UC IDs via a lightweight page fetch
 *  • Fetch recent videos via YouTube's public Atom RSS feed — no auth required
 *  • Expose a chrome.runtime.onMessage API:
 *
 *      OPEN_CHANNELS_PAGE  → opens/focuses youtube.com/feed/channels tab
 *      GET_CHANNELS        → returns cached channel list
 *      SCRAPE_CHANNELS     → starts a persisted scrape and returns immediately
 *      GET_FEED            → fetches & filters RSS for selected channels
 *      SAVE_SELECTION      → persists selected channel IDs + metadata
 *      GET_SELECTION       → returns persisted selection
 *      APPEND_DIAGNOSTIC_LOG → stores one opt-in timeline entry (capped list)
 *      GET_DIAGNOSTIC_LOGS → returns stored timeline entries
 *      CLEAR_DIAGNOSTIC_LOGS → empties the stored timeline
 */

'use strict';

// ─── Storage helpers ──────────────────────────────────────────────────────────
function storageGet(key) {
  return new Promise((res) =>
    chrome.storage.local.get(key, (r) => res(r[key] ?? null))
  );
}
function storageSet(data) {
  return new Promise((res) => chrome.storage.local.set(data, res));
}

function sessionGet(key) {
  return new Promise((res) =>
    chrome.storage.session.get(key, (result) => res(result[key] ?? null))
  );
}

function sessionSet(data) {
  return new Promise((res) => chrome.storage.session.set(data, res));
}

function normalizeText(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function dedupeRepeatedText(text = '') {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const words = normalized.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const mid = words.length / 2;
    const firstHalf = words.slice(0, mid).join(' ');
    const secondHalf = words.slice(mid).join(' ');
    if (firstHalf.toLowerCase() === secondHalf.toLowerCase()) {
      return firstHalf;
    }
  }

  return normalized;
}

function cleanChannelName(text = '') {
  return dedupeRepeatedText(text);
}

function cleanHandle(text = '') {
  const normalized = dedupeRepeatedText(text);
  if (!normalized) return '';

  const match = normalized.match(/@[\w.-]+/);
  return match?.[0] ?? normalized;
}

function normalizeThumbnailUrl(url = '') {
  let normalized = normalizeText(url);
  if (!normalized || normalized.startsWith('data:')) return '';
  if (normalized.startsWith('//')) normalized = `https:${normalized}`;
  return normalized.replace(/\\u0026/g, '&');
}

function parseCountText(text = '') {
  const normalized = normalizeText(text)
    .replace(/subscribers?/i, '')
    .replace(/views?/i, '')
    .trim();
  if (!normalized) return 0;

  const compactMatch = normalized.match(/([\d,.]+)\s*([KMBT])/i);
  if (compactMatch) {
    const value = parseFloat(compactMatch[1].replace(/,/g, ''));
    const suffix = compactMatch[2].toUpperCase();
    const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    return Math.round((Number.isFinite(value) ? value : 0) * (multipliers[suffix] ?? 1));
  }

  const plain = parseInt(normalized.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(plain) ? plain : 0;
}

function decodeJsonString(text = '') {
  if (!text) return '';
  try {
    return JSON.parse(`"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  } catch (_) {
    return text.replace(/\\u0026/g, '&');
  }
}

function normalizeChannel(channel = {}) {
  return {
    ...channel,
    name: cleanChannelName(channel.name || '—') || '—',
    handle: cleanHandle(channel.handle || ''),
    subscriberCount: normalizeText(channel.subscriberCount || ''),
    thumbnail: normalizeThumbnailUrl(channel.thumbnail || ''),
  };
}

function normalizeChannels(channels = []) {
  return channels
    .map((channel) => normalizeChannel(channel))
    .filter((channel) => channel.id);
}

function normalizeChannelsMeta(channelsMeta = {}) {
  return Object.fromEntries(
    Object.entries(channelsMeta).map(([id, meta]) => [
      id,
      {
        ...meta,
        name: cleanChannelName(meta?.name || ''),
        handle: cleanHandle(meta?.handle || ''),
        thumbnail: normalizeThumbnailUrl(meta?.thumbnail || ''),
        subscriberCount: normalizeText(meta?.subscriberCount || ''),
      },
    ])
  );
}

const DEFAULT_PREFERENCES = {
  videoTypeFilters: {
    standard: true,
    // Off by default, matching focus.hideShorts.
    shorts: false,
    live: false,
    other: true,
  },
  enableLogging: false,
  // 'full': the curated feed replaces YouTube's homepage. 'panel': compact
  // panel above YouTube's own homepage feed (opt-in for enthusiasts).
  homepageMode: 'full',
  // Pinned player quality ('auto' = YouTube decides). See page-main.js.
  preferredQuality: 'auto',
  // Distraction hiding; mirrored in focus.js FOCUS_DEFAULTS.
  focus: {
    hideShorts: true,
    hideRelated: false,
    hideEndscreen: true,
    hideEndCards: false,
    disableAutoplay: true,
    hideComments: false,
    hideLiveChat: false,
    hideMixes: false,
    hideMerch: false,
    hideFundraiser: false,
    hidePlaylist: false,
    hideExplore: false,
    hideMoreFromYouTube: false,
    hideNotifications: false,
    hideSearchShelves: false,
    hideVideoSidebar: false,
    hideVideoInfo: false,
    hideVideoButtonsBar: false,
    hideChannel: false,
    hideDescription: false,
    hideAnnotations: false,
    hideTopHeader: false,
    hideSubscriptions: false,
  },
};

const HOMEPAGE_MODES = new Set(['full', 'panel']);
const QUALITY_LEVELS = new Set(['auto', 'tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'hd2880', 'highres']);

function normalizeFocus(focus = {}) {
  const normalized = {};
  for (const [key, fallback] of Object.entries(DEFAULT_PREFERENCES.focus)) {
    normalized[key] = typeof focus?.[key] === 'boolean' ? focus[key] : fallback;
  }
  return normalized;
}

function normalizeLayoutPreferences(preferences = {}) {
  return {
    homepageMode: HOMEPAGE_MODES.has(preferences.homepageMode) ? preferences.homepageMode : DEFAULT_PREFERENCES.homepageMode,
    preferredQuality: QUALITY_LEVELS.has(preferences.preferredQuality) ? preferences.preferredQuality : DEFAULT_PREFERENCES.preferredQuality,
  };
}

async function getPreferences() {
  const stored = (await storageGet('preferences')) ?? {};
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    videoTypeFilters: {
      ...DEFAULT_PREFERENCES.videoTypeFilters,
      ...(stored.videoTypeFilters ?? {}),
    },
    enableLogging: Boolean(stored.enableLogging),
    ...normalizeLayoutPreferences(stored),
    focus: normalizeFocus(stored.focus),
  };
}

async function savePreferences(nextPreferences = {}) {
  const current = await getPreferences();
  const merged = {
    ...current,
    ...nextPreferences,
    videoTypeFilters: {
      ...DEFAULT_PREFERENCES.videoTypeFilters,
      ...(current.videoTypeFilters ?? {}),
      ...(nextPreferences.videoTypeFilters ?? {}),
    },
    enableLogging: 'enableLogging' in nextPreferences
      ? Boolean(nextPreferences.enableLogging)
      : current.enableLogging,
    ...normalizeLayoutPreferences({ ...current, ...nextPreferences }),
    focus: normalizeFocus({ ...current.focus, ...(nextPreferences.focus ?? {}) }),
  };
  await storageSet({ preferences: merged });
  return merged;
}

// ─── Diagnostic logging (opt-in, off by default) ─────────────────────────────
// Timeline entries (e.g. page opened → feed requested → response → rendered)
// are persisted here in a capped list so the popup can show them. Each entry:
//   { ts: ISO string, source: 'background'|'homepage'|'feed-page'|'popup',
//     event: 'feed.request'|'feed.timeline'|..., details: {...} }
const DIAGNOSTIC_LOG_KEY = 'diagnosticLogs';
const MAX_DIAGNOSTIC_LOG_ENTRIES = 200;

function normalizeDiagnosticEntry(entry = {}) {
  return {
    ts: typeof entry.ts === 'string' && entry.ts ? entry.ts : new Date().toISOString(),
    source: normalizeText(entry.source) || 'unknown',
    event: normalizeText(entry.event) || 'event',
    details: entry.details && typeof entry.details === 'object' ? entry.details : {},
  };
}

async function getDiagnosticLogs(limit = MAX_DIAGNOSTIC_LOG_ENTRIES) {
  const stored = (await storageGet(DIAGNOSTIC_LOG_KEY)) ?? [];
  const entries = Array.isArray(stored) ? stored.filter(Boolean) : [];
  const count = Math.min(Math.max(1, Number(limit) || MAX_DIAGNOSTIC_LOG_ENTRIES), MAX_DIAGNOSTIC_LOG_ENTRIES);
  return entries.slice(-count);
}

async function appendDiagnosticLog(entry = {}) {
  const entries = await getDiagnosticLogs(MAX_DIAGNOSTIC_LOG_ENTRIES);
  entries.push(normalizeDiagnosticEntry(entry));
  await storageSet({ [DIAGNOSTIC_LOG_KEY]: entries.slice(-MAX_DIAGNOSTIC_LOG_ENTRIES) });
  return { ok: true };
}

async function clearDiagnosticLogs() {
  await storageSet({ [DIAGNOSTIC_LOG_KEY]: [] });
  return { ok: true };
}

const OPENED_VIDEO_IDS_KEY = 'openedVideoIds';
const MAX_SESSION_OPENED_VIDEOS = 3000;
let openedVideoWriteQueue = Promise.resolve();

function broadcastToExtensionAndYouTube(message) {
  try {
    chrome.runtime.sendMessage(message);
  } catch (_) {}

  void chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        chrome.tabs.sendMessage(tab.id, message, () => void chrome.runtime.lastError);
      } catch (_) {}
    }
  }).catch(() => {});
}

async function getOpenedVideoIds() {
  const ids = (await sessionGet(OPENED_VIDEO_IDS_KEY)) ?? [];
  return Array.from(new Set(ids.filter(Boolean))).slice(-MAX_SESSION_OPENED_VIDEOS);
}

function markVideoOpened(videoId) {
  const normalizedId = normalizeText(videoId);
  if (!normalizedId) return getOpenedVideoIds();

  const task = openedVideoWriteQueue.then(async () => {
    const ids = await getOpenedVideoIds();
    const next = ids.filter((id) => id !== normalizedId);
    next.push(normalizedId);
    if (next.length > MAX_SESSION_OPENED_VIDEOS) {
      next.splice(0, next.length - MAX_SESSION_OPENED_VIDEOS);
    }
    await sessionSet({ [OPENED_VIDEO_IDS_KEY]: next });

    broadcastToExtensionAndYouTube({ type: 'VIDEO_OPENED', videoId: normalizedId });
    return next;
  });
  openedVideoWriteQueue = task.catch(() => {});
  return task;
}

const WATCH_TIME_DAILY_KEY = 'watchTimeDaily';
const WATCH_TIME_LIMIT_KEY = 'watchTimeLimitMinutes';
const MAX_WATCH_DELTA_SECONDS = 15;
let watchTimeWriteQueue = Promise.resolve();

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateDaysAgo(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date;
}

function normalizeWatchDaily(daily = {}) {
  const cutoff = localDateKey(dateDaysAgo(370));
  return Object.fromEntries(
    Object.entries(daily)
      .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff)
      .map(([date, seconds]) => [date, Math.max(0, Math.round(Number(seconds) || 0))])
  );
}

async function getWatchTimeLimitMinutes() {
  const stored = Number((await storageGet(WATCH_TIME_LIMIT_KEY)) ?? 0);
  return Number.isFinite(stored) ? Math.min(1440, Math.max(0, Math.round(stored))) : 0;
}

async function getWatchStats() {
  const daily = normalizeWatchDaily((await storageGet(WATCH_TIME_DAILY_KEY)) ?? {});
  const dailyLimitMinutes = await getWatchTimeLimitMinutes();
  const todayKey = localDateKey();
  const todaySeconds = daily[todayKey] ?? 0;

  const today = new Date();
  const dayFromMonday = (today.getDay() + 6) % 7;
  const weekKeys = Array.from({ length: dayFromMonday + 1 }, (_, index) =>
    localDateKey(dateDaysAgo(dayFromMonday - index))
  );
  const last7Days = Array.from({ length: 7 }, (_, index) => {
    const date = localDateKey(dateDaysAgo(6 - index));
    return { date, seconds: daily[date] ?? 0 };
  });
  const limitSeconds = dailyLimitMinutes * 60;

  return {
    todaySeconds,
    weekSeconds: weekKeys.reduce((sum, date) => sum + (daily[date] ?? 0), 0),
    last7DaysSeconds: last7Days.reduce((sum, entry) => sum + entry.seconds, 0),
    last7Days,
    dailyLimitMinutes,
    blocked: dailyLimitMinutes > 0 && todaySeconds >= limitSeconds,
    remainingSeconds: dailyLimitMinutes > 0 ? Math.max(0, limitSeconds - todaySeconds) : null,
  };
}

function broadcastWatchStatus(stats) {
  broadcastToExtensionAndYouTube({ type: 'WATCH_STATUS_UPDATED', stats });
}

function recordWatchTime(deltaSeconds) {
  const normalizedDelta = Math.min(
    MAX_WATCH_DELTA_SECONDS,
    Math.max(0, Number(deltaSeconds) || 0)
  );
  if (normalizedDelta <= 0) return getWatchStats();

  const task = watchTimeWriteQueue.then(async () => {
    const daily = normalizeWatchDaily((await storageGet(WATCH_TIME_DAILY_KEY)) ?? {});
    const todayKey = localDateKey();
    daily[todayKey] = (daily[todayKey] ?? 0) + normalizedDelta;
    await storageSet({ [WATCH_TIME_DAILY_KEY]: daily });
    const stats = await getWatchStats();
    if (stats.blocked) broadcastWatchStatus(stats);
    return stats;
  });
  watchTimeWriteQueue = task.catch(() => {});
  return task;
}

async function saveWatchTimeLimit(minutes) {
  const normalized = Math.min(1440, Math.max(0, Math.round(Number(minutes) || 0)));
  await storageSet({ [WATCH_TIME_LIMIT_KEY]: normalized });
  const stats = await getWatchStats();
  broadcastWatchStatus(stats);
  return stats;
}

function mergeSelectedIntoChannels(channels = [], selectedIds = [], selectedMeta = {}) {
  const next = normalizeChannels(channels);
  for (const id of selectedIds) {
    if (!id || next.some((channel) => channel.id === id)) continue;
    const meta = selectedMeta[id] ?? {};
    next.push(normalizeChannel({
      id,
      name: meta.name || meta.handle || '—',
      handle: meta.handle || '',
      thumbnail: meta.thumbnail || '',
      subscriberCount: meta.subscriberCount || '',
    }));
  }
  return next;
}

async function getExportPayload() {
  const allChannels = normalizeChannels((await storageGet('allChannels')) ?? []);
  const allChannelsMeta = normalizeChannelsMeta((await storageGet('allChannelsMeta')) ?? {});
  const selectedChannelIds = ((await storageGet('selectedChannelIds')) ?? []).filter(Boolean);
  const selectedChannelsMeta = normalizeChannelsMeta((await storageGet('selectedChannelsMeta')) ?? {});
  const preferences = await getPreferences();

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'YT Curated Feed',
    data: {
      allChannels,
      allChannelsMeta,
      selectedChannelIds,
      selectedChannelsMeta,
      preferences,
    },
  };
}

async function importPayload(payload = {}) {
  const data = payload?.data ?? payload;
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid import file.');
  }

  const selectedChannelsMeta = normalizeChannelsMeta(data.selectedChannelsMeta ?? {});
  const selectedChannelIds = Array.from(new Set((data.selectedChannelIds ?? []).filter(Boolean)));
  const allChannels = mergeSelectedIntoChannels(data.allChannels ?? [], selectedChannelIds, selectedChannelsMeta);
  const allChannelsMeta = {
    ...normalizeChannelsMeta(data.allChannelsMeta ?? {}),
  };

  for (const channel of allChannels) {
    allChannelsMeta[channel.id] = {
      ...(allChannelsMeta[channel.id] ?? {}),
      name: channel.name,
      thumbnail: channel.thumbnail,
      subscriberCount: channel.subscriberCount,
      handle: channel.handle,
    };
  }

  for (const id of selectedChannelIds) {
    if (!selectedChannelsMeta[id]) {
      const fallback = allChannelsMeta[id] ?? {};
      selectedChannelsMeta[id] = {
        name: fallback.name || '',
        thumbnail: fallback.thumbnail || '',
        subscriberCount: fallback.subscriberCount || '',
        handle: fallback.handle || '',
      };
    }
  }

  const preferences = await savePreferences(data.preferences ?? {});
  await storageSet({
    allChannels,
    allChannelsMeta,
    selectedChannelIds,
    selectedChannelsMeta,
    channelsLoadedAt: allChannels.length ? Date.now() : 0,
    scrapeInProgress: false,
    scrapeStartedAt: 0,
    scrapeProgressCount: 0,
    scrapeChannelsProgress: [],
    scrapeError: '',
    scrapeTabId: null,
    scrapeTabCreatedByExtension: false,
    scrapeReturnTabId: null,
    scrapeReturnWindowId: null,
  });

  try {
    chrome.runtime.sendMessage({ type: 'CHANNELS_CACHE_UPDATED', channels: allChannels });
  } catch (_) {}

  return {
    channels: allChannels,
    selectedChannelIds,
    selectedChannelsMeta,
    preferences,
  };
}

async function upsertCachedChannel(channel) {
  const normalizedChannel = normalizeChannel(channel);
  if (!normalizedChannel.id) return;

  const existing = normalizeChannels((await storageGet('allChannels')) ?? []);
  const next = existing.filter((entry) => entry.id !== normalizedChannel.id);
  next.unshift(normalizedChannel);

  const existingMeta = normalizeChannelsMeta((await storageGet('allChannelsMeta')) ?? {});
  existingMeta[normalizedChannel.id] = {
    name: normalizedChannel.name,
    thumbnail: normalizedChannel.thumbnail,
    subscriberCount: normalizedChannel.subscriberCount,
    handle: normalizedChannel.handle,
  };

  const manualIds = new Set((await storageGet('manuallyAddedChannelIds')) ?? []);
  manualIds.add(normalizedChannel.id);

  await storageSet({
    allChannels: next,
    allChannelsMeta: existingMeta,
    manuallyAddedChannelIds: [...manualIds],
  });
}

let channelHydrationPromise = null;

async function hydrateCachedChannelsInBackground() {
  if (channelHydrationPromise) return channelHydrationPromise;

  channelHydrationPromise = (async () => {
    const channels = normalizeChannels((await storageGet('allChannels')) ?? []);
    const missing = channels.filter((channel) => !channel.thumbnail);
    if (!missing.length) return;

    const next = [...channels];
    let changed = false;
    const BATCH = 4;

    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((channel) => fetchChannelProfile(channel.handle || channel.id))
      );

      for (let index = 0; index < batch.length; index++) {
        const result = results[index];
        if (result.status !== 'fulfilled') continue;

        const profile = result.value;
        const existingIndex = next.findIndex((channel) => channel.id === batch[index].id);
        if (existingIndex < 0) continue;

        const merged = normalizeChannel({
          ...next[existingIndex],
          thumbnail: next[existingIndex].thumbnail || profile.thumbnail,
          subscriberCount: next[existingIndex].subscriberCount || profile.subscriberCount,
          handle: next[existingIndex].handle || profile.handle,
          name: next[existingIndex].name || profile.name,
        });

        if (merged.thumbnail !== next[existingIndex].thumbnail || merged.subscriberCount !== next[existingIndex].subscriberCount) {
          next[existingIndex] = merged;
          changed = true;
        }
      }
    }

    if (!changed) return;

    const meta = {};
    for (const channel of next) {
      meta[channel.id] = {
        name: channel.name,
        thumbnail: channel.thumbnail,
        subscriberCount: channel.subscriberCount,
        handle: channel.handle,
      };
    }

    const selectedIds = (await storageGet('selectedChannelIds')) ?? [];
    const selectedMeta = normalizeChannelsMeta((await storageGet('selectedChannelsMeta')) ?? {});
    for (const channel of next) {
      if (!selectedIds.includes(channel.id)) continue;
      selectedMeta[channel.id] = {
        ...(selectedMeta[channel.id] ?? {}),
        name: channel.name,
        thumbnail: channel.thumbnail,
        subscriberCount: channel.subscriberCount,
        handle: channel.handle,
      };
    }

    await storageSet({ allChannels: next, allChannelsMeta: meta, selectedChannelsMeta: selectedMeta });

    try {
      chrome.runtime.sendMessage({ type: 'CHANNELS_CACHE_UPDATED', channels: next });
    } catch (_) {}
  })().finally(() => {
    channelHydrationPromise = null;
  });

  return channelHydrationPromise;
}

// ─── Channel tab management ───────────────────────────────────────────────────
const CHANNELS_URL = 'https://www.youtube.com/feed/channels';
const SCRAPE_TIMEOUT_MS = 3 * 60 * 1000;
let scrapeTabId = null;
let scrapeTabCreatedByExtension = false;
let scrapeReturnTabId = null;
let scrapeReturnWindowId = null;

/** Open (or focus) the channels page tab and return its tab ID. */
async function openChannelsTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (scrapeReturnTabId == null && activeTab?.id != null) {
    scrapeReturnTabId = activeTab.id;
    scrapeReturnWindowId = activeTab.windowId ?? null;
  }

  const existing = await chrome.tabs.query({ url: CHANNELS_URL + '*' });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    scrapeTabId = tab.id;
    scrapeTabCreatedByExtension = false;
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: CHANNELS_URL, active: true });
  scrapeTabId = tab.id;
  scrapeTabCreatedByExtension = true;
  return tab.id;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function triggerChannelsScraper(tabId) {
  try {
    await sendMessageToTab(tabId, { type: 'SCRAPE_NOW' });
  } catch (_) {
    // A newly created tab may not have its content script yet. On load, the
    // scraper checks the persisted scrape status and starts itself.
  }
}

async function closeScrapeTabIfNeeded() {
  const trackedTabId = scrapeTabId ?? await storageGet('scrapeTabId');
  const tabWasCreated = scrapeTabId != null
    ? scrapeTabCreatedByExtension
    : Boolean(await storageGet('scrapeTabCreatedByExtension'));
  const returnTabId = scrapeReturnTabId ?? await storageGet('scrapeReturnTabId');
  const returnWindowId = scrapeReturnWindowId ?? await storageGet('scrapeReturnWindowId');

  if (returnTabId) {
    try {
      await chrome.tabs.update(returnTabId, { active: true });
      if (returnWindowId) {
        await chrome.windows.update(returnWindowId, { focused: true });
      }
    } catch (_) {}
  }

  if (trackedTabId && tabWasCreated) {
    try {
      await chrome.tabs.remove(trackedTabId);
    } catch (_) {}
  }

  scrapeTabId = null;
  scrapeTabCreatedByExtension = false;
  scrapeReturnTabId = null;
  scrapeReturnWindowId = null;
  await storageSet({
    scrapeTabId: null,
    scrapeTabCreatedByExtension: false,
    scrapeReturnTabId: null,
    scrapeReturnWindowId: null,
  });
}

async function findOpenScrapeTab() {
  const trackedTabId = scrapeTabId ?? await storageGet('scrapeTabId');
  if (trackedTabId != null) {
    try {
      const tab = await chrome.tabs.get(trackedTabId);
      if (tab) return tab;
    } catch (_) {}
  }

  const matchingTabs = await chrome.tabs.query({ url: CHANNELS_URL + '*' });
  const tab = matchingTabs[0] ?? null;
  if (tab?.id != null) {
    scrapeTabId = tab.id;
    scrapeTabCreatedByExtension = false;
    await storageSet({ scrapeTabId: tab.id, scrapeTabCreatedByExtension: false });
  }
  return tab;
}

// ─── Channel metadata resolution ──────────────────────────────────────────────
const resolveCache = new Map();
const channelProfileCache = new Map();

function extractMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return decodeJsonString(match[1]);
  }
  return '';
}

function extractThumbnailFromHtml(html) {
  return normalizeThumbnailUrl(extractMatch(html, [
    /<link\s+itemprop="thumbnailUrl"\s+href="([^"]+)"/i,
    /"avatar"\s*:\s*\{[\s\S]*?"thumbnails"\s*:\s*\[\{"url":"([^"]+)"/i,
    /"channelMetadataRenderer"\s*:\s*\{[\s\S]*?"avatar"\s*:\s*\{[\s\S]*?"thumbnails"\s*:\s*\[\{"url":"([^"]+)"/i,
  ]));
}

function extractSubscriberCountFromHtml(html) {
  return normalizeText(extractMatch(html, [
    /"subscriberCountText"\s*:\s*\{"simpleText":"([^"]+)"/i,
    /"subscriberCountText"\s*:\s*\{"runs":\[\{"text":"([^"]+)"/i,
    /"ownerSubCount"\s*:\s*"([^"]+)"/i,
  ]));
}

function parseChannelProfileFromHtml(html, url, input = '') {
  const id = extractMatch(html, [
    /"externalId"\s*:\s*"(UC[\w-]+)"/i,
    /"channelId"\s*:\s*"(UC[\w-]+)"/i,
    /"browseId"\s*:\s*"(UC[\w-]+)"/i,
    /<meta\s+itemprop="identifier"\s+content="(UC[\w-]+)"/i,
  ]);
  const handle = cleanHandle(extractMatch(html, [
    /"canonicalBaseUrl"\s*:\s*"\/(@[\w.-]+)"/i,
    /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/(@[\w.-]+)"/i,
    /https:\/\/www\.youtube\.com\/(@[\w.-]+)/i,
  ]) || input);
  const name = cleanChannelName(extractMatch(html, [
    /<meta\s+itemprop="name"\s+content="([^"]+)"/i,
    /"channelMetadataRenderer"\s*:\s*\{[\s\S]*?"title":"([^"]+)"/i,
    /"title":"([^"]+)"/i,
  ]));
  const thumbnail = extractThumbnailFromHtml(html);
  const subscriberCount = extractSubscriberCountFromHtml(html);

  return normalizeChannel({
    id,
    handle,
    name: name || handle || '—',
    thumbnail,
    subscriberCount,
    url,
  });
}

function normalizeChannelInput(input = '') {
  const trimmed = normalizeText(input);
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(www\.)?youtube\.com\//i.test(trimmed)) return `https://${trimmed.replace(/^https?:\/\//i, '')}`;
  if (/^@[\w.-]+$/.test(trimmed)) return `https://www.youtube.com/${trimmed}`;
  if (/^UC[\w-]{20,}$/.test(trimmed)) return `https://www.youtube.com/channel/${trimmed}`;
  return '';
}

function sanitizeChannelUrl(inputUrl) {
  const url = new URL(inputUrl);
  url.hash = '';
  url.search = '';
  url.hostname = 'www.youtube.com';

  const path = url.pathname.replace(/\/+$/, '');
  if (/^\/@[\w.-]+(?:\/(videos|featured|streams|shorts|playlists|community|about))?$/i.test(path)) {
    const handle = path.match(/^\/(@[\w.-]+)/i)?.[1];
    url.pathname = handle || path;
    return url.toString();
  }
  if (/^\/channel\/UC[\w-]+(?:\/(videos|featured|streams|shorts|playlists|community|about))?$/i.test(path)) {
    const id = path.match(/^\/channel\/(UC[\w-]+)/i)?.[1];
    url.pathname = `/channel/${id}`;
    return url.toString();
  }

  return url.toString();
}

async function fetchChannelProfile(input) {
  const normalizedInput = normalizeChannelInput(input);
  if (!normalizedInput) throw new Error('Paste a YouTube channel URL, @handle, or channel ID.');

  const sanitizedUrl = sanitizeChannelUrl(normalizedInput);
  if (channelProfileCache.has(sanitizedUrl)) return channelProfileCache.get(sanitizedUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10 * 1000);
  let resp;
  let html;
  try {
    resp = await fetch(sanitizedUrl, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      credentials: 'include',
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Could not open channel page (${resp.status}).`);
    html = await resp.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Timed out opening the YouTube channel page.');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  const profile = parseChannelProfileFromHtml(html, resp.url || sanitizedUrl, input);
  if (!profile.id) throw new Error('Could not detect a valid YouTube channel from that link.');

  if (profile.handle && profile.id.startsWith('UC')) {
    resolveCache.set(profile.handle, profile.id);
    channelProfileCache.set(profile.handle, profile);
  }
  channelProfileCache.set(sanitizedUrl, profile);
  channelProfileCache.set(profile.id, profile);
  return profile;
}

/**
 * If `id` starts with '@', fetch the channel page and extract the UCxxxx ID
 * from the embedded page JSON.  Otherwise returns `id` unchanged.
 */
// Counts channel-page fetches performed while building the current feed, so
// diagnostics can show how much of the RSS stage was handle resolution.
// Reset at the start of buildFeed; concurrent builds share it, which is
// acceptable for a diagnostic counter.
let handleResolutionFetches = 0;

async function persistChannelResolution(handle, channelId) {
  if (!handle || !channelId || !String(channelId).startsWith('UC')) return;
  resolveCache.set(handle, channelId);
  try {
    const stored = (await storageGet(RESOLVED_CHANNEL_IDS_KEY)) ?? {};
    if (stored[handle] === channelId) return;
    await storageSet({ [RESOLVED_CHANNEL_IDS_KEY]: { ...stored, [handle]: channelId } });
  } catch (_) {
    // Persistence is a pure optimization; memory cache still applies.
  }
}

// ─── InnerTube (YouTube's own JSON API) ──────────────────────────────────────
// Measured 2026-10-12: watch/channel HTML pages are ~1.3MB with p50 3.6–4.7s
// and p95 9–12s; the equivalent InnerTube calls are ~7KB with p50 ~0.3s.
// Requests go out without cookies so no SAPISIDHASH auth header is needed.
// The client version is not validated strictly; HTML fetches remain as
// fallbacks if YouTube ever rejects it.
const INNERTUBE_CONTEXT = {
  client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' },
};
const INNERTUBE_TIMEOUT_MS = 5 * 1000;
const INNERTUBE_ATTEMPTS = 2;

// YouTube answers InnerTube calls carrying a chrome-extension:// Origin with
// 403 (verified 2026-10-12: same request is 200 with no Origin or with the
// youtube.com one). A session DNR rule rewrites Origin on this extension's
// own /youtubei/v1/ requests only; YouTube's pages are untouched because the
// rule matches this extension as initiator.
const INNERTUBE_ORIGIN_RULE_ID = 1;
let innertubeOriginRuleReady = null;

function ensureInnertubeOriginRule() {
  if (!innertubeOriginRuleReady) {
    innertubeOriginRuleReady = (async () => {
      const dnr = chrome.declarativeNetRequest;
      if (!dnr?.updateSessionRules) return;
      await dnr.updateSessionRules({
        removeRuleIds: [INNERTUBE_ORIGIN_RULE_ID],
        addRules: [{
          id: INNERTUBE_ORIGIN_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' }],
          },
          condition: {
            urlFilter: '||www.youtube.com/youtubei/v1/',
            initiatorDomains: [chrome.runtime.id],
            resourceTypes: ['xmlhttprequest'],
          },
        }],
      });
    })().catch((error) => {
      console.warn('[YT Curated] Could not install InnerTube origin rule', error?.message);
    });
  }
  return innertubeOriginRuleReady;
}

async function innertubePost(endpoint, body) {
  await ensureInnertubeOriginRule();
  let lastError = null;
  for (let attempt = 1; attempt <= INNERTUBE_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INNERTUBE_TIMEOUT_MS);
    try {
      const resp = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: INNERTUBE_CONTEXT, ...body }),
        credentials: 'omit',
        signal: controller.signal,
      });
      if (resp.ok) return JSON.parse(await resp.text());
      lastError = new Error(`InnerTube ${endpoint} failed with HTTP ${resp.status}.`);
      if (resp.status < 500 && resp.status !== 429) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError ?? new Error(`InnerTube ${endpoint} failed.`);
}

// Handle → UC ID through navigation/resolve_url. Legacy handles answer with
// a urlEndpoint redirect (e.g. /c/Name) instead of a browseId; follow those.
async function resolveHandleViaInnertube(handle) {
  let url = `https://www.youtube.com/${handle}`;
  for (let hop = 0; hop < 3; hop++) {
    const data = await innertubePost('navigation/resolve_url', { url });
    const browseId = data?.endpoint?.browseEndpoint?.browseId;
    if (typeof browseId === 'string' && browseId.startsWith('UC')) return browseId;
    const next = data?.endpoint?.urlEndpoint?.url;
    if (!next || next === url) break;
    url = next.startsWith('http') ? next : `https://www.youtube.com${next}`;
  }
  return null;
}

async function resolveChannelId(id) {
  if (!id.startsWith('@')) return id;
  if (resolveCache.has(id)) return resolveCache.get(id);

  try {
    const stored = (await storageGet(RESOLVED_CHANNEL_IDS_KEY)) ?? {};
    if (typeof stored[id] === 'string' && stored[id].startsWith('UC')) {
      resolveCache.set(id, stored[id]);
      return stored[id];
    }
  } catch (_) {
    // Fall through to a network resolution.
  }

  handleResolutionFetches++;
  try {
    const channelId = await resolveHandleViaInnertube(id);
    if (channelId) {
      await persistChannelResolution(id, channelId);
      return channelId;
    }
  } catch (_) {
    // Fall back to scraping the channel page below.
  }

  try {
    const profile = channelProfileCache.get(id) ?? await fetchChannelProfile(id);
    if (profile?.id) {
      await persistChannelResolution(id, profile.id);
      return profile.id;
    }
  } catch (e) {
    console.warn('[YT Curated] Could not resolve handle', id, e.message);
  }

  return id; // Return as-is on failure; RSS fetch will fail gracefully
}

// ─── RSS video fetching ───────────────────────────────────────────────────────
const RECENT_DAYS = 7;
const FEED_CONCURRENCY = 12;
const FEED_REQUEST_TIMEOUT_MS = 8 * 1000;
const FEED_REQUEST_ATTEMPTS = 4;
// Backoff between RSS attempts: exponential from this base, capped, with
// jitter so simultaneously failing channels stop retrying in lockstep.
// Measured throttle windows last minutes; this rides out short blips and
// fails fast-ish into cached results otherwise, instead of hammering.
const FEED_RETRY_BASE_MS = 1000;
const FEED_RETRY_CAP_MS = 10000;
const FEED_RETRY_JITTER_MS = 500;
// Never wait out a server-demanded pause longer than this inside one load;
// the load fails into cache and the user retries instead.
const RETRY_AFTER_CAP_MS = 10000;
// Strict (on-demand real) refresh: more attempts and roomier caps so a load
// caught inside a throttle window can wait it out instead of collapsing.
// Only the feed page's Refresh/retry buttons ask for this; normal loads
// keep the cheaper policy above.
const STRICT_FEED_REQUEST_ATTEMPTS = 8;
const STRICT_RETRY_CAP_MS = 30000;
const STRICT_RETRY_AFTER_CAP_MS = 60000;
const FEED_CACHE_KEY = 'channelFeedCacheV2';
const FEED_CACHE_FRESH_MS = 10 * 60 * 1000;
const FEED_CACHE_STALE_MS = (RECENT_DAYS + 1) * 24 * 60 * 60 * 1000;
const VIDEO_DURATION_CONCURRENCY = 10;
// Watch-page fallback only (primary path is InnerTube player). Those pages
// measured p50 3.6s / p95 8.8s, so 8s keeps most fallbacks from blanking.
const VIDEO_DURATION_TIMEOUT_MS = 8 * 1000;
// Persisted handle → UC ID resolutions. UC IDs are stable, so a handle
// resolves once ever instead of once per service-worker lifetime.
const RESOLVED_CHANNEL_IDS_KEY = 'resolvedChannelIds';
const channelFeedRequests = new Map();

function getRecentCutoffMs(referenceTime = Date.now()) {
  const cutoff = new Date(referenceTime);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - RECENT_DAYS);
  return cutoff.getTime();
}

function getElementsByLocalName(root, localName) {
  return Array.from(root.getElementsByTagNameNS('*', localName));
}

function getFirstByLocalName(root, localName) {
  return getElementsByLocalName(root, localName)[0] ?? null;
}

function getTextByLocalName(root, localName) {
  return getFirstByLocalName(root, localName)?.textContent?.trim() ?? '';
}

function getAttrByLocalName(root, localName, attrName) {
  return getFirstByLocalName(root, localName)?.getAttribute(attrName)?.trim() ?? '';
}

function escapeRegex(text = '') {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlText(text = '') {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function getXmlTagText(xmlChunk = '', tagNames = []) {
  for (const tagName of tagNames) {
    const pattern = new RegExp(
      `<${escapeRegex(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegex(tagName)}>`,
      'i'
    );
    const match = xmlChunk.match(pattern);
    if (match?.[1]) return decodeXmlText(match[1]);
  }

  return '';
}

function getXmlTagAttr(xmlChunk = '', tagNames = [], attrName = '') {
  for (const tagName of tagNames) {
    const pattern = new RegExp(
      `<${escapeRegex(tagName)}\\b[^>]*\\s${escapeRegex(attrName)}="([^"]+)"[^>]*>`,
      'i'
    );
    const match = xmlChunk.match(pattern);
    if (match?.[1]) return decodeXmlText(match[1]);
  }

  return '';
}

function classifyVideoType(url = '', title = '', description = '') {
  const normalizedUrl = String(url).toLowerCase();
  if (normalizedUrl.includes('/shorts/')) return 'shorts';

  const haystack = `${title}\n${description}`.toLowerCase();
  const liveMarkers = [
    'streamed live',
    'live stream',
    'livestream',
    'watch live',
    'live coverage',
    'live feed',
    'live news conference',
    'scheduled to start',
    'scheduled for',
    'premieres in',
    'premiere',
    'upcoming live',
  ];
  const liveTitle = /(^|[^a-z])(live|livestream|premiere|upcoming|scheduled)([^a-z]|$)/i.test(title);
  if (liveTitle || liveMarkers.some((marker) => haystack.includes(marker))) return 'live';

  return 'standard';
}

function getAlternateLinkUrl(entry) {
  const links = getElementsByLocalName(entry, 'link');
  return links.find((link) => (link.getAttribute('rel') || '').toLowerCase() === 'alternate')
    ?.getAttribute('href')
    ?.trim() ?? '';
}

function formatVideoDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds)));
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function extractVideoDurationFromHtml(html = '') {
  const normalizedHtml = String(html).replace(/\\u0026/g, '&');
  const matches = [
    normalizedHtml.match(/"lengthSeconds"\s*:\s*"(\d+)"/i),
    normalizedHtml.match(/"lengthSeconds"\s*:\s*(\d+)/i),
  ];

  for (const match of matches) {
    const duration = formatVideoDuration(match?.[1]);
    if (duration) return duration;
  }

  return '';
}

// InnerTube player first (~7KB). A response that carries videoDetails is
// authoritative even without a usable length (upcoming premieres/live report
// 0), so only a failed request falls back to the 1.3MB watch page.
async function fetchVideoDuration(videoId) {
  try {
    const data = await innertubePost('player', { videoId });
    if (data?.videoDetails) return formatVideoDuration(data.videoDetails.lengthSeconds);
  } catch (_) {
    // Fall through to the watch page.
  }
  return fetchVideoDurationFromWatchPage(videoId);
}

async function fetchVideoDurationFromWatchPage(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VIDEO_DURATION_TIMEOUT_MS);

  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const response = await fetch(url, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) return '';
    return extractVideoDurationFromHtml(await response.text());
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timeoutId);
  }
}

// One global cap shared by every in-flight per-channel hydration call. A
// plain per-call pool would let N simultaneously finishing channels open
// N × VIDEO_DURATION_CONCURRENCY watch-page fetches at once.
function createLimiter(maximum) {
  let active = 0;
  const waiters = [];
  function release() {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  }
  return {
    async acquire() {
      if (active >= maximum) await new Promise((resolve) => waiters.push(resolve));
      else active++;
      return release;
    },
  };
}

const hydrationLimiter = createLimiter(VIDEO_DURATION_CONCURRENCY);

// Same video requested by concurrent hydrations (a channel selected by both
// handle and UC ID, overlapping feed loads) shares one lookup.
const videoDurationRequests = new Map();

function fetchVideoDurationShared(videoId) {
  if (videoDurationRequests.has(videoId)) return videoDurationRequests.get(videoId);
  const request = (async () => {
    const release = await hydrationLimiter.acquire();
    try {
      return await fetchVideoDuration(videoId);
    } finally {
      release();
    }
  })().finally(() => videoDurationRequests.delete(videoId));
  videoDurationRequests.set(videoId, request);
  return request;
}

async function hydrateVideoDurations(videos = [], visibleTypes = null) {
  const missing = [];
  const seen = new Set();
  let skipped = 0;

  for (const video of videos) {
    if (video?.duration || !video?.id || seen.has(video.id)) continue;
    seen.add(video.id);
    // When the caller passes ticked type filters, videos of unticked types
    // keep their parsed fields but skip the watch-page duration fetch. They
    // stay in the response so render-side filtering keeps working.
    if (visibleTypes && !visibleTypes[video.videoType || 'standard']) {
      skipped++;
      continue;
    }
    missing.push(video);
  }

  if (!missing.length) return { videos, requested: 0, skipped };

  const durations = new Map();
  await Promise.all(missing.map(async (video) => {
    const duration = await fetchVideoDurationShared(video.id);
    if (duration) durations.set(video.id, duration);
  }));

  return {
    videos: videos.map((video) => {
      const duration = durations.get(video.id);
      return duration ? { ...video, duration } : video;
    }),
    requested: missing.length,
    skipped,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryFeedStatus(status) {
  // 404 is retryable: measured throttle windows serve error pages including
  // 404s for live channels, so a lone 404 proves nothing. Dead channels
  // answer fast, so retrying them costs little.
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

// Milliseconds the server asked us to wait via Retry-After (seconds or an
// HTTP date), or null when absent/unparseable. Never trusted blindly: the
// caller caps it, since one channel must not stall a whole load.
function getRetryAfterMs(resp) {
  let raw = null;
  try {
    raw = resp?.headers?.get?.('retry-after') ?? null;
  } catch (_) {
    return null;
  }
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const when = new Date(raw).getTime();
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

function retryDelayMs(attempt, retryAfterMs, caps = {}) {
  const retryAfterCap = caps.retryAfterCapMs ?? RETRY_AFTER_CAP_MS;
  const backoffCap = caps.backoffCapMs ?? FEED_RETRY_CAP_MS;
  if (retryAfterMs != null) return Math.min(retryAfterMs, retryAfterCap);
  const backoff = Math.min(backoffCap, FEED_RETRY_BASE_MS * (2 ** (attempt - 1)));
  return backoff + Math.floor(Math.random() * FEED_RETRY_JITTER_MS);
}

function makeFeedRequestError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

async function fetchFeedXmlWithRetry(rssUrl, channelId, retryOptions = {}) {
  const maxAttempts = retryOptions.maxAttempts ?? FEED_REQUEST_ATTEMPTS;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FEED_REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(rssUrl, {
        headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
        signal: controller.signal,
      });

      if (resp.ok) {
        const xml = await resp.text();
        if (!/<feed\b/i.test(xml)) {
          throw makeFeedRequestError('YouTube returned an invalid RSS document.', {
            channelId,
            attempts: attempt,
            retryable: true,
            stage: 'parse',
          });
        }
        return { xml, attempts: attempt };
      }

      lastError = makeFeedRequestError(`RSS request failed with HTTP ${resp.status}.`, {
        channelId,
        attempts: attempt,
        httpStatus: resp.status,
        retryable: shouldRetryFeedStatus(resp.status),
        retryAfterMs: getRetryAfterMs(resp),
        stage: 'request',
      });
    } catch (error) {
      if (error?.stage === 'parse') {
        lastError = error;
      } else {
        const timedOut = error?.name === 'AbortError';
        lastError = makeFeedRequestError(
          timedOut ? `RSS request timed out after ${FEED_REQUEST_TIMEOUT_MS / 1000}s.` : `RSS network error: ${error?.message || 'unknown error'}`,
          {
            channelId,
            attempts: attempt,
            retryable: true,
            stage: timedOut ? 'timeout' : 'network',
          }
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!lastError?.retryable || attempt >= maxAttempts) break;
    await sleep(retryDelayMs(attempt, lastError?.retryAfterMs ?? null, retryOptions));
  }

  throw lastError ?? makeFeedRequestError('RSS request failed.', { channelId, attempts: 0 });
}

function parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs) {
  const feedAuthorChunk = xml.match(/<author\b[\s\S]*?<\/author>/i)?.[0] ?? '';
  const feedChannelName = cleanChannelName(
    getXmlTagText(feedAuthorChunk, ['name'])
    || getXmlTagText(xml, ['title'])
    || normalizedMeta.name
    || ''
  );
  const feedChannelThumb = normalizedMeta.thumbnail || '';
  const channelSubscriberCount = normalizedMeta.subscriberCount || '';
  const channelSubscriberCountNum = parseCountText(channelSubscriberCount);
  const entries = Array.from(xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi));
  const videos = [];

  for (const match of entries) {
    const entryXml = match[0];
    const publishedStr = getXmlTagText(entryXml, ['published']);
    const publishedAt = publishedStr ? new Date(publishedStr).getTime() : null;

    if (!publishedAt || Number.isNaN(publishedAt) || publishedAt < cutoffMs) continue;

    const videoId = getXmlTagText(entryXml, ['yt:videoId', 'videoId']);
    if (!videoId) continue;

    const entryAuthorChunk = entryXml.match(/<author\b[\s\S]*?<\/author>/i)?.[0] ?? '';
    const title = getXmlTagText(entryXml, ['title', 'media:title']) || 'Untitled';
    const thumbnail = getXmlTagAttr(entryXml, ['media:thumbnail', 'thumbnail'], 'url')
      || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const viewCount = getXmlTagAttr(entryXml, ['media:statistics', 'statistics'], 'views');
    const description = getXmlTagText(entryXml, ['media:description', 'description']);
    const alternateUrl = getXmlTagAttr(entryXml, ['link'], 'href') || `https://www.youtube.com/watch?v=${videoId}`;
    const channelName = cleanChannelName(
      normalizedMeta.name
      || getXmlTagText(entryAuthorChunk, ['name'])
      || feedChannelName
      || ''
    );
    const ageMs = now - publishedAt;
    const videoType = classifyVideoType(alternateUrl, title, description);

    videos.push({
      id:               videoId,
      title,
      thumbnail,
      channelId:        resolvedId,
      channelName,
      channelThumbnail: feedChannelThumb,
      channelSubscriberCount,
      channelSubscriberCountNum,
      duration:         '',
      publishedText:    formatRelativeTime(ageMs),
      publishedAt,
      viewCount:        viewCount ? formatViewCount(viewCount) : '',
      viewCountNum:     parseCountText(viewCount),
      url:              alternateUrl,
      videoType,
      ageSortKey:       ageMs,
    });
  }

  return videos;
}

// "Videos" tab of a channel, for InnerTube's browse endpoint.
const CHANNEL_VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';
const RELATIVE_TIME_UNITS_MS = {
  second: 1000, minute: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000, year: 365 * 24 * 60 * 60 * 1000,
};

// "12 hours ago", "Streamed 2 days ago" → milliseconds, or null.
function parseRelativeTimeMs(text = '') {
  const match = String(text).match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  return match ? Number(match[1]) * RELATIVE_TIME_UNITS_MS[match[2].toLowerCase()] : null;
}

function findChannelVideoItems(data) {
  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
  const tab = tabs.find((entry) => entry?.tabRenderer?.selected) ?? tabs.find((entry) => entry?.tabRenderer?.content?.richGridRenderer);
  return tab?.tabRenderer?.content?.richGridRenderer?.contents ?? [];
}

// One grid item (new lockupViewModel or older videoRenderer) → plain fields.
function readChannelVideoItem(item) {
  const content = item?.richItemRenderer?.content ?? {};
  const lockup = content.lockupViewModel;
  if (lockup) {
    if (lockup.contentType && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
    const parts = (lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows ?? [])
      .flatMap((row) => row.metadataParts ?? [])
      .map((part) => part?.text?.content ?? '');
    const badges = (lockup.contentImage?.thumbnailViewModel?.overlays ?? [])
      .flatMap((overlay) => overlay?.thumbnailBottomOverlayViewModel?.badges ?? overlay?.thumbnailOverlayBadgeViewModel?.thumbnailBadges ?? [])
      .map((badge) => badge?.thumbnailBadgeViewModel?.text ?? '');
    return {
      id: lockup.contentId,
      title: lockup.metadata?.lockupMetadataViewModel?.title?.content ?? '',
      viewText: parts.find((part) => /\bviews?\b|\bwatching\b/i.test(part)) ?? '',
      timeText: parts.find((part) => /\bago\b/i.test(part)) ?? '',
      duration: badges.find((text) => /^\d+(?::\d{2}){1,2}$/.test(text)) ?? '',
    };
  }
  const renderer = content.videoRenderer;
  if (renderer) {
    return {
      id: renderer.videoId,
      title: renderer.title?.runs?.[0]?.text ?? renderer.title?.simpleText ?? '',
      viewText: renderer.viewCountText?.simpleText ?? '',
      timeText: renderer.publishedTimeText?.simpleText ?? '',
      duration: renderer.lengthText?.simpleText ?? '',
    };
  }
  return null;
}

/**
 * Fallback for when the RSS endpoint fails: the channel's Videos tab through
 * InnerTube's browse endpoint. Measured 2026-10-13: RSS answered 404/500 to
 * ~60% of requests for live channels while browse answered every time.
 * Publish times are relative ("2 days ago"), so they are approximate; the tab
 * holds regular uploads only (no Shorts or streams).
 */
async function fetchChannelViaInnertube(resolvedId, normalizedMeta) {
  const data = await innertubePost('browse', { browseId: resolvedId, params: CHANNEL_VIDEOS_TAB_PARAMS });
  const channel = data?.metadata?.channelMetadataRenderer ?? {};
  const channelName = normalizedMeta.name || cleanChannelName(channel.title || '');
  const channelThumbnail = normalizedMeta.thumbnail || normalizeThumbnailUrl(channel.avatar?.thumbnails?.[0]?.url || '');
  const channelSubscriberCount = normalizedMeta.subscriberCount || '';
  const now = Date.now();
  const cutoffMs = getRecentCutoffMs(now);
  const items = findChannelVideoItems(data);
  if (!items.length) {
    throw makeFeedRequestError('YouTube returned no videos tab for this channel.', { channelId: resolvedId, stage: 'innertube' });
  }

  const videos = [];
  for (const entry of items.map(readChannelVideoItem)) {
    if (!entry?.id) continue;
    const ageMs = parseRelativeTimeMs(entry.timeText);
    if (ageMs == null) continue;
    const publishedAt = now - ageMs;
    if (publishedAt < cutoffMs) continue;
    const url = `https://www.youtube.com/watch?v=${entry.id}`;
    const viewNumber = parseCountText(entry.viewText);
    videos.push({
      id:               entry.id,
      title:            entry.title || 'Untitled',
      thumbnail:        `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
      channelId:        resolvedId,
      channelName,
      channelThumbnail,
      channelSubscriberCount,
      channelSubscriberCountNum: parseCountText(channelSubscriberCount),
      duration:         entry.duration,
      publishedText:    formatRelativeTime(ageMs),
      publishedAt,
      publishedApprox:  true,
      viewCount:        entry.viewText ? formatViewCount(String(viewNumber)) : '',
      viewCountNum:     viewNumber,
      url,
      videoType:        classifyVideoType(url, entry.title, ''),
      ageSortKey:       ageMs,
    });
  }
  return videos;
}

// RSS first (exact timestamps, includes Shorts); after RSS_ATTEMPTS_BEFORE_FALLBACK
// failures, InnerTube; if that fails too, the rest of the RSS retry ladder.
const RSS_ATTEMPTS_BEFORE_FALLBACK = 2;

async function fetchChannelFeedXmlOrFallback(rssUrl, resolvedId, normalizedMeta, rssOptions = {}) {
  const maxAttempts = rssOptions.maxAttempts ?? FEED_REQUEST_ATTEMPTS;
  const firstAttempts = Math.min(maxAttempts, RSS_ATTEMPTS_BEFORE_FALLBACK);
  let rssError;
  try {
    return await fetchFeedXmlWithRetry(rssUrl, resolvedId, { ...rssOptions, maxAttempts: firstAttempts });
  } catch (error) {
    rssError = error;
  }
  try {
    const videos = await fetchChannelViaInnertube(resolvedId, normalizedMeta);
    return { videos, attempts: firstAttempts + 1, via: 'innertube' };
  } catch (_) {
    // Fall back to the remaining RSS attempts.
  }
  if (maxAttempts <= firstAttempts) throw rssError;
  const rest = await fetchFeedXmlWithRetry(rssUrl, resolvedId, { ...rssOptions, maxAttempts: maxAttempts - firstAttempts });
  return { ...rest, attempts: rest.attempts + firstAttempts + 1 };
}

/**
 * Fetch the Atom RSS feed for one channel and return videos posted
 * within the past 7 days.
 *
 * YouTube's public feed endpoint (no auth required):
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx
 *
 * Returns last 15 public uploads with ISO-8601 publish timestamps.
 */
async function fetchChannelRSS(channelId, channelMeta = {}, rssOptions = {}) {
  const resolvedId = await resolveChannelId(channelId);
  const normalizedMeta = normalizeChannelsMeta({
    [resolvedId]: {
      ...channelMeta,
      handle: channelId.startsWith('@') ? channelId : channelMeta.handle,
    },
  })[resolvedId] ?? normalizeChannel(channelMeta);

  if (!resolvedId.startsWith('UC')) {
    throw makeFeedRequestError('Could not resolve this channel to a canonical YouTube ID.', {
      channelId,
      resolvedId,
      attempts: 0,
      retryable: false,
      stage: 'resolve',
    });
  }

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${resolvedId}`;
  const fetched = await fetchChannelFeedXmlOrFallback(rssUrl, resolvedId, normalizedMeta, rssOptions);
  if (fetched.via === 'innertube') {
    return { requestedId: channelId, resolvedId, attempts: fetched.attempts, videos: fetched.videos, via: 'innertube' };
  }
  const { xml, attempts } = fetched;

  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch (e) {
    const now = Date.now();
    const cutoffMs = getRecentCutoffMs(now);
    return {
      requestedId: channelId,
      resolvedId,
      attempts,
      videos: parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs),
    };
  }
  if (doc.querySelector('parsererror')) {
    const now = Date.now();
    const cutoffMs = getRecentCutoffMs(now);
    return {
      requestedId: channelId,
      resolvedId,
      attempts,
      videos: parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs),
    };
  }

  const author = getFirstByLocalName(doc, 'author');
  const feedChannelName  = cleanChannelName(
    getTextByLocalName(author ?? doc, 'name')
    || getTextByLocalName(doc, 'title')
    || normalizedMeta.name || ''
  );
  const feedChannelThumb = normalizedMeta.thumbnail || '';
  const channelSubscriberCount = normalizedMeta.subscriberCount || '';
  const channelSubscriberCountNum = parseCountText(channelSubscriberCount);

  const now     = Date.now();
  const cutoffMs = getRecentCutoffMs(now);
  const entries = getElementsByLocalName(doc, 'entry');
  const videos  = [];

  for (const entry of entries) {
    const publishedStr = getTextByLocalName(entry, 'published');
    const publishedAt  = publishedStr ? new Date(publishedStr).getTime() : null;

    // The feed is usually newest-first, but continue scanning to avoid
    // missing recent uploads if YouTube ever returns an out-of-order entry.
    if (publishedAt && publishedAt < cutoffMs) continue;
    if (!publishedAt || isNaN(publishedAt)) continue;

    const videoId = getTextByLocalName(entry, 'videoId');
    if (!videoId) continue;

    const title      = getTextByLocalName(entry, 'title') || 'Untitled';
    const mediaGroup = getFirstByLocalName(entry, 'group');
    const thumbnail  = getAttrByLocalName(mediaGroup ?? entry, 'thumbnail', 'url')
      || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
    const viewCount  = getAttrByLocalName(mediaGroup ?? entry, 'statistics', 'views');
    const description = getTextByLocalName(mediaGroup ?? entry, 'description');
    const alternateUrl = getAlternateLinkUrl(entry) || `https://www.youtube.com/watch?v=${videoId}`;

    const ageMs = now - publishedAt;
    const videoType = classifyVideoType(alternateUrl, title, description);

    videos.push({
      id:               videoId,
      title,
      thumbnail,
      channelId:        resolvedId,
      channelName:      normalizedMeta.name || feedChannelName,
      channelThumbnail: feedChannelThumb,
      channelSubscriberCount,
      channelSubscriberCountNum,
      duration:         '',
      publishedText:    formatRelativeTime(ageMs),
      publishedAt,
      viewCount:        viewCount ? formatViewCount(viewCount) : '',
      viewCountNum:     parseCountText(viewCount),
      url:              alternateUrl,
      videoType,
      ageSortKey:       ageMs,
    });
  }

  if (!videos.length && /<entry\b/i.test(xml)) {
    return {
      requestedId: channelId,
      resolvedId,
      attempts,
      videos: parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs),
    };
  }

  return { requestedId: channelId, resolvedId, attempts, videos };
}

function formatRelativeTime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m} minute${m !== 1 ? 's' : ''} ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h} hour${h !== 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d} day${d !== 1 ? 's' : ''} ago`;
  const w = Math.floor(d / 7);
  return `${w} week${w !== 1 ? 's' : ''} ago`;
}

function formatViewCount(raw) {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return '';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M views';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K views';
  return n + ' views';
}

function refreshCachedVideos(videos = [], referenceTime = Date.now(), channelMeta = {}) {
  const cutoffMs = getRecentCutoffMs(referenceTime);
  const normalizedMeta = normalizeChannelsMeta({ cached: channelMeta }).cached ?? {};
  return videos
    .filter((video) => Number(video?.publishedAt) >= cutoffMs)
    .map((video) => {
      const publishedAt = Number(video.publishedAt);
      const ageMs = referenceTime - publishedAt;
      return {
        ...video,
        publishedAt,
        publishedText: formatRelativeTime(ageMs),
        ageSortKey: ageMs,
        channelName: normalizedMeta.name || video.channelName,
        channelThumbnail: normalizedMeta.thumbnail || video.channelThumbnail,
        channelSubscriberCount: normalizedMeta.subscriberCount || video.channelSubscriberCount,
        channelSubscriberCountNum: parseCountText(normalizedMeta.subscriberCount || video.channelSubscriberCount),
      };
    });
}

// Buckets a terminal channel failure for diagnostics. Read one failing
// load's breakdown and the cause reads itself: rateLimited/serverError =
// YouTube pushing back, timeout/network = the pipe, other = dead or
// unparseable channels.
function classifyFailureReason(error = {}) {
  if (error.httpStatus === 429) return 'rateLimited';
  if (Number(error.httpStatus) >= 500 || error.httpStatus === 408 || error.httpStatus === 425) return 'serverError';
  if (error.stage === 'timeout') return 'timeout';
  if (error.stage === 'network') return 'network';
  return 'other';
}

function emptyFailureBreakdown() {
  return { rateLimited: 0, serverError: 0, timeout: 0, network: 0, other: 0 };
}

function describeFeedError(error, requestedId, channelsMeta = {}) {
  return {
    channelId: requestedId,
    channelName: channelsMeta[requestedId]?.name || channelsMeta[requestedId]?.handle || requestedId,
    message: error?.message || 'Unknown channel fetch failure.',
    stage: error?.stage || 'unknown',
    httpStatus: error?.httpStatus ?? null,
    attempts: error?.attempts ?? 0,
  };
}

function fetchChannelRSSShared(channelId, channelMeta = {}, rssOptions = {}) {
  if (channelFeedRequests.has(channelId)) return channelFeedRequests.get(channelId);

  const request = fetchChannelRSS(channelId, channelMeta, rssOptions).finally(() => {
    channelFeedRequests.delete(channelId);
  });
  channelFeedRequests.set(channelId, request);
  return request;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

// Normalizes the ticked type filters a feed UI sends with GET_FEED. Returns
// null when the caller sent none, meaning every type hydrates (previous
// behavior, kept for backward compatibility).
function normalizeFeedTypeFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return null;
  return {
    standard: Boolean(filters.standard),
    shorts: Boolean(filters.shorts),
    live: Boolean(filters.live),
    other: Boolean(filters.other),
  };
}

async function buildFeed(channelIds, channelsMeta = {}, options = {}) {
  const requestedIds = Array.from(new Set((channelIds ?? []).filter(Boolean)));
  if (!requestedIds.length) {
    return {
      videos: [],
      feedStatus: {
        requestedChannels: 0,
        fetchedChannels: 0,
        successfulChannels: 0,
        cachedChannels: 0,
        staleChannels: 0,
        failedChannels: 0,
        issues: [],
      },
      feedDiagnostics: {
        rssMs: 0,
        hydrationMs: 0,
        hydrationRequested: 0,
        hydrationSkipped: 0,
        handleResolutions: 0,
        failureBreakdown: emptyFailureBreakdown(),
      },
    };
  }

  const referenceTime = Date.now();
  // Strict (on-demand real) refresh: implies force, refuses stale fallback,
  // and retries on an extended ladder. Only the feed page's Refresh/retry
  // buttons ask for it.
  const strict = Boolean(options.strict);
  const forceRefresh = Boolean(options.forceRefresh || strict);
  const visibleTypes = normalizeFeedTypeFilters(options.videoTypeFilters);
  const rssOptions = strict
    ? {
        maxAttempts: STRICT_FEED_REQUEST_ATTEMPTS,
        backoffCapMs: STRICT_RETRY_CAP_MS,
        retryAfterCapMs: STRICT_RETRY_AFTER_CAP_MS,
      }
    : {};
  const storedCache = (await storageGet(FEED_CACHE_KEY)) ?? {};
  const cacheUpdates = {};

  // Each channel hydrates its own videos the moment its feed lands, instead
  // of waiting for every channel first. Duration lookups share one global
  // cap (see hydrationLimiter), so early finishers cannot open more than
  // VIDEO_DURATION_CONCURRENCY watch-page fetches between them.
  handleResolutionFetches = 0;
  const failureBreakdown = emptyFailureBreakdown();
  let hydrationRequested = 0;
  let hydrationSkipped = 0;
  let lastRssCompleteMs = referenceTime;
  let hydrationStageStarted = 0;
  let hydrationStageEnded = 0;

  async function fetchOneChannelFeed(id) {
    const cacheEntry = storedCache[id];
    const cacheAge = referenceTime - Number(cacheEntry?.fetchedAt || 0);

    if (!forceRefresh && cacheEntry && cacheAge >= 0 && cacheAge < FEED_CACHE_FRESH_MS) {
      return {
        requestedId: id,
        resolvedId: cacheEntry.resolvedId || id,
        videos: refreshCachedVideos(cacheEntry.videos, referenceTime, channelsMeta[id] ?? {}),
        source: 'cache',
      };
    }

    try {
      const fetched = await fetchChannelRSSShared(id, channelsMeta[id] ?? {}, rssOptions);
      // Durations never change; carry them over from the previous fetch so a
      // 10-minute cache expiry does not re-hydrate every video again.
      const knownDurations = new Map((cacheEntry?.videos ?? [])
        .filter((video) => video?.id && video.duration)
        .map((video) => [video.id, video.duration]));
      if (knownDurations.size) {
        fetched.videos = fetched.videos.map((video) => (
          !video.duration && knownDurations.has(video.id)
            ? { ...video, duration: knownDurations.get(video.id) }
            : video
        ));
      }
      cacheUpdates[id] = {
        fetchedAt: referenceTime,
        resolvedId: fetched.resolvedId,
        videos: fetched.videos,
      };
      return { ...fetched, source: 'network' };
    } catch (error) {
      const issue = describeFeedError(error, id, channelsMeta);
      failureBreakdown[classifyFailureReason(error)]++;
      // Strict refresh never serves stale cache: a failed channel is
      // reported, not papered over with old videos.
      if (!strict && cacheEntry && cacheAge >= 0 && cacheAge < FEED_CACHE_STALE_MS) {
        return {
          requestedId: id,
          resolvedId: cacheEntry.resolvedId || id,
          videos: refreshCachedVideos(cacheEntry.videos, referenceTime, channelsMeta[id] ?? {}),
          source: 'stale-cache',
          issue,
        };
      }
      return { requestedId: id, resolvedId: id, videos: [], source: 'failed', issue };
    }
  }

  // Hydration is started per channel but not awaited inside the RSS worker,
  // so slow duration lookups never hold one of the FEED_CONCURRENCY slots
  // that later channels' RSS requests are waiting on.
  const hydrations = [];
  const results = await runWithConcurrency(requestedIds, FEED_CONCURRENCY, async (id) => {
    const result = await fetchOneChannelFeed(id);
    lastRssCompleteMs = Math.max(lastRssCompleteMs, Date.now());
    if (result.videos.length) hydrations.push(hydrateChannelResult(result));
    return result;
  });
  await Promise.all(hydrations);

  async function hydrateChannelResult(result) {

    if (!hydrationStageStarted) hydrationStageStarted = Date.now();
    const hydration = await hydrateVideoDurations(result.videos, visibleTypes);
    hydrationStageEnded = Date.now();
    hydrationRequested += hydration.requested;
    hydrationSkipped += hydration.skipped;

    const hydratedById = new Map(hydration.videos.map((video) => [video.id, video]));
    let changed = false;
    result.videos = result.videos.map((video) => {
      const hydrated = hydratedById.get(video.id);
      if (hydrated?.duration && hydrated.duration !== video.duration) {
        changed = true;
        return hydrated;
      }
      return video;
    });

    if (changed && result.source !== 'failed') {
      const cachedFetchedAt = Number(storedCache[result.requestedId]?.fetchedAt || 0);
      cacheUpdates[result.requestedId] = {
        fetchedAt: result.source === 'network' ? referenceTime : cachedFetchedAt || referenceTime,
        resolvedId: result.resolvedId,
        videos: result.videos,
      };
    }
  }

  const rssMs = lastRssCompleteMs - referenceTime;
  const hydrationMs = hydrationStageStarted
    ? Math.max(0, hydrationStageEnded - hydrationStageStarted)
    : 0;

  if (Object.keys(cacheUpdates).length) {
    const latestCache = (await storageGet(FEED_CACHE_KEY)) ?? {};
    const nextCache = { ...latestCache, ...cacheUpdates };
    const oldestAllowed = referenceTime - FEED_CACHE_STALE_MS;
    for (const [id, entry] of Object.entries(nextCache)) {
      if (Number(entry?.fetchedAt || 0) < oldestAllowed) delete nextCache[id];
    }
    await storageSet({ [FEED_CACHE_KEY]: nextCache });
  }

  const byVideoId = new Map();
  for (const result of results) {
    for (const video of result.videos) {
      if (!byVideoId.has(video.id)) byVideoId.set(video.id, video);
    }
  }
  const videos = [...byVideoId.values()].sort((a, b) => a.ageSortKey - b.ageSortKey);
  const issues = results.filter((result) => result.issue).map((result) => ({
    ...result.issue,
    usingStaleCache: result.source === 'stale-cache',
  }));

  return {
    videos,
    feedStatus: {
      requestedChannels: requestedIds.length,
      fetchedChannels: results.filter((result) => result.source === 'network').length,
      successfulChannels: results.filter((result) => result.source === 'network' || result.source === 'cache').length,
      cachedChannels: results.filter((result) => result.source === 'cache').length,
      staleChannels: results.filter((result) => result.source === 'stale-cache').length,
      failedChannels: results.filter((result) => result.source === 'failed').length,
      issues,
    },
    feedDiagnostics: {
      rssMs,
      hydrationMs,
      hydrationRequested,
      hydrationSkipped,
      handleResolutions: handleResolutionFetches,
      failureBreakdown,
      strict,
    },
  };
}

// ─── Transactional scrape state ──────────────────────────────────────────────
// Progress is written to temporary keys. Only CHANNELS_READY replaces the
// official channel cache, so an interrupted scrape cannot leave a partial list.
let scrapeStorageQueue = Promise.resolve();

function queueScrapeStorage(task) {
  scrapeStorageQueue = scrapeStorageQueue.then(task, task);
  return scrapeStorageQueue;
}

function channelMetaFromList(channels = []) {
  const meta = {};
  for (const channel of channels) {
    if (!channel.id) continue;
    meta[channel.id] = {
      name: channel.name,
      thumbnail: channel.thumbnail,
      subscriberCount: channel.subscriberCount,
      handle: channel.handle,
    };
  }
  return meta;
}

function reconcileSelectedHandles(scrapedChannels, selectedIds, selectedMeta) {
  const nextIds = [];
  const nextMeta = {};
  let changed = false;

  for (const selectedId of selectedIds) {
    let targetId = selectedId;
    let scrapedMatch = null;
    if (String(selectedId).startsWith('@')) {
      const normalizedHandle = cleanHandle(selectedId).toLowerCase();
      scrapedMatch = scrapedChannels.find((channel) =>
        channel.id.startsWith('UC')
        && cleanHandle(channel.handle).toLowerCase() === normalizedHandle
      ) ?? null;
      if (scrapedMatch) {
        targetId = scrapedMatch.id;
        changed = true;
      }
    }

    if (!nextIds.includes(targetId)) nextIds.push(targetId);
    const previous = selectedMeta[selectedId] ?? selectedMeta[targetId] ?? {};
    nextMeta[targetId] = {
      name: scrapedMatch?.name || previous.name || '',
      thumbnail: scrapedMatch?.thumbnail || previous.thumbnail || '',
      subscriberCount: scrapedMatch?.subscriberCount || previous.subscriberCount || '',
      handle: scrapedMatch?.handle || previous.handle || (String(selectedId).startsWith('@') ? selectedId : ''),
    };
  }

  return { selectedIds: nextIds, selectedMeta: normalizeChannelsMeta(nextMeta), changed };
}

async function commitScrapedChannels(scrapedChannels = []) {
  const scraped = normalizeChannels(scrapedChannels);
  if (!scraped.length) throw new Error('YouTube did not return any subscriptions. The previous list was kept.');

  const storedSelectedIds = ((await storageGet('selectedChannelIds')) ?? []).filter(Boolean);
  const storedSelectedMeta = normalizeChannelsMeta((await storageGet('selectedChannelsMeta')) ?? {});
  const reconciledSelection = reconcileSelectedHandles(scraped, storedSelectedIds, storedSelectedMeta);
  const selectedIds = reconciledSelection.selectedIds;
  const selectedMeta = reconciledSelection.selectedMeta;
  const manualIds = new Set((await storageGet('manuallyAddedChannelIds')) ?? []);
  const existing = normalizeChannels((await storageGet('allChannels')) ?? []);

  let channels = mergeSelectedIntoChannels(scraped, selectedIds, selectedMeta);
  const knownIds = new Set(channels.map((channel) => channel.id));
  for (const channel of existing) {
    if (!manualIds.has(channel.id) || knownIds.has(channel.id)) continue;
    channels.push(channel);
    knownIds.add(channel.id);
  }

  const allChannelsMeta = channelMetaFromList(channels);
  await storageSet({
    allChannels: channels,
    allChannelsMeta,
    channelsLoadedAt: Date.now(),
    scrapeInProgress: false,
    scrapeStartedAt: 0,
    scrapeProgressCount: channels.length,
    scrapeChannelsProgress: [],
    scrapeError: '',
    ...(reconciledSelection.changed ? {
      selectedChannelIds: selectedIds,
      selectedChannelsMeta: selectedMeta,
    } : {}),
  });

  try {
    chrome.runtime.sendMessage({ type: 'CHANNELS_CACHE_UPDATED', channels });
  } catch (_) {}

  setTimeout(() => { void closeScrapeTabIfNeeded(); }, 500);
  void hydrateCachedChannelsInBackground();
  return channels;
}

async function failScrape(message) {
  const error = normalizeText(message) || 'Could not finish loading subscriptions.';
  await storageSet({
    scrapeInProgress: false,
    scrapeStartedAt: 0,
    scrapeProgressCount: 0,
    scrapeChannelsProgress: [],
    scrapeError: error,
  });
  setTimeout(() => { void closeScrapeTabIfNeeded(); }, 500);
}

async function getScrapeStatus() {
  let inProgress = Boolean((await storageGet('scrapeInProgress')) ?? false);
  const startedAt = (await storageGet('scrapeStartedAt')) ?? 0;
  let error = normalizeText((await storageGet('scrapeError')) ?? '');

  if (inProgress && startedAt && (Date.now() - startedAt) > SCRAPE_TIMEOUT_MS) {
    error = 'Timed out waiting for YouTube to finish loading subscriptions. The previous list was kept.';
    await failScrape(error);
    inProgress = false;
  }

  if (inProgress && !(await findOpenScrapeTab())) {
    error = 'Subscription refresh stopped because the YouTube channels tab was closed. The previous list was kept.';
    await failScrape(error);
    inProgress = false;
  }

  const progressCount = (await storageGet('scrapeProgressCount')) ?? 0;
  return { inProgress, startedAt: inProgress ? startedAt : 0, progressCount, error };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const trackedTabId = scrapeTabId ?? await storageGet('scrapeTabId');
    if (tabId !== trackedTabId) return;

    scrapeTabId = null;
    scrapeTabCreatedByExtension = false;
    await storageSet({ scrapeTabId: null, scrapeTabCreatedByExtension: false });

    const inProgress = Boolean((await storageGet('scrapeInProgress')) ?? false);
    if (inProgress) {
      await failScrape('Subscription refresh stopped because the YouTube channels tab was closed. The previous list was kept.');
    }
  })();
});

// ─── Message handler ──────────────────────────────────────────────────────────
// First install: open the welcome page. Unpacked reloads report 'update',
// so developers are not sent to it on every reload.
chrome.runtime.onInstalled?.addListener?.((details) => {
  if (details?.reason !== 'install') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') }).catch?.(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── From channels-scraper content script ──
  if (msg.type === 'CHANNELS_READY' || msg.type === 'CHANNELS_PROGRESS' || msg.type === 'CHANNELS_FAILED') {
    queueScrapeStorage(async () => {
      const inProgress = Boolean((await storageGet('scrapeInProgress')) ?? false);
      if (!inProgress) return { ignored: true };

      if (sender?.tab?.id != null) scrapeTabId = sender.tab.id;

      if (msg.type === 'CHANNELS_PROGRESS') {
        const channels = normalizeChannels(msg.channels ?? []);
        await storageSet({
          scrapeChannelsProgress: channels,
          scrapeProgressCount: channels.length,
        });
        return { ok: true };
      }

      if (msg.type === 'CHANNELS_FAILED') {
        await failScrape(msg.error);
        return { ok: false };
      }

      const channels = await commitScrapedChannels(msg.channels ?? []);
      return { ok: true, count: channels.length };
    }).then(sendResponse).catch(async (error) => {
      await failScrape(error?.message);
      sendResponse({ error: error?.message || 'Could not save subscriptions.' });
    });
    return true;
  }

  // ── From popup / feed page / homepage content script ──
  (async () => {
    try {
      switch (msg.type) {

        case 'OPEN_CHANNELS_PAGE': {
          const tabId = await openChannelsTab();
          return { tabId };
        }

        case 'GET_CHANNELS': {
          const channels = normalizeChannels((await storageGet('allChannels')) ?? []);
          const loadedAt  = (await storageGet('channelsLoadedAt')) ?? 0;
          if (loadedAt && channels.some((channel) => !channel.thumbnail) && !channelHydrationPromise) {
            void hydrateCachedChannelsInBackground();
          }
          return { channels, loadedAt };
        }

        case 'GET_SCRAPE_STATUS': {
          return await getScrapeStatus();
        }

        case 'GET_PREFERENCES': {
          const preferences = await getPreferences();
          return { preferences };
        }

        case 'SAVE_PREFERENCES': {
          const preferences = await savePreferences(msg.preferences ?? {});
          return { preferences };
        }

        case 'GET_OPENED_VIDEOS': {
          return { videoIds: await getOpenedVideoIds() };
        }

        case 'MARK_VIDEO_OPENED': {
          await markVideoOpened(msg.videoId);
          return { ok: true };
        }

        case 'GET_WATCH_STATS': {
          return { stats: await getWatchStats() };
        }

        case 'WATCH_TIME_DELTA': {
          return { stats: await recordWatchTime(msg.seconds) };
        }

        case 'SAVE_WATCH_LIMIT': {
          return { stats: await saveWatchTimeLimit(msg.minutes) };
        }

        case 'EXPORT_DATA': {
          const payload = await getExportPayload();
          return { payload };
        }

        case 'IMPORT_DATA': {
          return await importPayload(msg.payload ?? {});
        }

        case 'ADD_CHANNEL': {
          const channel = await fetchChannelProfile(msg.input ?? '');
          await upsertCachedChannel(channel);
          return { channel };
        }

        // Starts a persisted scrape. The popup polls GET_SCRAPE_STATUS instead
        // of holding one long-lived MV3 message port open.
        case 'SCRAPE_CHANNELS': {
          const status = await getScrapeStatus();
          if (status.inProgress) return { started: true, alreadyInProgress: true };

          await storageSet({
            scrapeInProgress: true,
            scrapeStartedAt: Date.now(),
            scrapeProgressCount: 0,
            scrapeChannelsProgress: [],
            scrapeError: '',
          });
          const tabId = await openChannelsTab();
          await storageSet({
            scrapeTabId: tabId,
            scrapeTabCreatedByExtension,
            scrapeReturnTabId,
            scrapeReturnWindowId,
          });
          void triggerChannelsScraper(tabId);
          return { started: true, tabId };
        }

        case 'CANCEL_SCRAPE': {
          const inProgress = Boolean((await storageGet('scrapeInProgress')) ?? false);
          if (inProgress) {
            await failScrape('Subscription refresh was cancelled. The previous list was kept.');
          }
          await closeScrapeTabIfNeeded();
          return { ok: true };
        }

        case 'GET_FEED': {
          const feedRequestReceivedAt = new Date().toISOString();
          const feedStartedMs = Date.now();
          const channelIds   = msg.channelIds
            ?? (await storageGet('selectedChannelIds'))  ?? [];
          const channelsMeta = normalizeChannelsMeta(
            msg.channelsMeta ?? (await storageGet('selectedChannelsMeta')) ?? {}
          );
          const feed = await buildFeed(channelIds, channelsMeta, {
            forceRefresh: Boolean(msg.forceRefresh),
            videoTypeFilters: msg.videoTypeFilters,
            strict: Boolean(msg.strict),
          });
          const feedDiagnostics = {
            ...(feed.feedDiagnostics ?? {}),
            feedRequestReceivedAt,
            feedCompletedAt: new Date().toISOString(),
            durationMs: Date.now() - feedStartedMs,
            requestedChannels: feed.feedStatus.requestedChannels,
            fetchedChannels: feed.feedStatus.fetchedChannels,
            cachedChannels: feed.feedStatus.cachedChannels,
            staleChannels: feed.feedStatus.staleChannels,
            failedChannels: feed.feedStatus.failedChannels,
            videoCount: feed.videos.length,
          };
          if ((await getPreferences()).enableLogging) {
            await appendDiagnosticLog({
              source: 'background',
              event: 'feed.request',
              details: feedDiagnostics,
            });
          }
          return { ...feed, feedDiagnostics };
        }

        case 'APPEND_DIAGNOSTIC_LOG': {
          return await appendDiagnosticLog(msg.entry ?? {});
        }

        case 'GET_DIAGNOSTIC_LOGS': {
          return { entries: await getDiagnosticLogs(msg.limit) };
        }

        case 'CLEAR_DIAGNOSTIC_LOGS': {
          return await clearDiagnosticLogs();
        }

        case 'SAVE_SELECTION': {
          const normalizedMeta = normalizeChannelsMeta(msg.channelsMeta ?? {});
          const selectedChannelIds = Array.from(new Set((msg.channelIds ?? []).filter(Boolean)));
          await storageSet({
            selectedChannelIds,
            selectedChannelsMeta: normalizedMeta,
          });
          return { ok: true };
        }

        case 'GET_SELECTION': {
          const selectedChannelIds   = (await storageGet('selectedChannelIds'))   ?? [];
          const selectedChannelsMeta = normalizeChannelsMeta((await storageGet('selectedChannelsMeta')) ?? {});
          return { selectedChannelIds, selectedChannelsMeta };
        }

        default:
          return { error: `Unknown message type: ${msg.type}` };
      }
    } catch (err) {
      if (msg.type === 'SCRAPE_CHANNELS') {
        await failScrape(err?.message);
        await closeScrapeTabIfNeeded();
      }
      console.error('[YT Curated BG]', err);
      return { error: err.message };
    }
  })().then(sendResponse);

  return true; // keep channel open for async sendResponse
});
