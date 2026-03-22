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
 *      SCRAPE_CHANNELS     → opens channels page + waits for scraper to finish
 *      GET_FEED            → fetches & filters RSS for selected channels
 *      SAVE_SELECTION      → persists selected channel IDs + metadata
 *      GET_SELECTION       → returns persisted selection
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
    shorts: true,
    other: true,
  },
};

async function getPreferences() {
  const stored = (await storageGet('preferences')) ?? {};
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    videoTypeFilters: {
      ...DEFAULT_PREFERENCES.videoTypeFilters,
      ...(stored.videoTypeFilters ?? {}),
    },
  };
}

async function savePreferences(nextPreferences = {}) {
  const merged = {
    ...(await getPreferences()),
    ...nextPreferences,
    videoTypeFilters: {
      ...DEFAULT_PREFERENCES.videoTypeFilters,
      ...(nextPreferences.videoTypeFilters ?? {}),
    },
  };
  await storageSet({ preferences: merged });
  return merged;
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

  await storageSet({ allChannels: next, allChannelsMeta: existingMeta });
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
let scrapeTabId = null;
let scrapeReturnTabId = null;
let scrapeReturnWindowId = null;

/** Open (or focus) the channels page tab and return its tab ID. */
async function openChannelsTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  scrapeReturnTabId = activeTab?.id ?? null;
  scrapeReturnWindowId = activeTab?.windowId ?? null;

  const existing = await chrome.tabs.query({ url: CHANNELS_URL + '*' });
  if (existing.length) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    scrapeTabId = tab.id;
    return tab.id;
  }
  const tab = await chrome.tabs.create({ url: CHANNELS_URL, active: true });
  scrapeTabId = tab.id;
  return tab.id;
}

