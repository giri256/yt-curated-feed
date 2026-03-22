/**
 * content.js
 * Injected on the YouTube homepage (youtube.com/).
 *
 * Behaviour:
 *  1. Waits for the YT home feed DOM to stabilise.
 *  2. Hides YouTube's algorithm-driven recommendation grid.
 *  3. Injects a full-width curated-feed panel that fetches and renders the
 *     user's curated videos directly inside the YouTube page.
 *  4. Falls back gracefully when no channels are selected yet.
 */

(function () {
  'use strict';

  // Only run on the actual homepage path
  if (location.pathname !== '/') return;

  // ─── Helpers ───────────────────────────────────────────────────────────────
  const send = (msg) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (resp?.error) reject(new Error(resp.error));
        else resolve(resp);
      });
    });

  function escHtml(str = '') {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let sortMode = 'recent';
  let videoTypeFilters = { standard: true, shorts: true, other: true };

  // ─── Wait for ytd-browse to appear ────────────────────────────────────────
  function waitFor(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const obs = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { obs.disconnect(); resolve(found); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); reject(new Error('Timeout waiting for ' + selector)); }, timeout);
    });
  }

  // ─── Build the injected panel (Shadow DOM so YT CSS can't pollute it) ─────
  function createPanel() {
    const host = document.createElement('div');
    host.id = 'ytcf-host';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host { display: block; font-family: 'Segoe UI', system-ui, sans-serif; }

        .panel {
          background: #0f0f0f;
          border-radius: 12px;
          border: 1px solid #2e2e2e;
          overflow: hidden;
          margin-bottom: 24px;
        }

        .panel-header {
          display: flex; align-items: center; gap: 10px;
          padding: 14px 18px;
          border-bottom: 1px solid #2e2e2e;
          background: #141414;
        }
        .panel-logo {
          background: #ff0000; color: #fff;
          border-radius: 5px; padding: 3px 7px;
          font-size: 11px; font-weight: 900;
        }
        .panel-title {
          font-size: 14px; font-weight: 700; color: #f1f1f1;
          flex: 1;
        }
        .panel-sub { font-size: 11px; color: #aaa; }
        .btn-open {
          background: #ff0000; color: #fff; border: none;
          border-radius: 6px; padding: 6px 14px;
          font-size: 12px; font-weight: 700; cursor: pointer;
        }
        .btn-open:hover { background: #ff4444; }
        .btn-open-page {
          background: transparent; color: #aaa;
          border: 1px solid #333; border-radius: 6px;
          padding: 6px 12px; font-size: 12px;
          cursor: pointer; margin-left: 6px;
        }
        .btn-open-page:hover { color: #f1f1f1; border-color: #555; }

        .loading-wrap {
          display: flex; align-items: center; gap: 12px;
          padding: 20px 18px; color: #aaa; font-size: 13px;
        }
        .spinner {
          width: 18px; height: 18px; flex-shrink: 0;
          border: 2px solid #333; border-top-color: #ff0000;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .msg-center {
          padding: 28px 20px; text-align: center;
          color: #aaa; font-size: 13px; line-height: 1.5;
        }
        .msg-center strong { color: #f1f1f1; display: block; margin-bottom: 6px; font-size: 14px; }
        .msg-center a { color: #ff4444; text-decoration: none; }

        /* Search / filter row */
        .toolbar {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 18px;
          border-bottom: 1px solid #1e1e1e;
          background: #0d0d0d;
        }
        .toolbar-search {
          flex: 1; background: #1e1e1e; border: 1px solid #2e2e2e;
          border-radius: 20px; padding: 6px 14px 6px 32px;
          color: #f1f1f1; font-size: 12px; outline: none;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23aaa' stroke-width='2.5'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: 10px center;
        }
        .toolbar-search::placeholder { color: #666; }
        .toolbar-search:focus { border-color: #444; }
        .toolbar-sort {
          background: #1e1e1e; border: 1px solid #2e2e2e;
          border-radius: 18px; padding: 6px 28px 6px 10px;
          color: #f1f1f1; font-size: 12px; outline: none; cursor: pointer;
        }
        .toolbar-sort:focus { border-color: #444; }
        .type-filters {
          display: inline-flex; align-items: center; gap: 10px;
          padding-right: 10px; margin-right: 4px; border-right: 1px solid #2e2e2e;
        }
        .type-check {
          display: inline-flex; align-items: center; gap: 5px;
          color: #aaa; font-size: 11px; white-space: nowrap;
        }
        .type-check input { width: 13px; height: 13px; accent-color: #ff0000; }
        .video-count { font-size: 11px; color: #666; white-space: nowrap; }

        /* Video grid */
        .grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 14px;
          padding: 16px 18px;
        }

        .card {
          border-radius: 8px; overflow: hidden;
          background: #1a1a1a; cursor: pointer;
          text-decoration: none; color: inherit;
          display: block;
          transition: transform 0.12s, box-shadow 0.12s;
        }
        .card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }

        .card-thumb {
          position: relative; aspect-ratio: 16/9;
          background: #222; overflow: hidden;
        }
        .card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.15s; }
        .card:hover .card-thumb img { transform: scale(1.04); }
        .dur { position: absolute; bottom: 5px; right: 5px;
          background: rgba(0,0,0,0.85); color: #fff;
          font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 3px; }
        .new-badge { position: absolute; top: 5px; left: 5px;
          background: #ff0000; color: #fff;
          font-size: 8px; font-weight: 800; padding: 2px 5px; border-radius: 3px;
          text-transform: uppercase; }

        .card-body { padding: 10px; }
        .card-row { display: flex; gap: 8px; }
        .card-av { width: 28px; height: 28px; border-radius: 50%; object-fit: cover;
          flex-shrink: 0; background: #333; }
        .card-av-ph { width: 28px; height: 28px; border-radius: 50%;
          background: #333; display: flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 700; color: #aaa; flex-shrink: 0; }
        .card-info { flex: 1; min-width: 0; }
        .card-title {
          font-size: 12px; font-weight: 600; color: #f1f1f1; line-height: 1.35;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .card-ch { font-size: 10px; color: #aaa; margin-top: 3px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-meta { font-size: 10px; color: #666; margin-top: 2px; }

        /* Show-more button */
        .show-more-wrap { padding: 0 18px 16px; }
        .btn-show-more {
          width: 100%; background: #1a1a1a; border: 1px solid #2e2e2e;
          color: #aaa; border-radius: 8px; padding: 9px;
          font-size: 12px; cursor: pointer;
        }
        .btn-show-more:hover { background: #222; color: #f1f1f1; }
      </style>

      <div class="panel" id="panel">
        <div class="panel-header">
          <span class="panel-logo">YT</span>
          <span class="panel-title">Curated Feed</span>
          <span class="panel-sub" id="hdr-sub">your selected channels · past 7 days</span>
          <button class="btn-open-page" id="btn-full-page">Full Page ↗</button>
        </div>
        <div class="loading-wrap" id="loading">
          <div class="spinner"></div>
          Loading your curated feed…
        </div>
        <div id="content-area"></div>
      </div>
    `;

    return { host, shadow };
  }

  // ─── Render videos into the shadow panel ───────────────────────────────────
  function renderVideos(shadow, videos, showLimit = 12) {
    const area   = shadow.getElementById('content-area');
    const hdrSub = shadow.getElementById('hdr-sub');
    const loading = shadow.getElementById('loading');

    loading.style.display = 'none';

    if (!videos.length) {
      area.innerHTML = `
        <div class="msg-center">
          <strong>No new videos this week</strong>
          None of your selected channels posted in the past 7 days.
        </div>`;
      hdrSub.textContent = 'no new videos this week';
      return;
    }

    // Build toolbar + grid
    area.innerHTML = `
      <div class="toolbar">
        <input class="toolbar-search" id="cs-search" type="text" placeholder="Search videos…" autocomplete="off"/>
        <div class="type-filters">
          <label class="type-check"><input type="checkbox" id="cs-type-standard" checked> <span>Videos</span></label>
          <label class="type-check"><input type="checkbox" id="cs-type-shorts" checked> <span>Shorts</span></label>
          <label class="type-check"><input type="checkbox" id="cs-type-other" checked> <span>Other</span></label>
        </div>
        <select class="toolbar-sort" id="cs-sort" aria-label="Sort videos">
          <option value="recent">Most Recent</option>
          <option value="views">Most Views</option>
          <option value="subscribers">Biggest Channels</option>
        </select>
        <div class="video-count" id="cs-count">${videos.length} video${videos.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="grid" id="cs-grid"></div>
      <div class="show-more-wrap" id="show-more-wrap" style="display:none">
        <button class="btn-show-more" id="btn-show-more">Show more videos</button>
      </div>`;

    hdrSub.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''} · past 7 days`;

    let displayCount = showLimit;
    let query = '';

    function filtered() {
      const list = videos.filter((video) => videoTypeFilters[video.videoType || 'standard']);
      const searched = query
        ? videos.filter(v =>
            v.title.toLowerCase().includes(query) ||
            v.channelName.toLowerCase().includes(query))
        : list;

      return sortVideos(query ? searched.filter((video) => videoTypeFilters[video.videoType || 'standard']) : searched);
    }

    function renderCards() {
      const grid      = shadow.getElementById('cs-grid');
      const showMore  = shadow.getElementById('show-more-wrap');
      const countEl   = shadow.getElementById('cs-count');
      const list      = filtered();
      const visible   = list.slice(0, displayCount);

      countEl.textContent = `${list.length} video${list.length !== 1 ? 's' : ''}`;

      grid.innerHTML = '';
      for (const v of visible) {
        const card = document.createElement('a');
        card.className = 'card';
        card.href      = v.url;
        card.target    = '_blank';
        card.rel       = 'noopener noreferrer';

        const initial   = (v.channelName[0] ?? '?').toUpperCase();
        const avatarHtml = v.channelThumbnail
          ? `<img class="card-av" src="${escHtml(v.channelThumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
             <div class="card-av-ph" style="display:none">${initial}</div>`
          : `<div class="card-av-ph">${initial}</div>`;

        const isNew = /(second|minute|hour)/.test(v.publishedText);
        const metaParts = [v.viewCount, v.publishedText].filter(Boolean);

        card.innerHTML = `
          <div class="card-thumb">
            <img src="${escHtml(v.thumbnail)}" alt="${escHtml(v.title)}" loading="lazy"
                 onerror="this.src='https://i.ytimg.com/vi/${escHtml(v.id)}/mqdefault.jpg'">
            ${isNew ? '<div class="new-badge">New</div>' : ''}
            ${v.duration ? `<div class="dur">${escHtml(v.duration)}</div>` : ''}
          </div>
          <div class="card-body">
            <div class="card-row">
              ${avatarHtml}
              <div class="card-info">
                <div class="card-title">${escHtml(v.title)}</div>
                <div class="card-ch">${escHtml(v.channelName)}</div>
                ${metaParts.length ? `<div class="card-meta">${metaParts.map(escHtml).join(' · ')}</div>` : ''}
              </div>
            </div>
          </div>`;

        grid.appendChild(card);
      }

      showMore.style.display = list.length > displayCount ? 'block' : 'none';
    }

    shadow.getElementById('cs-search').addEventListener('input', (e) => {
      query = e.target.value.trim().toLowerCase();
      displayCount = showLimit;
      renderCards();
    });

    shadow.getElementById('cs-sort').addEventListener('change', (e) => {
      sortMode = e.target.value;
      displayCount = showLimit;
      renderCards();
    });

    for (const [key, id] of [['standard', 'cs-type-standard'], ['shorts', 'cs-type-shorts'], ['other', 'cs-type-other']]) {
      const input = shadow.getElementById(id);
      input.checked = Boolean(videoTypeFilters[key]);
      input.addEventListener('change', async () => {
        videoTypeFilters[key] = input.checked;
        if (!Object.values(videoTypeFilters).some(Boolean)) {
          videoTypeFilters[key] = true;
          input.checked = true;
        }
        try {
          await send({ type: 'SAVE_PREFERENCES', preferences: { videoTypeFilters } });
        } catch (_) {}
        displayCount = showLimit;
        renderCards();
      });
    }

    shadow.getElementById('btn-show-more')?.addEventListener('click', () => {
      displayCount += showLimit;
      renderCards();
    });

    renderCards();
  }

  // ─── Main injection logic ─────────────────────────────────────────────────
  async function inject() {
    // Wait for the primary inner-app-layout so we know where to insert
    let primaryEl;
    try {
      primaryEl = await waitFor('ytd-browse[page-subtype="home"]', 8000);
    } catch (_) {
      return; // Not on home page or page timed out
    }

    // Guard: only inject once
    if (document.getElementById('ytcf-host')) return;

    const { host, shadow } = createPanel();

    // Insert BEFORE the ytd-browse element
    primaryEl.parentNode.insertBefore(host, primaryEl);

    // Set up full-page link
    shadow.getElementById('btn-full-page').addEventListener('click', () => {
      const feedUrl = chrome.runtime.getURL('src/feed.html');
      window.open(feedUrl, '_blank');
    });

    // Check if user has a selection
    let hasSelection = false;
    try {
      const sel = await send({ type: 'GET_SELECTION' });
      hasSelection = (sel?.selectedChannelIds?.length ?? 0) > 0;
    } catch (_) {}

    try {
      const prefResp = await send({ type: 'GET_PREFERENCES' });
      videoTypeFilters = { ...videoTypeFilters, ...(prefResp?.preferences?.videoTypeFilters ?? {}) };
    } catch (_) {}

    if (!hasSelection) {
      shadow.getElementById('loading').style.display = 'none';
      shadow.getElementById('content-area').innerHTML = `
        <div class="msg-center">
          <strong>Set up your curated feed</strong>
          Click the <b>YT Curated Feed</b> extension icon in your toolbar,
          select the channels you want to follow, then save.
          Your curated feed will appear here.
        </div>`;
      return;
    }

    // Fetch feed from background
    try {
      const resp = await send({ type: 'GET_FEED' });
      const videos = resp.videos ?? [];
      renderVideos(shadow, videos);
    } catch (err) {
      shadow.getElementById('loading').style.display = 'none';
      shadow.getElementById('content-area').innerHTML = `
        <div class="msg-center">
          <strong>Error loading feed</strong>
          ${escHtml(err.message)}
        </div>`;
    }
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

  function removePanel() {
    document.getElementById('ytcf-host')?.remove();
  }

  // ─── Handle YouTube's SPA navigation ─────────────────────────────────────
  // YouTube is a SPA; keep the panel only on the real homepage route.
  let lastUrl = location.href;

  function handleRouteChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    if (location.pathname === '/') {
      setTimeout(() => {
        if (location.pathname === '/' && !document.getElementById('ytcf-host')) inject();
      }, 800);
    } else {
      removePanel();
    }
  }

  const navObs = new MutationObserver(handleRouteChange);
  navObs.observe(document.documentElement, { childList: true, subtree: true });

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    handleRouteChange();
    return result;
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    handleRouteChange();
    return result;
  };

  window.addEventListener('popstate', handleRouteChange);
  window.addEventListener('yt-navigate-start', handleRouteChange);
  window.addEventListener('yt-navigate-finish', handleRouteChange);

  // ─── Initial injection ────────────────────────────────────────────────────
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }
})();
