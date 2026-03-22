/**
 * feed.js
 * Powers the full-page curated feed (feed.html).
 * Fetches videos via the background service worker and renders a card grid.
 */

// ─── Messaging ───────────────────────────────────────────────────────────────
const send = (msg) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (resp?.error) reject(new Error(resp.error));
      else resolve(resp);
    });
  });

// ─── State ───────────────────────────────────────────────────────────────────
let allVideos          = [];   // full fetched list
let activeChannelFilter = null; // null = all channels
let searchQuery        = '';
let sortMode           = 'recent';
let videoTypeFilters   = { standard: true, shorts: true, other: true };

// ─── DOM refs ────────────────────────────────────────────────────────────────
const feedContainer  = document.getElementById('feed-container');
const filterRow      = document.getElementById('filter-row');
const topbarMeta     = document.getElementById('topbar-meta');
const sectionHeading = document.getElementById('section-heading');
const videoCountEl   = document.getElementById('video-count');
const topbarSearch   = document.getElementById('topbar-search');
const sortSelect     = document.getElementById('sort-select');
const btnRefreshFeed = document.getElementById('btn-refresh-feed');
const btnManage      = document.getElementById('btn-manage');

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Check there's a selection saved
  try {
    const sel = await send({ type: 'GET_SELECTION' });
    if (!sel?.selectedChannelIds?.length) {
      showState('noSelection');
      return;
    }
    topbarMeta.innerHTML = `
      <strong>${sel.selectedChannelIds.length}</strong> channels selected`;
  } catch (e) {
    showState('error', e.message);
    return;
  }

  try {
    const prefResp = await send({ type: 'GET_PREFERENCES' });
    videoTypeFilters = { ...videoTypeFilters, ...(prefResp?.preferences?.videoTypeFilters ?? {}) };
  } catch (_) {}

  await loadFeed();
}

async function loadFeed() {
  showLoading();
  btnRefreshFeed.classList.add('loading');
  btnRefreshFeed.disabled = true;

  try {
    const resp = await send({ type: 'GET_FEED' });
    allVideos = resp.videos ?? [];

    if (!allVideos.length) {
      showState('noVideos');
    } else {
      buildPills();
      renderGrid();
    }
  } catch (err) {
    showState('error', err.message);
  } finally {
    btnRefreshFeed.classList.remove('loading');
    btnRefreshFeed.disabled = false;
  }
}

// ─── Channel filter pills ─────────────────────────────────────────────────────
function buildPills() {
  const videos = getTypeFilteredVideos(allVideos);
  // Gather unique channels in the order they first appear (newest video first)
  const seen = new Set();
  const channels = [];
  for (const v of videos) {
    if (!seen.has(v.channelId)) {
      seen.add(v.channelId);
      channels.push({ id: v.channelId, name: v.channelName, thumb: v.channelThumbnail });
    }
  }

  filterRow.innerHTML = '';
  filterRow.appendChild(makeTypeFilters());
  const label = document.createElement('span');
  label.className = 'filter-label';
  label.textContent = 'Filter:';
  filterRow.appendChild(label);

  // "All" pill
  const allPill = makePill({ id: null, name: `All (${videos.length})`, thumb: '' }, true);
  filterRow.appendChild(allPill);

  for (const ch of channels) {
    filterRow.appendChild(makePill(ch, false));
  }
}

function makeTypeFilters() {
  const wrap = document.createElement('div');
  wrap.className = 'type-filters';

  const options = [
    ['standard', 'Videos'],
    ['shorts', 'Shorts'],
    ['other', 'Other'],
  ];

  for (const [key, label] of options) {
    const row = document.createElement('label');
    row.className = 'type-check';
    row.innerHTML = `<input type="checkbox" ${videoTypeFilters[key] ? 'checked' : ''}> <span>${label}</span>`;
    const input = row.querySelector('input');
    input.addEventListener('change', async () => {
      videoTypeFilters[key] = input.checked;
      if (!Object.values(videoTypeFilters).some(Boolean)) {
        videoTypeFilters[key] = true;
        input.checked = true;
      }
      await send({ type: 'SAVE_PREFERENCES', preferences: { videoTypeFilters } });
      activeChannelFilter = null;
      buildPills();
      renderGrid();
    });
    wrap.appendChild(row);
  }

  return wrap;
}

