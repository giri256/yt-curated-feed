(function () {
  'use strict';

  const TICK_MS = 5000;
  const STATUS_REFRESH_MS = 15 * 1000;
  let activeSince = null;
  let lastStatusCheck = 0;

  const send = (message) => new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (response?.error) reject(new Error(response.error));
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });

  function getPrimaryVideo() {
    if (location.pathname !== '/watch' && !location.pathname.startsWith('/shorts/')) return null;
    return document.querySelector('video.html5-main-video');
  }

  function isActivelyWatching(video) {
    return Boolean(
      video
      && !document.hidden
      && !video.paused
      && !video.ended
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
  }

  function removeBlocker() {
    document.getElementById('ytcf-time-blocker')?.remove();
  }

  function showBlocker(stats) {
    getPrimaryVideo()?.pause();
    let host = document.getElementById('ytcf-time-blocker');
    if (host) return;

    host = document.createElement('div');
    host.id = 'ytcf-time-blocker';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }
        .backdrop {
          width: 100%; height: 100%; display: grid; place-items: center;
          background: rgba(10,10,10,.97); color: #f1f1f1;
          font-family: "Segoe UI", system-ui, sans-serif;
        }
        .card { width: min(440px, calc(100vw - 32px)); text-align: center; }
        .badge { display: block; width: 40px; height: 40px; }
        h1 { margin: 18px 0 10px; font-size: 25px; }
        p { margin: 0 0 20px; color: #aaa; font-size: 14px; line-height: 1.55; }
        button {
          border: 1px solid #444; border-radius: 8px; padding: 10px 16px;
          background: #222; color: #f1f1f1; font: inherit; cursor: pointer;
        }
      </style>
      <div class="backdrop">
        <div class="card">
          <img class="badge" src="${chrome.runtime.getURL('icons/icon48.png')}" alt="" />
          <h1>Daily YouTube limit reached</h1>
          <p>
            You have used your ${Number(stats.dailyLimitMinutes) || 0}-minute allowance today.
            Access resets automatically at local midnight.
          </p>
          <button id="manage-limit">View stats or change limit</button>
        </div>
      </div>`;
    shadow.getElementById('manage-limit').addEventListener('click', () => {
      window.open(chrome.runtime.getURL('src/stats.html'), '_blank', 'noopener');
    });
    document.documentElement.appendChild(host);
  }

  function applyStatus(stats) {
    if (stats?.blocked) showBlocker(stats);
    else removeBlocker();
  }

  async function submitDelta(seconds) {
    if (seconds <= 0) return;
    try {
      const response = await send({ type: 'WATCH_TIME_DELTA', seconds });
      applyStatus(response?.stats);
    } catch (_) {}
  }

  function flushActive() {
    if (activeSince == null) return;
    const seconds = Math.min(15, Math.max(0, (performance.now() - activeSince) / 1000));
    activeSince = null;
    void submitDelta(seconds);
  }

  async function tick() {
    const video = getPrimaryVideo();
    if (isActivelyWatching(video)) {
      if (activeSince == null) activeSince = performance.now();
      else {
        const seconds = Math.min(15, (performance.now() - activeSince) / 1000);
        activeSince = performance.now();
        await submitDelta(seconds);
      }
    } else {
      flushActive();
    }

    if ((Date.now() - lastStatusCheck) >= STATUS_REFRESH_MS) {
      lastStatusCheck = Date.now();
      try {
        const response = await send({ type: 'GET_WATCH_STATS' });
        applyStatus(response?.stats);
      } catch (_) {}
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushActive();
  });
  window.addEventListener('pagehide', flushActive);
  window.addEventListener('yt-navigate-start', flushActive);
  window.addEventListener('yt-navigate-finish', () => {
    activeSince = null;
    lastStatusCheck = 0;
    void tick();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'WATCH_STATUS_UPDATED') applyStatus(message.stats);
  });

  void tick();
  setInterval(() => void tick(), TICK_MS);
})();
