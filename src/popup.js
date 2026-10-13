/**
 * Dashboard-first popup for YT Curated Feed.
 *
 * Overview owns watch-time analytics and the daily guardrail. Channel scraping
 * and selection remain a persisted background operation, but live in their own
 * sidebar workspace instead of controlling the entire popup lifecycle.
 */

'use strict';

// ─── Runtime messaging ───────────────────────────────────────────────────────
const send = (message) => new Promise((resolve, reject) => {
  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else if (response?.error) reject(new Error(response.error));
    else resolve(response);
  });
});

// ─── State ───────────────────────────────────────────────────────────────────
let allChannels = [];
let selectedIds = new Set();
let selectedChannelsMeta = {};
let filterText = '';
let selectionDirty = false;
let isScraping = false;
let scrapePollTimer = null;
let scrapePollInFlight = false;
let watchStats = null;
let watchRefreshTimer = null;
let watchLimitSaving = false;
let openedVideoIds = new Set();
let preferences = {
  videoTypeFilters: { standard: true, shorts: true, live: false, other: true },
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 72;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const viewElements = {
  dashboard: document.getElementById('dashboard-view'),
  channels: document.getElementById('channels-view'),
  focus: document.getElementById('focus-view'),
  settings: document.getElementById('settings-view'),
};
const navButtons = [...document.querySelectorAll('.nav-button[data-view]')];
const navChannelCount = document.getElementById('nav-channel-count');

const dashboardDate = document.getElementById('dashboard-date');
const dashboardOpenFeed = document.getElementById('dashboard-open-feed');
const dashboardSetup = document.getElementById('dashboard-setup');
const dashboardSetupButton = document.getElementById('dashboard-setup-button');
const ringProgress = document.getElementById('ring-progress');
const ringValue = document.getElementById('ring-value');
const ringCaption = document.getElementById('ring-caption');
const ringReset = document.getElementById('ring-reset');
const trackingPill = document.getElementById('tracking-pill');
const limitHeadline = document.getElementById('limit-headline');
const limitMessage = document.getElementById('limit-message');
const dailyLimitInput = document.getElementById('daily-limit');
const saveLimitButton = document.getElementById('save-limit');
const quickLimitButtons = [...document.querySelectorAll('.limit-chip[data-minutes]')];
const weekMetric = document.getElementById('week-metric');
const sevenMetric = document.getElementById('seven-metric');
const averageMetric = document.getElementById('average-metric');
const weekChart = document.getElementById('week-chart');

const channelOnboarding = document.getElementById('channel-onboarding');
const scrapingPanel = document.getElementById('scraping-panel');
const channelManager = document.getElementById('channel-manager');
const scrapeCount = document.getElementById('scrape-count');
const channelList = document.getElementById('channel-list');
const statsText = document.getElementById('stats-text');
const selectedCount = document.getElementById('sel-count');
const searchInput = document.getElementById('search');
const unsavedLabel = document.getElementById('unsaved-label');
const startScrapeButton = document.getElementById('btn-start-scrape');
const cancelScrapeButton = document.getElementById('btn-cancel-scrape');
const rescrapeButton = document.getElementById('btn-rescrape');
const addChannelButton = document.getElementById('btn-add-channel');
const addChannelModal = document.getElementById('add-channel-modal');
const addChannelBackdrop = document.getElementById('add-channel-backdrop');
const addChannelInput = document.getElementById('add-channel-input');
const addChannelError = document.getElementById('add-channel-error');
const cancelAddChannelButton = document.getElementById('cancel-add-channel');
const confirmAddChannelButton = document.getElementById('confirm-add-channel');
const selectAllButton = document.getElementById('btn-all');
const selectNoneButton = document.getElementById('btn-none');
const saveSelectionButton = document.getElementById('btn-save');
const saveAndOpenButton = document.getElementById('btn-open-feed');

const liveFilterToggle = document.getElementById('live-filter-toggle');
const loggingToggle = document.getElementById('logging-toggle');
const logViewer = document.getElementById('log-viewer');
const logList = document.getElementById('log-list');
const logCount = document.getElementById('log-count');
const refreshLogsButton = document.getElementById('btn-refresh-logs');
const clearLogsButton = document.getElementById('btn-clear-logs');
const importButton = document.getElementById('btn-import');
const exportButton = document.getElementById('btn-export');
const dashboardStatsButton = document.getElementById('btn-stats');
const settingsStatsButton = document.getElementById('settings-open-stats');
const sessionCopy = document.getElementById('session-copy');
const toast = document.getElementById('toast');

// ─── Workspace navigation ────────────────────────────────────────────────────
function showWorkspace(name) {
  const next = viewElements[name] ? name : 'dashboard';
  for (const [viewName, element] of Object.entries(viewElements)) {
    element.classList.toggle('visible', viewName === next);
  }
  for (const button of navButtons) {
    const active = button.dataset.view === next;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  if (next === 'channels') {
    renderChannelState();
    if (allChannels.length && !isScraping) requestAnimationFrame(() => searchInput.focus());
  }

  if (next === 'settings' && preferences.enableLogging) {
    void renderDiagnosticLogs();
  }
}

for (const button of navButtons) {
  button.addEventListener('click', () => showWorkspace(button.dataset.view));
}

// ─── Dashboard rendering ─────────────────────────────────────────────────────
function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDuration(seconds, { compact = false } = {}) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  if (safeSeconds > 0 && safeSeconds < 60) return '<1m';

  const totalMinutes = Math.floor(safeSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m`;
  if (!minutes || compact) return `${hours}h${compact ? '' : ' 0m'}`;
  return `${hours}h ${minutes}m`;
}

function renderWatchStats(stats) {
  if (!stats) return;
  watchStats = stats;

  const todaySeconds = Math.max(0, Number(stats.todaySeconds) || 0);
  const todayMinutes = Math.floor(todaySeconds / 60);
  const limitMinutes = Math.max(0, Number(stats.dailyLimitMinutes) || 0);
  const limitSeconds = limitMinutes * 60;
  const progress = limitSeconds > 0 ? Math.min(1, todaySeconds / limitSeconds) : 0;

  ringValue.textContent = todaySeconds > 0 && todaySeconds < 60 ? '<1' : String(todayMinutes);
  ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  ringProgress.classList.toggle('blocked', Boolean(stats.blocked));
  trackingPill.classList.toggle('blocked', Boolean(stats.blocked));

  if (!limitMinutes) {
    ringCaption.textContent = 'No daily limit';
    trackingPill.textContent = 'Tracking on';
    limitHeadline.textContent = 'Choose a comfortable limit';
    limitMessage.textContent = 'Set a guardrail and YouTube will pause when today’s allowance is used.';
  } else if (stats.blocked) {
    ringCaption.textContent = `${limitMinutes} min allowance used`;
    trackingPill.textContent = 'Limit reached';
    limitHeadline.textContent = 'That’s enough for today';
    limitMessage.textContent = 'YouTube is blocked until midnight. Raise the limit only if that choice still feels intentional.';
  } else {
    const remaining = Math.max(0, Number(stats.remainingSeconds) || 0);
    ringCaption.textContent = `${formatDuration(remaining)} remaining`;
    trackingPill.textContent = 'Within limit';
    limitHeadline.textContent = progress >= .75 ? 'You’re nearing today’s edge' : 'Your boundary is active';
    limitMessage.textContent = `${Math.round(progress * 100)}% of today’s ${limitMinutes}-minute allowance is used.`;
  }

  ringReset.textContent = 'Resets automatically at local midnight';
  weekMetric.textContent = formatDuration(stats.weekSeconds, { compact: true });
  sevenMetric.textContent = formatDuration(stats.last7DaysSeconds, { compact: true });
  averageMetric.textContent = formatDuration((Number(stats.last7DaysSeconds) || 0) / 7, { compact: true });

  if (document.activeElement !== dailyLimitInput) dailyLimitInput.value = String(limitMinutes);
  for (const button of quickLimitButtons) {
    button.classList.toggle('active', Number(button.dataset.minutes) === limitMinutes);
  }

  renderWeekChart(stats.last7Days ?? []);
}

function renderWeekChart(days) {
  const maximum = Math.max(1, ...days.map((entry) => Number(entry.seconds) || 0));
  const today = localDateKey();
  weekChart.innerHTML = '';

  for (const entry of days) {
    const seconds = Math.max(0, Number(entry.seconds) || 0);
    const date = new Date(`${entry.date}T12:00:00`);
    const label = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date).slice(0, 2);
    const day = document.createElement('div');
    day.className = 'chart-day' + (entry.date === today ? ' today' : '');
    day.title = `${new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(date)}: ${formatDuration(seconds)}`;
    day.innerHTML = `
      <div class="bar-well"><div class="bar-value"></div></div>
      <div class="bar-label"></div>`;
    day.querySelector('.bar-label').textContent = label;
    const bar = day.querySelector('.bar-value');
    const height = seconds ? Math.max(7, (seconds / maximum) * 61) : 3;
    bar.style.height = '3px';
    weekChart.appendChild(day);
    requestAnimationFrame(() => { bar.style.height = `${height}px`; });
  }
}

async function refreshWatchStats({ quiet = true } = {}) {
  try {
    const response = await send({ type: 'GET_WATCH_STATS' });
    renderWatchStats(response.stats);
  } catch (error) {
    trackingPill.textContent = 'Unavailable';
    trackingPill.classList.add('blocked');
    if (!quiet) showToast(error.message);
  }
}

async function saveWatchLimit(minutes) {
  if (watchLimitSaving) return;
  const normalized = Math.round(Number(minutes));
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1440) {
    showToast('Enter a limit between 0 and 1440 minutes');
    dailyLimitInput.focus();
    return;
  }

  watchLimitSaving = true;
  saveLimitButton.disabled = true;
  saveLimitButton.textContent = 'Saving';
  quickLimitButtons.forEach((button) => { button.disabled = true; });
  try {
    const response = await send({ type: 'SAVE_WATCH_LIMIT', minutes: normalized });
    renderWatchStats(response.stats);
    showToast(normalized ? `Daily limit set to ${normalized} minutes` : 'Daily blocking turned off');
  } catch (error) {
    showToast(`Could not save limit: ${error.message}`);
  } finally {
    watchLimitSaving = false;
    saveLimitButton.disabled = false;
    saveLimitButton.textContent = 'Apply';
    quickLimitButtons.forEach((button) => { button.disabled = false; });
  }
}

saveLimitButton.addEventListener('click', () => saveWatchLimit(dailyLimitInput.value));
dailyLimitInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void saveWatchLimit(dailyLimitInput.value);
});
for (const button of quickLimitButtons) {
  button.addEventListener('click', () => void saveWatchLimit(button.dataset.minutes));
}

// ─── Channel state and rendering ─────────────────────────────────────────────
function mergeSelectedIntoList(channels = []) {
  const merged = channels.map((channel) => ({ ...channel }));
  for (const [id, meta] of Object.entries(selectedChannelsMeta)) {
    if (!id || merged.some((channel) => channel.id === id)) continue;
    merged.push({
      id,
      name: meta.name || meta.handle || '—',
      thumbnail: meta.thumbnail || '',
      subscriberCount: meta.subscriberCount || '',
      handle: meta.handle || '',
    });
  }
  return merged;
}

function showChannelState(name) {
  channelOnboarding.classList.toggle('visible', name === 'onboarding');
  scrapingPanel.classList.toggle('visible', name === 'scraping');
  channelManager.classList.toggle('visible', name === 'manager');
}

function renderChannelState() {
  if (isScraping) {
    showChannelState('scraping');
    statsText.textContent = 'Reading the signed-in YouTube subscription list…';
    return;
  }
  if (allChannels.length) {
    showChannelState('manager');
    renderChannelList();
    return;
  }
  showChannelState('onboarding');
  statsText.textContent = 'Load subscriptions, then choose what appears in your feed.';
}

function normalizedLabel(text = '') {
  return String(text).trim().replace(/^@/, '').replace(/\s+/g, ' ').toLowerCase();
}

function getChannelSubText(channel) {
  const subscriberCount = String(channel.subscriberCount ?? '').trim();
  if (subscriberCount) return subscriberCount;
  const handle = String(channel.handle ?? '').trim();
  if (!handle) return '';
  return normalizedLabel(handle) === normalizedLabel(channel.name) ? '' : handle;
}

function getVisibleChannels() {
  const query = filterText.toLowerCase();
  if (!query) return allChannels;
  return allChannels.filter((channel) =>
    String(channel.name ?? '').toLowerCase().includes(query)
    || String(channel.handle ?? '').toLowerCase().includes(query)
  );
}

function renderChannelList() {
  const visible = getVisibleChannels();
  channelList.innerHTML = '';

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-list';
    empty.textContent = filterText ? `No channels match “${filterText}”.` : 'No channels available.';
    channelList.appendChild(empty);
    updateChannelSummary();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const channel of visible) {
    const item = document.createElement('div');
    const isSelected = selectedIds.has(channel.id);
    item.className = 'channel-item' + (isSelected ? ' selected' : '');
    item.dataset.id = channel.id;
    item.setAttribute('role', 'checkbox');
    item.setAttribute('aria-checked', String(isSelected));
    item.tabIndex = 0;

    const initial = escHtml((channel.name?.[0] ?? '?').toUpperCase());
    const thumbnail = channel.thumbnail
      ? `<img class="ch-avatar" src="${escHtml(channel.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer"><div class="ch-avatar-ph" style="display:none">${initial}</div>`
      : `<div class="ch-avatar-ph">${initial}</div>`;
    const subText = getChannelSubText(channel);

    item.innerHTML = `
      <div class="ch-check" aria-hidden="true">
        <svg viewBox="0 0 10 10" fill="none"><path d="M1.5 5 4 7.5 8.5 2.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      ${thumbnail}
      <div class="ch-info">
        <div class="ch-name">${escHtml(channel.name || 'Unnamed channel')}</div>
        ${subText ? `<div class="ch-sub">${escHtml(subText)}</div>` : ''}
      </div>`;

    const avatar = item.querySelector('.ch-avatar');
    avatar?.addEventListener('error', () => {
      avatar.style.display = 'none';
      if (avatar.nextElementSibling) avatar.nextElementSibling.style.display = 'grid';
    }, { once: true });

    const toggle = () => {
      if (selectedIds.has(channel.id)) selectedIds.delete(channel.id);
      else selectedIds.add(channel.id);
      selectionDirty = true;
      item.classList.toggle('selected', selectedIds.has(channel.id));
      item.setAttribute('aria-checked', String(selectedIds.has(channel.id)));
      updateChannelSummary();
    };
    item.addEventListener('click', toggle);
    item.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        toggle();
      }
    });
    fragment.appendChild(item);
  }

  channelList.appendChild(fragment);
  updateChannelSummary();
}

function updateChannelSummary() {
  const total = allChannels.length;
  const selected = selectedIds.size;
  selectedCount.textContent = String(selected);
  navChannelCount.textContent = selected > 99 ? '99+' : String(selected);
  navChannelCount.classList.toggle('attention', selected === 0 || selectionDirty);
  statsText.textContent = `${total} channel${total === 1 ? '' : 's'} available · ${selected} in your feed`;
  unsavedLabel.textContent = selectionDirty ? 'Unsaved changes' : 'Selection saved';
  unsavedLabel.classList.toggle('dirty', selectionDirty);
  saveSelectionButton.disabled = selected === 0 || !selectionDirty;
  saveAndOpenButton.disabled = selected === 0;
  dashboardSetup.classList.toggle('visible', selected === 0);
  dashboardOpenFeed.innerHTML = selected
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg> Open feed'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg> Set up feed';
  sessionCopy.textContent = openedVideoIds.size
    ? `${openedVideoIds.size} opened video${openedVideoIds.size === 1 ? '' : 's'} are greyed for this browser session.`
    : 'Opened cards turn grey for this browser session and clear after restart.';
}

function buildSelectedMetadata() {
  const next = {};
  for (const id of selectedIds) {
    const channel = allChannels.find((entry) => entry.id === id);
    const fallback = selectedChannelsMeta[id] ?? {};
    next[id] = {
      name: channel?.name || fallback.name || '',
      thumbnail: channel?.thumbnail || fallback.thumbnail || '',
      subscriberCount: channel?.subscriberCount || fallback.subscriberCount || '',
      handle: channel?.handle || fallback.handle || '',
    };
  }
  return next;
}

function openAddChannelDialog() {
  addChannelInput.value = '';
  addChannelError.textContent = '';
  addChannelModal.classList.add('visible');
  addChannelModal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => addChannelInput.focus());
}

function closeAddChannelDialog() {
  addChannelModal.classList.remove('visible');
  addChannelModal.setAttribute('aria-hidden', 'true');
  addChannelError.textContent = '';
  addChannelButton.focus();
}

async function confirmAddChannel() {
  const input = addChannelInput.value.trim();
  if (!input) {
    addChannelError.textContent = 'Enter a channel URL, handle, or ID.';
    addChannelInput.focus();
    return;
  }

  confirmAddChannelButton.disabled = true;
  cancelAddChannelButton.disabled = true;
  confirmAddChannelButton.textContent = 'Finding…';
  addChannelError.textContent = '';
  try {
    const response = await send({ type: 'ADD_CHANNEL', input });
    const channel = response.channel;
    if (!channel?.id) throw new Error('That channel could not be resolved.');
    const index = allChannels.findIndex((entry) => entry.id === channel.id);
    if (index >= 0) allChannels.splice(index, 1, { ...allChannels[index], ...channel });
    else allChannels.unshift(channel);
    selectedIds.add(channel.id);
    selectionDirty = true;
    filterText = '';
    searchInput.value = '';
    closeAddChannelDialog();
    renderChannelState();
    showToast(`${channel.name} added to your feed`);
  } catch (error) {
    addChannelError.textContent = error.message || 'That channel could not be added.';
    addChannelInput.focus();
  } finally {
    confirmAddChannelButton.disabled = false;
    cancelAddChannelButton.disabled = false;
    confirmAddChannelButton.textContent = 'Add channel';
  }
}

async function saveSelection({ openFeed = false } = {}) {
  if (!selectedIds.size) {
    showWorkspace('channels');
    showToast('Choose at least one channel first');
    return;
  }

  const buttons = [saveSelectionButton, saveAndOpenButton];
  buttons.forEach((button) => { button.disabled = true; });
  const oldSaveText = saveSelectionButton.textContent;
  const oldOpenText = saveAndOpenButton.textContent;
  if (openFeed) saveAndOpenButton.textContent = 'Opening…';
  else saveSelectionButton.textContent = 'Saving…';

  try {
    const channelsMeta = buildSelectedMetadata();
    await send({ type: 'SAVE_SELECTION', channelIds: [...selectedIds], channelsMeta });
    selectedChannelsMeta = channelsMeta;
    selectionDirty = false;
    updateChannelSummary();
    if (openFeed) {
      await openFeedTab();
      window.close();
    } else {
      showToast('Channel selection saved');
    }
  } catch (error) {
    showToast(`Could not save selection: ${error.message}`);
  } finally {
    saveSelectionButton.textContent = oldSaveText;
    saveAndOpenButton.textContent = oldOpenText;
    updateChannelSummary();
  }
}

async function openFeedTab() {
  const feedUrl = chrome.runtime.getURL('src/feed.html');
  const tabs = await chrome.tabs.query({ url: feedUrl });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: feedUrl });
  }
}

async function openFeedFromDashboard() {
  if (!selectedIds.size) {
    showWorkspace('channels');
    showToast('Choose the channels for your feed');
    return;
  }
  if (selectionDirty) {
    await saveSelection({ openFeed: true });
    return;
  }
  try {
    await openFeedTab();
    window.close();
  } catch (error) {
    showToast(`Could not open feed: ${error.message}`);
  }
}

// ─── Subscription scrape lifecycle ───────────────────────────────────────────
function stopScrapePolling() {
  clearInterval(scrapePollTimer);
  scrapePollTimer = null;
}

async function refreshChannelsFromStorage() {
  const response = await send({ type: 'GET_CHANNELS' });
  allChannels = mergeSelectedIntoList(response?.channels ?? []);
  renderChannelState();
  updateChannelSummary();
}

function beginScrapePolling() {
  stopScrapePolling();

  async function poll() {
    if (scrapePollInFlight) return;
    scrapePollInFlight = true;
    try {
      const status = await send({ type: 'GET_SCRAPE_STATUS' });
      scrapeCount.textContent = String(status?.progressCount ?? 0);
      if (status?.inProgress) return;

      isScraping = false;
      stopScrapePolling();
      await refreshChannelsFromStorage();
      showToast(status?.error || `Loaded ${allChannels.length} channels`);
    } catch (_) {
      // The popup may disappear while YouTube takes focus. Background state is
      // persisted and the next popup instance safely resumes this poll.
    } finally {
      scrapePollInFlight = false;
    }
  }

  scrapePollTimer = setInterval(poll, 1200);
  void poll();
}

async function startScrape() {
  if (isScraping) return;
  isScraping = true;
  scrapeCount.textContent = '0';
  showWorkspace('channels');
  renderChannelState();
  try {
    await send({ type: 'SCRAPE_CHANNELS' });
    beginScrapePolling();
  } catch (error) {
    isScraping = false;
    renderChannelState();
    showToast(`Could not refresh channels: ${error.message}`);
  }
}

async function cancelScrape() {
  cancelScrapeButton.disabled = true;
  cancelScrapeButton.textContent = 'Cancelling…';
  try {
    await send({ type: 'CANCEL_SCRAPE' });
    stopScrapePolling();
    isScraping = false;
    await refreshChannelsFromStorage();
    showToast('Subscription refresh cancelled');
  } catch (error) {
    showToast(`Could not cancel: ${error.message}`);
  } finally {
    cancelScrapeButton.disabled = false;
    cancelScrapeButton.textContent = 'Cancel refresh';
  }
}

// ─── Preferences and data ────────────────────────────────────────────────────
async function saveLivePreference(enabled) {
  liveFilterToggle.disabled = true;
  const previous = Boolean(preferences.videoTypeFilters?.live);
  try {
    const nextPreferences = {
      ...preferences,
      videoTypeFilters: { ...preferences.videoTypeFilters, live: enabled },
    };
    const response = await send({ type: 'SAVE_PREFERENCES', preferences: nextPreferences });
    preferences = response.preferences;
    liveFilterToggle.checked = Boolean(preferences.videoTypeFilters?.live);
    showToast(enabled ? 'Live and upcoming videos will be shown' : 'Live and upcoming videos will stay hidden');
  } catch (error) {
    liveFilterToggle.checked = previous;
    showToast(`Could not save preference: ${error.message}`);
  } finally {
    liveFilterToggle.disabled = false;
  }
}

function formatLogTime(iso = '') {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '—');
  return date.toLocaleTimeString(undefined, { hour12: false });
}

function formatLogDateTime(iso = '') {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso || '—');
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function msBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!startIso || !endIso || Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

function formatDelta(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Returns one line per array item so the full stamp chain gets its own row.
function summarizeLogDetails(entry) {
  const details = entry.details ?? {};
  if (entry.event === 'feed.timeline') {
    const lines = [];
    const { pageOpenedAt, feedRequestSentAt, feedResponseAt, renderedAt } = details;
    if (pageOpenedAt || feedRequestSentAt || feedResponseAt || renderedAt) {
      const stamp = (iso) => (iso ? formatLogDateTime(iso) : '—');
      const gap = (start, end) => {
        const delta = msBetween(start, end);
        const text = formatDelta(delta);
        return text ? ` (+${text})` : '';
      };
      lines.push(
        `opened ${stamp(pageOpenedAt)}${gap(pageOpenedAt, feedRequestSentAt)}, ` +
        `request ${stamp(feedRequestSentAt)}${gap(feedRequestSentAt, feedResponseAt)}, ` +
        `response ${stamp(feedResponseAt)}${gap(feedResponseAt, renderedAt)}, ` +
        `displayed ${stamp(renderedAt)}`
      );
    }
    const parts = [];
    if (details.videoCount != null) {
      parts.push(details.shownCount != null
        ? `${details.videoCount} fetched · ${details.shownCount} shown`
        : `${details.videoCount} videos`);
    }
    const bg = details.backgroundDiagnostics ?? {};
    if (bg.rssMs != null || bg.hydrationMs != null) {
      parts.push(`rss ${bg.rssMs ?? 0}ms · hydration ${bg.hydrationMs ?? 0}ms`);
    } else if (bg.durationMs != null) {
      parts.push(`fetch ${bg.durationMs}ms`);
    }
    if (bg.hydrationSkipped) parts.push(`${bg.hydrationSkipped} hydration skipped`);
    if (parts.length) lines.push(parts.join(' · '));
    return lines.length ? lines : ['timeline captured'];
  }
  if (entry.event === 'feed.request') {
    const parts = [];
    if (details.videoCount != null) parts.push(`${details.videoCount} videos`);
    if (details.rssMs != null || details.hydrationMs != null) {
      parts.push(`rss ${details.rssMs ?? 0}ms · hydration ${details.hydrationMs ?? 0}ms`);
    } else if (details.durationMs != null) {
      parts.push(`${details.durationMs}ms`);
    }
    if (details.hydrationSkipped) parts.push(`${details.hydrationSkipped} hydration skipped`);
    if (details.handleResolutions) parts.push(`${details.handleResolutions} handle lookups`);
    const breakdown = details.failureBreakdown ?? {};
    const reasons = [];
    if (breakdown.rateLimited) reasons.push(`429×${breakdown.rateLimited}`);
    if (breakdown.serverError) reasons.push(`5xx×${breakdown.serverError}`);
    if (breakdown.timeout) reasons.push(`timeout×${breakdown.timeout}`);
    if (breakdown.network) reasons.push(`network×${breakdown.network}`);
    if (breakdown.other) reasons.push(`other×${breakdown.other}`);
    if (reasons.length) parts.push(`errors ${reasons.join(', ')}`);
    if (details.strict) parts.push('strict refresh');
    if (details.cachedChannels) parts.push(`${details.cachedChannels} cached`);
    if (details.failedChannels) parts.push(`${details.failedChannels} failed`);
    return [parts.join(' · ') || 'feed fetched'];
  }
  const keys = Object.keys(details);
  return [keys.length ? keys.map((key) => `${key}: ${JSON.stringify(details[key])}`).join(' · ') : '—'];
}

async function renderDiagnosticLogs() {
  if (!preferences.enableLogging) {
    logViewer.hidden = true;
    return;
  }
  logViewer.hidden = false;
  try {
    const response = await send({ type: 'GET_DIAGNOSTIC_LOGS', limit: 50 });
    const entries = [...(response.entries ?? [])].reverse();
    logCount.textContent = entries.length
      ? `${entries.length} recent ${entries.length === 1 ? 'entry' : 'entries'}`
      : 'No entries yet';
    logList.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = 'Open YouTube or refresh the feed to capture a timeline.';
      logList.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'log-entry';
      const head = document.createElement('div');
      head.className = 'log-entry-head';
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = formatLogTime(entry.ts);
      const event = document.createElement('span');
      event.className = 'log-event';
      event.textContent = entry.event || 'event';
      const source = document.createElement('span');
      source.className = 'log-source';
      source.textContent = entry.source || '';
      head.append(time, event, source);
      row.append(head);
      const detailJson = JSON.stringify(entry.details ?? {}, null, 2);
      const lines = summarizeLogDetails(entry);
      for (const line of (Array.isArray(lines) ? lines : [lines])) {
        const detail = document.createElement('div');
        detail.className = 'log-detail';
        detail.textContent = line;
        detail.title = detailJson;
        row.append(detail);
      }
      logList.appendChild(row);
    }
  } catch (error) {
    logCount.textContent = 'Log unavailable';
    showToast(`Could not load logs: ${error.message}`);
  }
}

async function saveLoggingPreference(enabled) {
  loggingToggle.disabled = true;
  const previous = Boolean(preferences.enableLogging);
  try {
    const nextPreferences = { ...preferences, enableLogging: enabled };
    const response = await send({ type: 'SAVE_PREFERENCES', preferences: nextPreferences });
    preferences = response.preferences;
    loggingToggle.checked = Boolean(preferences.enableLogging);
    await renderDiagnosticLogs();
    showToast(enabled ? 'Diagnostic logging on — timelines will be recorded' : 'Diagnostic logging off');
  } catch (error) {
    loggingToggle.checked = previous;
    showToast(`Could not save preference: ${error.message}`);
  } finally {
    loggingToggle.disabled = false;
  }
}

async function clearDiagnosticLogs() {
  clearLogsButton.disabled = true;
  try {
    await send({ type: 'CLEAR_DIAGNOSTIC_LOGS' });
    await renderDiagnosticLogs();
    showToast('Diagnostic logs cleared');
  } catch (error) {
    showToast(`Could not clear logs: ${error.message}`);
  } finally {
    clearLogsButton.disabled = false;
  }
}

async function exportData() {
  exportButton.disabled = true;
  exportButton.textContent = 'Exporting…';
  try {
    const response = await send({ type: 'EXPORT_DATA' });
    if (!response?.payload) throw new Error('Nothing to export.');
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(response.payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `yt-curated-feed-backup-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('Backup exported');
  } catch (error) {
    showToast(`Could not export: ${error.message}`);
  } finally {
    exportButton.disabled = false;
    exportButton.textContent = 'Export backup';
  }
}

async function openPersistentExtensionPage(fileName) {
  const url = chrome.runtime.getURL(`src/${fileName}`);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

// ─── Toast and helpers ───────────────────────────────────────────────────────
let toastTimer = null;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function escHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Events ──────────────────────────────────────────────────────────────────
dashboardOpenFeed.addEventListener('click', () => void openFeedFromDashboard());
dashboardSetupButton.addEventListener('click', () => showWorkspace('channels'));
startScrapeButton.addEventListener('click', () => void startScrape());
rescrapeButton.addEventListener('click', () => void startScrape());
cancelScrapeButton.addEventListener('click', () => void cancelScrape());

searchInput.addEventListener('input', () => {
  filterText = searchInput.value.trim();
  renderChannelList();
});

selectAllButton.addEventListener('click', () => {
  getVisibleChannels().forEach((channel) => selectedIds.add(channel.id));
  selectionDirty = true;
  renderChannelList();
});

selectNoneButton.addEventListener('click', () => {
  getVisibleChannels().forEach((channel) => selectedIds.delete(channel.id));
  selectionDirty = true;
  renderChannelList();
});

saveSelectionButton.addEventListener('click', () => void saveSelection());
saveAndOpenButton.addEventListener('click', () => void saveSelection({ openFeed: true }));

addChannelButton.addEventListener('click', openAddChannelDialog);
addChannelBackdrop.addEventListener('click', closeAddChannelDialog);
cancelAddChannelButton.addEventListener('click', closeAddChannelDialog);
confirmAddChannelButton.addEventListener('click', () => void confirmAddChannel());
addChannelInput.addEventListener('input', () => { addChannelError.textContent = ''; });
addChannelInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void confirmAddChannel();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && addChannelModal.classList.contains('visible')) closeAddChannelDialog();
});