async function closeScrapeTabIfNeeded() {
  if (scrapeReturnTabId) {
    try {
      await chrome.tabs.update(scrapeReturnTabId, { active: true });
      if (scrapeReturnWindowId) {
        await chrome.windows.update(scrapeReturnWindowId, { focused: true });
      }
    } catch (_) {}
  }

  if (scrapeTabId) {
    try {
      await chrome.tabs.remove(scrapeTabId);
    } catch (_) {}
  }

  scrapeTabId = null;
  scrapeReturnTabId = null;
  scrapeReturnWindowId = null;
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

  const resp = await fetch(sanitizedUrl, {
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(`Could not open channel page (${resp.status}).`);

  const html = await resp.text();
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
async function resolveChannelId(id) {
  if (!id.startsWith('@')) return id;
  if (resolveCache.has(id)) return resolveCache.get(id);

  try {
    const profile = channelProfileCache.get(id) ?? await fetchChannelProfile(id);
    if (profile?.id) {
      resolveCache.set(id, profile.id);
      return profile.id;
    }
  } catch (e) {
    console.warn('[YT Curated] Could not resolve handle', id, e.message);
  }

  return id; // Return as-is on failure; RSS fetch will fail gracefully
}

// ─── RSS video fetching ───────────────────────────────────────────────────────
const RECENT_DAYS = 7;

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
  const otherMarkers = [
    'streamed live',
    'watch live',
    'live coverage',
    'live feed',
    'live news conference',
    'scheduled to start',
    'scheduled for',
    'premieres in',
    'premiere',
  ];
  if (otherMarkers.some((marker) => haystack.includes(marker))) return 'other';

  return 'standard';
}

function getAlternateLinkUrl(entry) {
  const links = getElementsByLocalName(entry, 'link');
  return links.find((link) => (link.getAttribute('rel') || '').toLowerCase() === 'alternate')
    ?.getAttribute('href')
    ?.trim() ?? '';
}

const feedCache = new Map();
const FEED_CACHE_MS = 10 * 60 * 1000;

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

/**
 * Fetch the Atom RSS feed for one channel and return videos posted
 * within the past 7 days.
 *
 * YouTube's public feed endpoint (no auth required):
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxx
 *
 * Returns last 15 public uploads with ISO-8601 publish timestamps.
 */
async function fetchChannelRSS(channelId, channelMeta = {}) {
  const resolvedId = await resolveChannelId(channelId);
  let normalizedMeta = normalizeChannelsMeta({
    [resolvedId]: {
      ...channelMeta,
      handle: channelId.startsWith('@') ? channelId : channelMeta.handle,
    },
  })[resolvedId] ?? normalizeChannel(channelMeta);

  if (!resolvedId.startsWith('UC')) {
    console.warn('[YT Curated] Skipping unresolved channel ID:', resolvedId);
    return [];
  }

  const cached = feedCache.get(resolvedId);
  if (cached && (Date.now() - cached.fetchedAt) < FEED_CACHE_MS) {
    return cached.videos.map((video) => ({
      ...video,
      channelName: normalizedMeta.name || video.channelName,
      channelThumbnail: normalizedMeta.thumbnail || video.channelThumbnail,
      channelSubscriberCount: normalizedMeta.subscriberCount || video.channelSubscriberCount,
      channelSubscriberCountNum: parseCountText(normalizedMeta.subscriberCount || video.channelSubscriberCount),
    }));
  }

  if (!normalizedMeta.name) {
    try {
      const profile = channelProfileCache.get(resolvedId)
        ?? channelProfileCache.get(normalizedMeta.handle)
        ?? await fetchChannelProfile(normalizedMeta.handle || resolvedId);
      normalizedMeta = {
        ...profile,
        ...normalizedMeta,
        name: normalizedMeta.name || profile.name,
        handle: normalizedMeta.handle || profile.handle,
        thumbnail: normalizedMeta.thumbnail || profile.thumbnail,
        subscriberCount: normalizedMeta.subscriberCount || profile.subscriberCount,
      };
    } catch (_) {}
  }

  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${resolvedId}`;
  let xml;

  try {
    const resp = await fetch(rssUrl, {
      headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
    });
    if (!resp.ok) {
      console.warn('[YT Curated] RSS', resp.status, resolvedId);
      return [];
    }
    xml = await resp.text();
  } catch (e) {
    console.warn('[YT Curated] RSS network error', resolvedId, e.message);
    return [];
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch (e) {
    const now = Date.now();
    const cutoffMs = getRecentCutoffMs(now);
    const videos = parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs);
    feedCache.set(resolvedId, { fetchedAt: Date.now(), videos });
    return videos;
  }
  if (doc.querySelector('parsererror')) {
    const now = Date.now();
    const cutoffMs = getRecentCutoffMs(now);
    const videos = parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs);
    feedCache.set(resolvedId, { fetchedAt: Date.now(), videos });
    return videos;
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
    const fallbackVideos = parseVideosFromXmlFallback(xml, resolvedId, normalizedMeta, now, cutoffMs);
    feedCache.set(resolvedId, { fetchedAt: Date.now(), videos: fallbackVideos });
    return fallbackVideos;
  }

  feedCache.set(resolvedId, {
    fetchedAt: Date.now(),
    videos,
  });

  return videos;
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

async function buildFeed(channelIds, channelsMeta = {}) {
  if (!channelIds?.length) return [];
  const BATCH = 15;
  const all   = [];

  for (let i = 0; i < channelIds.length; i += BATCH) {
    const batch   = channelIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((id) => fetchChannelRSS(id, channelsMeta[id] ?? {}))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') all.push(...r.value);
    }
  }

  all.sort((a, b) => a.ageSortKey - b.ageSortKey);
  return all;
}

// ─── Pending scrape promise ───────────────────────────────────────────────────
let pendingScrapedResolve = null;
let pendingScrapedReject  = null;
let scrapeTimeoutId       = null;

// ─── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── From channels-scraper content script ──
  if (msg.type === 'CHANNELS_READY' || msg.type === 'CHANNELS_PROGRESS') {
    // Persist whatever we have so popup can display it
    const channels = normalizeChannels(msg.channels ?? []);

    storageSet({ allChannels: channels }).then(() => {
      const meta = {};
      for (const ch of channels) {
        if (ch.id) {
          meta[ch.id] = {
            name: ch.name,
            thumbnail: ch.thumbnail,
            subscriberCount: ch.subscriberCount,
            handle: ch.handle,
          };
        }
      }
      return storageSet({ allChannelsMeta: meta });
    });

    if (msg.type === 'CHANNELS_READY') {
      clearTimeout(scrapeTimeoutId);
      storageSet({ channelsLoadedAt: Date.now(), scrapeInProgress: false, scrapeStartedAt: 0 });
      setTimeout(() => { void closeScrapeTabIfNeeded(); }, 500);
      void hydrateCachedChannelsInBackground();
      if (pendingScrapedResolve) {
        pendingScrapedResolve(channels);
        pendingScrapedResolve = null;
        pendingScrapedReject  = null;
      }
    }
    return; // no sendResponse needed for scraper messages
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
          const inProgress = Boolean((await storageGet('scrapeInProgress')) ?? false);
          const startedAt = (await storageGet('scrapeStartedAt')) ?? 0;
          return { inProgress, startedAt };
        }

        case 'GET_PREFERENCES': {
          const preferences = await getPreferences();
          return { preferences };
        }

        case 'SAVE_PREFERENCES': {
          const preferences = await savePreferences(msg.preferences ?? {});
          return { preferences };
        }

        case 'ADD_CHANNEL': {
          const channel = await fetchChannelProfile(msg.input ?? '');
          await upsertCachedChannel(channel);
          return { channel };
        }

        // Opens channels page and waits (long-poll) for the scraper to finish
        case 'SCRAPE_CHANNELS': {
          // Cancel any previous pending scrape
          if (pendingScrapedReject) {
            clearTimeout(scrapeTimeoutId);
            pendingScrapedReject(new Error('superseded'));
          }

          const scrapePromise = new Promise((res, rej) => {
            pendingScrapedResolve = res;
            pendingScrapedReject  = rej;
            scrapeTimeoutId = setTimeout(
              async () => {
                await storageSet({ scrapeInProgress: false, scrapeStartedAt: 0 });
                await closeScrapeTabIfNeeded();
                rej(new Error('Timed out waiting for channel scrape. Try again.'));
              },
              3 * 60 * 1000
            );
          });

          await storageSet({ scrapeInProgress: true, scrapeStartedAt: Date.now() });
          await openChannelsTab();
          const channels = await scrapePromise;
          return { channels };
        }

        case 'GET_FEED': {
          const channelIds   = msg.channelIds
            ?? (await storageGet('selectedChannelIds'))  ?? [];
          const channelsMeta = normalizeChannelsMeta(
            msg.channelsMeta ?? (await storageGet('selectedChannelsMeta')) ?? {}
          );
          const videos = await buildFeed(channelIds, channelsMeta);
          return { videos };
        }

        case 'SAVE_SELECTION': {
          const normalizedMeta = normalizeChannelsMeta(msg.channelsMeta ?? {});
          await storageSet({
            selectedChannelIds:   msg.channelIds ?? [],
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
        await storageSet({ scrapeInProgress: false, scrapeStartedAt: 0 });
        await closeScrapeTabIfNeeded();
      }
      console.error('[YT Curated BG]', err);
      return { error: err.message };
    }
  })().then(sendResponse);

  return true; // keep channel open for async sendResponse
});