function getTypeFilteredVideos(videos) {
  return videos.filter((video) => videoTypeFilters[video.videoType || 'standard']);
}

function makePill(ch, active) {
  const pill = document.createElement('div');
  pill.className = 'pill' + (active ? ' active' : '');
  pill.dataset.id = ch.id ?? '';
  const typeFiltered = getTypeFilteredVideos(allVideos);

  const initial = (ch.name?.[0] ?? '?').toUpperCase();
  const thumbHtml = ch.thumb
    ? `<img src="${escHtml(ch.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'"><span class="pill-avatar-fallback" style="display:none">${initial}</span>`
    : `<span class="pill-avatar-fallback">${initial}</span>`;

  const count = ch.id === null
    ? ''
    : ` (${typeFiltered.filter(v => v.channelId === ch.id).length})`;

  pill.innerHTML = `${thumbHtml}${escHtml(ch.name)}${count}`;

  pill.addEventListener('click', () => {
    activeChannelFilter = ch.id ?? null;
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    renderGrid();
  });

  return pill;
}

// ─── Video grid ───────────────────────────────────────────────────────────────
function renderGrid() {
  const typeFiltered = getTypeFilteredVideos(allVideos);
  const query    = searchQuery.toLowerCase();
  const filtered = typeFiltered.filter((v) => {
    if (activeChannelFilter && v.channelId !== activeChannelFilter) return false;
    if (query && !v.title.toLowerCase().includes(query) &&
        !v.channelName.toLowerCase().includes(query)) return false;
    return true;
  });
  const sorted = sortVideos(filtered);

  sectionHeading.style.display = 'flex';
  videoCountEl.textContent = `${sorted.length} video${sorted.length !== 1 ? 's' : ''}`;

  if (!sorted.length) {
    feedContainer.innerHTML = `
      <div class="state-center">
        <div class="state-icon">🔍</div>
        <div class="state-title">No videos match your filter</div>
        <div class="state-desc">Try a different search term or select all channels.</div>
      </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'video-grid';

  for (const v of sorted) {
    grid.appendChild(makeCard(v));
  }

  feedContainer.innerHTML = '';
  feedContainer.appendChild(grid);
}

function makeCard(v) {
  const card = document.createElement('a');
  card.className = 'video-card';
  card.href = v.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';

  const initial = (v.channelName[0] ?? '?').toUpperCase();
  const avatarHtml = v.channelThumbnail
    ? `<img class="card-avatar" src="${escHtml(v.channelThumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      + `<div class="card-avatar-placeholder" style="display:none">${initial}</div>`
    : `<div class="card-avatar-placeholder">${initial}</div>`;

  const isNew = isVeryRecent(v.publishedText);
  const newBadge = isNew ? '<div class="new-badge">New</div>' : '';
  const durBadge = v.duration ? `<div class="duration-badge">${escHtml(v.duration)}</div>` : '';

  const statsArr = [];
  if (v.viewCount) statsArr.push(escHtml(v.viewCount));
  if (v.publishedText) statsArr.push(escHtml(v.publishedText));

  card.innerHTML = `
    <div class="thumb-wrap">
      <img src="${escHtml(v.thumbnail)}" alt="${escHtml(v.title)}" loading="lazy"
           onerror="this.src='https://i.ytimg.com/vi/${escHtml(v.id)}/mqdefault.jpg'">
      ${newBadge}
      ${durBadge}
    </div>
    <div class="card-body">
      <div class="card-top">
        ${avatarHtml}
        <div class="card-meta">
          <div class="card-title">${escHtml(v.title)}</div>
          <div class="card-channel">${escHtml(v.channelName)}</div>
          ${statsArr.length ? `<div class="card-stats">${statsArr.join('<span class="dot">·</span>')}</div>` : ''}
        </div>
      </div>
    </div>`;

  return card;
}

/** Hours or less old → show "New" badge */
function isVeryRecent(text = '') {
  const t = text.toLowerCase();
  return t.includes('second') || t.includes('minute') || t.includes('hour');
}

function sortVideos(videos) {
  const list = [...videos];
  switch (sortMode) {
    case 'views':
      list.sort((a, b) =>
        (b.viewCountNum ?? 0) - (a.viewCountNum ?? 0)
        || a.ageSortKey - b.ageSortKey
      );
      break;
    case 'subscribers':
      list.sort((a, b) =>
        (b.channelSubscriberCountNum ?? 0) - (a.channelSubscriberCountNum ?? 0)
        || a.ageSortKey - b.ageSortKey
        || (b.viewCountNum ?? 0) - (a.viewCountNum ?? 0)
      );
      break;
    case 'recent':
    default:
      list.sort((a, b) => a.ageSortKey - b.ageSortKey);
      break;
  }
  return list;
}

// ─── State screens ───────────────────────────────────────────────────────────
function showLoading() {
  sectionHeading.style.display = 'none';
  feedContainer.innerHTML = `
    <div class="state-center">
      <div class="loader"></div>
      <div class="state-title">Building your curated feed…</div>
      <div class="state-desc">Fetching recent videos from your selected channels.</div>
    </div>`;
}

function showState(type, msg = '') {
  sectionHeading.style.display = 'none';
  const configs = {
    noSelection: {
      icon: '📋',
      title: 'No channels selected yet',
      desc: 'Open the extension popup, pick the channels you care about, and save your selection.',
      action: `<button class="btn-primary" id="btn-goto-popup">Open Channel Selector</button>`,
    },
    noVideos: {
      icon: '🌵',
      title: 'No new videos this week',
      desc: 'None of your selected channels posted in the past 7 days. Check back later or add more channels.',
      action: `<button class="btn-primary" id="btn-goto-popup">Manage Channels</button>`,
    },
    error: {
      icon: '⚠️',
      title: 'Something went wrong',
      desc: msg || 'An unexpected error occurred.',
      action: `<button class="btn-primary" id="btn-retry">Try Again</button>`,
    },
  };
  const c = configs[type] ?? configs.error;
  feedContainer.innerHTML = `
    <div class="state-center">
      <div class="state-icon">${c.icon}</div>
      <div class="state-title">${c.title}</div>
      <div class="state-desc">${c.desc}</div>
      ${c.action ?? ''}
    </div>`;

  document.getElementById('btn-goto-popup')?.addEventListener('click', openPopup);
  document.getElementById('btn-retry')?.addEventListener('click', loadFeed);
}

function openPopup() {
  // Can't programmatically open the action popup — open feed settings page instead
  // The user can click the extension icon in the toolbar.
  alert('Click the YT Curated Feed icon in the toolbar to manage channels.');
}

// ─── Search ───────────────────────────────────────────────────────────────────
topbarSearch.addEventListener('input', () => {
  searchQuery = topbarSearch.value.trim();
  if (allVideos.length) renderGrid();
});

sortSelect?.addEventListener('change', () => {
  sortMode = sortSelect.value;
  if (allVideos.length) renderGrid();
});

// ─── Refresh ──────────────────────────────────────────────────────────────────
btnRefreshFeed.addEventListener('click', loadFeed);

// ─── Manage channels ─────────────────────────────────────────────────────────
btnManage.addEventListener('click', () => {
  // Open extension popup — only works by clicking toolbar icon.
  // Best we can do: remind the user.
  alert('Click the YT Curated Feed icon 🟥 in your Chrome toolbar to manage channels.');
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Kick off ────────────────────────────────────────────────────────────────
init();