liveFilterToggle.addEventListener('change', () => void saveLivePreference(liveFilterToggle.checked));
loggingToggle.addEventListener('change', () => void saveLoggingPreference(loggingToggle.checked));
refreshLogsButton.addEventListener('click', () => void renderDiagnosticLogs());
clearLogsButton.addEventListener('click', () => void clearDiagnosticLogs());
importButton.addEventListener('click', () => {
  void openPersistentExtensionPage('import.html').catch((error) => showToast(error.message));
});
exportButton.addEventListener('click', () => void exportData());
for (const button of [dashboardStatsButton, settingsStatsButton]) {
  button.addEventListener('click', () => {
    void openPersistentExtensionPage('stats.html').catch((error) => showToast(error.message));
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'CHANNELS_PROGRESS' && isScraping) {
    scrapeCount.textContent = String(message.channels?.length ?? 0);
  }
  if (message.type === 'CHANNELS_CACHE_UPDATED' && Array.isArray(message.channels)) {
    allChannels = mergeSelectedIntoList(message.channels);
    if (!isScraping) renderChannelState();
    updateChannelSummary();
  }
  if (message.type === 'WATCH_STATUS_UPDATED' && message.stats) {
    renderWatchStats(message.stats);
  }
  if (message.type === 'VIDEO_OPENED' && message.videoId) {
    openedVideoIds.add(message.videoId);
    updateChannelSummary();
  }
});

