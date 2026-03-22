/**
 * popup.js
 * Manages the popup UI: onboarding, scraping trigger, channel list, selection.
 *
 * State machine:
 *  ONBOARDING   → user has no cached channels yet
 *  SCRAPING     → background opened the channels tab; we're polling for progress
 *  LIST         → channels available; user picks which ones to follow
 */

'use strict';

// ─── Messaging ────────────────────────────────────────────────────────────────
const send = (msg) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (resp?.error)         reject(new Error(resp.error));
      else                          resolve(resp);
    });
  });

// ─── State ────────────────────────────────────────────────────────────────────
let allChannels   = [];
let selectedIds   = new Set();
let filterText    = '';
let isScraping    = false;
let pollTimer     = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const onboardingEl  = document.getElementById('onboarding');
const scrapingEl    = document.getElementById('scraping-panel');
const listViewEl    = document.getElementById('list-view');
const scrapeCountEl = document.getElementById('scrape-count');
const channelListEl = document.getElementById('channel-list');
const statsTextEl   = document.getElementById('stats-text');
const selCountEl    = document.getElementById('sel-count');
const searchEl      = document.getElementById('search');
const btnOpenFeed   = document.getElementById('btn-open-feed');
const btnStartScrape= document.getElementById('btn-start-scrape');
const btnRescrape   = document.getElementById('btn-rescrape');
const btnAddChannel = document.getElementById('btn-add-channel');
const btnSave       = document.getElementById('btn-save');
const btnAll        = document.getElementById('btn-all');
const btnNone       = document.getElementById('btn-none');
const toastEl       = document.getElementById('toast');