// ─── Focus tools ─────────────────────────────────────────────────────────────
const FOCUS_OPTIONS = [
  ['Feeds & loops', [
    ['hideShorts', 'Hide Shorts', 'Shelves, tabs and sidebar entry; Shorts links open in the normal player.'],
    ['disableAutoplay', 'Turn off autoplay', 'The next video never starts by itself.'],
    ['hideEndscreen', 'Hide end-of-video wall', 'No grid of suggestions when a video ends.'],
    ['hideRelated', 'Hide recommended videos', 'Empty sidebar next to the player.'],
    ['hideMixes', 'Hide Mixes', 'Auto-generated endless playlists.'],
    ['hideSearchShelves', 'Clean search results', 'Drop "People also watched" and similar shelves.'],
  ]],
  ['While watching', [
    ['hideComments', 'Hide comments', ''],
    ['hideLiveChat', 'Hide live chat', 'Collapses chat so the video takes the full width.'],
    ['hideEndCards', 'Hide end cards', 'Creator cards over the last seconds of a video.'],
    ['hidePlaylist', 'Hide playlist panel', ''],
    ['hideMerch', 'Hide merch, tickets & offers', ''],
    ['hideFundraiser', 'Hide fundraisers', ''],
  ]],
  ['Menus', [
    ['hideExplore', 'Hide Explore / Trending', 'Guide sidebar section.'],
    ['hideMoreFromYouTube', 'Hide "More from YouTube"', 'Premium, Music, Kids links.'],
    ['hideNotifications', 'Hide notification bell', ''],
  ]],
];
const focusToggles = document.getElementById('focus-toggles');
const qualitySelect = document.getElementById('quality-select');
const homepageModeButtons = [...document.querySelectorAll('[data-homepage-mode]')];