// ─── View switcher ────────────────────────────────────────────────────────────
function showView(name) {
  onboardingEl.classList.toggle('visible', name === 'onboarding');
  scrapingEl.classList.toggle('visible',   name === 'scraping');
  listViewEl.classList.toggle('visible',   name === 'list');
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function beginScrapePolling() {
  stopPolling();

  pollTimer = setInterval(async () => {
    try {
      const cached = await send({ type: 'GET_CHANNELS' });
      if (cached?.channels?.length) {
        scrapeCountEl.textContent = cached.channels.length;
        allChannels = cached.channels;
        isScraping = false;
        stopPolling();
        showView('list');
        renderList();
        updateStats();
        showToast(`✓ Found ${cached.channels.length} subscriptions`);
        return;
      }

      const status = await send({ type: 'GET_SCRAPE_STATUS' });
      if (!status?.inProgress) {
        isScraping = false;
        stopPolling();
        showView('onboarding');
      }
    } catch (_) {}
  }, 1200);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  let savedSelectionMeta = {};

  // Restore saved selection first
  try {
    const saved = await send({ type: 'GET_SELECTION' });
    if (saved?.selectedChannelIds?.length) {
      selectedIds = new Set(saved.selectedChannelIds);
    }
    savedSelectionMeta = saved?.selectedChannelsMeta ?? {};
  } catch (_) {}

  // Check if we already have cached channels
  try {
    const cached = await send({ type: 'GET_CHANNELS' });
    if (cached?.channels?.length) {
      allChannels = cached.channels;
      for (const [id, meta] of Object.entries(savedSelectionMeta)) {
        if (!allChannels.some((channel) => channel.id === id)) {
          allChannels.push({
            id,
            name: meta.name || meta.handle || '—',
            thumbnail: meta.thumbnail || '',
            subscriberCount: meta.subscriberCount || '',
            handle: meta.handle || '',
          });
        }
      }
      showView('list');
      renderList();
      updateStats();
      return;
    }
  } catch (_) {}

  try {
    const status = await send({ type: 'GET_SCRAPE_STATUS' });
    if (status?.inProgress) {
      isScraping = true;
      showView('scraping');
      scrapeCountEl.textContent = '0';
      beginScrapePolling();
      return;
    }
  } catch (_) {}

  const savedOnlyChannels = Object.entries(savedSelectionMeta).map(([id, meta]) => ({
    id,
    name: meta.name || meta.handle || '—',
    thumbnail: meta.thumbnail || '',
    subscriberCount: meta.subscriberCount || '',
    handle: meta.handle || '',
  })).filter((channel) => channel.id);

  if (savedOnlyChannels.length) {
    allChannels = savedOnlyChannels;
    showView('list');
    renderList();
    updateStats();
    return;
  }

  // No channels yet — show onboarding
  showView('onboarding');
}

// ─── Scraping flow ────────────────────────────────────────────────────────────

/** Start a scrape: open the channels page and poll for progress. */
async function startScrape() {
  if (isScraping) return;
  isScraping = true;

  showView('scraping');
  scrapeCountEl.textContent = '0';
  beginScrapePolling();

  try {
    // This message returns only when the scraper posts CHANNELS_READY
    const resp = await send({ type: 'SCRAPE_CHANNELS' });
    const channels = resp.channels ?? [];

    stopPolling();
    isScraping = false;
    allChannels = channels;

    if (!channels.length) {
      showView('onboarding');
      showToast('No channels found — are you logged in to YouTube?');
    } else {
      showView('list');
      renderList();
      updateStats();
      showToast(`✓ Found ${channels.length} subscriptions`);
    }
  } catch (err) {
    stopPolling();
    isScraping = false;
    showView('onboarding');
    showToast('Error: ' + err.message);
  }
}

// ─── Channel list rendering ───────────────────────────────────────────────────
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

function renderList() {
  const query   = filterText.toLowerCase();
  const visible = query
    ? allChannels.filter((c) =>
        c.name.toLowerCase().includes(query) ||
        String(c.handle ?? '').toLowerCase().includes(query))
    : allChannels;

  if (!visible.length) {
    channelListEl.innerHTML = `
      <div class="state-center">
        <div class="state-icon">🔍</div>
        <div class="state-title">No channels match "${escHtml(filterText)}"</div>
      </div>`;
    updateStats();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const ch of visible) {
    const item       = document.createElement('div');
    const isSelected = selectedIds.has(ch.id);
    item.className   = 'channel-item' + (isSelected ? ' selected' : '');
    item.dataset.id  = ch.id;

    const initial   = (ch.name?.[0] ?? '?').toUpperCase();
    const thumbHtml = ch.thumbnail
      ? `<img class="ch-avatar" src="${escHtml(ch.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="ch-avatar-ph" style="display:none">${initial}</div>`
      : `<div class="ch-avatar-ph">${initial}</div>`;

    const subText = getChannelSubText(ch);

    item.innerHTML = `
      <div class="ch-check">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5L4 7.5L8.5 2.5" stroke="white" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      ${thumbHtml}
      <div class="ch-info">
        <div class="ch-name">${escHtml(ch.name)}</div>
        ${subText ? `<div class="ch-sub">${escHtml(subText)}</div>` : ''}
      </div>`;

    item.addEventListener('click', () => {
      if (selectedIds.has(ch.id)) {
        selectedIds.delete(ch.id);
        item.classList.remove('selected');
      } else {
        selectedIds.add(ch.id);
        item.classList.add('selected');
      }
      updateStats();
    });

    frag.appendChild(item);
  }

  channelListEl.innerHTML = '';
  channelListEl.appendChild(frag);
  updateStats();
}

function updateStats() {
  const total = allChannels.length;
  const sel   = selectedIds.size;
  statsTextEl.innerHTML = `<strong>${total}</strong> channels`;
  selCountEl.textContent = sel;
  btnSave.disabled     = sel === 0;
  btnOpenFeed.disabled = sel === 0;
}

function mergeChannel(channel) {
  const existingIndex = allChannels.findIndex((entry) => entry.id === channel.id);
  if (existingIndex >= 0) {
    allChannels.splice(existingIndex, 1, { ...allChannels[existingIndex], ...channel });
  } else {
    allChannels.unshift(channel);
  }
}

// ─── Save & open feed ─────────────────────────────────────────────────────────
async function saveAndOpen() {
  btnSave.disabled    = true;
  btnSave.textContent = 'Saving…';

  const channelIds   = [...selectedIds];
  const channelsMeta = {};
  for (const ch of allChannels) {
    if (selectedIds.has(ch.id)) {
      channelsMeta[ch.id] = {
        name: ch.name,
        thumbnail: ch.thumbnail,
        subscriberCount: ch.subscriberCount,
        handle: ch.handle,
      };
    }
  }

  try {
    await send({ type: 'SAVE_SELECTION', channelIds, channelsMeta });

    const feedUrl = chrome.runtime.getURL('src/feed.html');
    const tabs    = await chrome.tabs.query({ url: feedUrl });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: feedUrl });
    }
    window.close();
  } catch (err) {
    showToast('Error: ' + err.message);
    btnSave.disabled    = false;
    btnSave.textContent = 'Save & Open Feed';
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Event listeners ─────────────────────────────────────────────────────────
btnStartScrape.addEventListener('click', startScrape);
btnRescrape.addEventListener('click', startScrape);
btnSave.addEventListener('click', saveAndOpen);
btnAddChannel?.addEventListener('click', async () => {
  const input = window.prompt('Paste a YouTube channel URL, /videos URL, @handle, or channel ID.');
  if (!input?.trim()) return;

  btnAddChannel.disabled = true;
  btnAddChannel.textContent = '…';

  try {
    const resp = await send({ type: 'ADD_CHANNEL', input: input.trim() });
    const channel = resp.channel;
    if (!channel?.id) throw new Error('Could not add that channel.');

    mergeChannel(channel);
    selectedIds.add(channel.id);
    filterText = '';
    searchEl.value = '';
    showView('list');
    renderList();
    showToast(`Added ${channel.name}`);
  } catch (err) {
    showToast('Error: ' + err.message);
  } finally {
    btnAddChannel.disabled = false;
    btnAddChannel.textContent = '+';
  }
});

btnOpenFeed.addEventListener('click', () => {
  const feedUrl = chrome.runtime.getURL('src/feed.html');
  chrome.tabs.query({ url: feedUrl }, (tabs) => {
    if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else             chrome.tabs.create({ url: feedUrl });
  });
  window.close();
});

searchEl.addEventListener('input', () => {
  filterText = searchEl.value.trim();
  renderList();
});

btnAll.addEventListener('click', () => {
  const query   = filterText.toLowerCase();
  const visible = query
    ? allChannels.filter((c) =>
        c.name.toLowerCase().includes(query) ||
        String(c.handle ?? '').toLowerCase().includes(query))
    : allChannels;
  visible.forEach((c) => selectedIds.add(c.id));
  renderList();
});

btnNone.addEventListener('click', () => {
  const query   = filterText.toLowerCase();
  const visible = query
    ? allChannels.filter((c) =>
        c.name.toLowerCase().includes(query) ||
        String(c.handle ?? '').toLowerCase().includes(query))
    : allChannels;
  visible.forEach((c) => selectedIds.delete(c.id));
  renderList();
});

// ─── Also listen for live progress updates from the scraper ──────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHANNELS_PROGRESS' && isScraping) {
    scrapeCountEl.textContent = msg.channels?.length ?? 0;
  }
  if (msg.type === 'CHANNELS_CACHE_UPDATED' && Array.isArray(msg.channels)) {
    allChannels = msg.channels;
    if (listViewEl.classList.contains('visible')) {
      renderList();
      updateStats();
    }
  }
});

// ─── Kick off ─────────────────────────────────────────────────────────────────
init();