function renderFocusView() {
  const focus = preferences.focus ?? {};
  focusToggles.innerHTML = FOCUS_OPTIONS.map(([group, options]) => `
    <div class="focus-group">
      <div class="focus-group-title">${escHtml(group)}</div>
      ${options.map(([key, label, hint]) => `
        <div class="focus-row">
          <div class="settings-copy"><strong>${escHtml(label)}</strong>${hint ? `<span>${escHtml(hint)}</span>` : ''}</div>
          <label class="toggle">
            <input type="checkbox" data-focus-key="${key}" ${focus[key] ? 'checked' : ''} aria-label="${escHtml(label)}" />
            <span class="toggle-track"></span>
          </label>
        </div>`).join('')}
    </div>`).join('');
  qualitySelect.value = preferences.preferredQuality || 'auto';
  for (const button of homepageModeButtons) {
    button.classList.toggle('active', button.dataset.homepageMode === (preferences.homepageMode || 'full'));
  }
}

async function saveFocusPreferences(partial, successMessage) {
  try {
    const response = await send({ type: 'SAVE_PREFERENCES', preferences: partial });
    preferences = { ...preferences, ...(response.preferences ?? {}) };
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(`Could not save: ${error.message}`);
  }
  renderFocusView();
}

focusToggles.addEventListener('change', (event) => {
  const key = event.target?.dataset?.focusKey;
  if (!key) return;
  void saveFocusPreferences({ focus: { [key]: event.target.checked } });
});
qualitySelect.addEventListener('change', () => {
  void saveFocusPreferences({ preferredQuality: qualitySelect.value }, 'Quality saved');
});
for (const button of homepageModeButtons) {
  button.addEventListener('click', () => {
    void saveFocusPreferences(
      { homepageMode: button.dataset.homepageMode },
      button.dataset.homepageMode === 'full' ? 'Homepage: full page' : 'Homepage: compact panel'
    );
  });
}

// ─── Initialization ──────────────────────────────────────────────────────────
async function init() {
  dashboardDate.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date());

  const [selection, channels, scrapeStatus, stats, storedPreferences, opened] = await Promise.all([
    send({ type: 'GET_SELECTION' }).catch(() => ({})),
    send({ type: 'GET_CHANNELS' }).catch(() => ({ channels: [] })),
    send({ type: 'GET_SCRAPE_STATUS' }).catch(() => ({})),
    send({ type: 'GET_WATCH_STATS' }).catch(() => ({})),
    send({ type: 'GET_PREFERENCES' }).catch(() => ({})),
    send({ type: 'GET_OPENED_VIDEOS' }).catch(() => ({ videoIds: [] })),
  ]);

  selectedIds = new Set(selection.selectedChannelIds ?? []);
  selectedChannelsMeta = selection.selectedChannelsMeta ?? {};
  allChannels = mergeSelectedIntoList(channels.channels ?? []);
  openedVideoIds = new Set(opened.videoIds ?? []);
  preferences = {
    ...preferences,
    ...(storedPreferences.preferences ?? {}),
    videoTypeFilters: {
      ...preferences.videoTypeFilters,
      ...(storedPreferences.preferences?.videoTypeFilters ?? {}),
    },
  };
  liveFilterToggle.checked = Boolean(preferences.videoTypeFilters.live);
  loggingToggle.checked = Boolean(preferences.enableLogging);
  renderFocusView();
  await renderDiagnosticLogs();

  if (stats.stats) renderWatchStats(stats.stats);
  else void refreshWatchStats({ quiet: true });

  isScraping = Boolean(scrapeStatus.inProgress);
  scrapeCount.textContent = String(scrapeStatus.progressCount ?? 0);
  updateChannelSummary();
  renderChannelState();

  if (isScraping) {
    showWorkspace('channels');
    beginScrapePolling();
  } else {
    showWorkspace('dashboard');
  }

  watchRefreshTimer = setInterval(() => void refreshWatchStats({ quiet: true }), 5000);
}

window.addEventListener('unload', () => {
  stopScrapePolling();
  clearInterval(watchRefreshTimer);
});

void init();
