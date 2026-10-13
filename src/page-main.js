/**
 * page-main.js — runs in YouTube's MAIN world (manifest "world": "MAIN").
 *
 * Isolated content scripts cannot call YouTube's own element methods or the
 * player API, so the few features that need them live here:
 *  - Hide live chat: collapse chat through YouTube's own show/hide handler.
 *    Hiding the frame with CSS alone leaves YouTube's layout reserving the
 *    chat column (measured 2026-10-12: player stuck at 1153px of 1600px with
 *    a dead strip); a real collapse lets the player take the full width.
 *  - Disable autoplay: click YouTube's own autoplay toggle off.
 *  - Pin video quality: closest available level to the chosen one, applied
 *    per video, standing down once the user picks a quality by hand.
 *    Approach adapted from YouTube Enhancer's playerQuality feature
 *    (https://github.com/YouTube-Enhancer/extension, MIT).
 *
 * Settings arrive as data attributes on <html>, written by focus.js:
 *   data-ytcf-hide-chat="1", data-ytcf-no-autoplay="1", data-ytcf-quality="hd1080"
 */
(() => {
  'use strict';

  const root = document.documentElement;
  root.setAttribute('data-ytcf-main', '1');
  const QUALITY_ORDER = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'hd2880', 'highres'];
  const RETRY_MS = 500;
  const MAX_TRIES = 40;

  const quality = { videoId: null, requested: null, userOverride: false };
  let tries = 0;
  let timer = null;
  let playerWithListener = null;

  const setting = (name) => root.getAttribute(`data-ytcf-${name}`) || '';

  function currentVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get('v')
      || url.pathname.match(/^\/(?:shorts|live)\/([\w-]{6,})/)?.[1]
      || null;
  }

  function getPlayer() {
    return document.querySelector(location.pathname.startsWith('/shorts/') ? '#shorts-player' : '#movie_player');
  }

  // Highest available level not above the target; otherwise the lowest one
  // available (a video that only exists above the target).
  function closestQuality(target, levels) {
    const targetIndex = QUALITY_ORDER.indexOf(target);
    const ranked = levels
      .map((level) => ({ level, index: QUALITY_ORDER.indexOf(level) }))
      .filter((entry) => entry.index >= 0)
      .sort((a, b) => b.index - a.index);
    if (!ranked.length) return null;
    return (ranked.find((entry) => entry.index <= targetIndex) ?? ranked[ranked.length - 1]).level;
  }

  // YouTube's toggles act asynchronously; poking one again before the last
  // poke lands flips it straight back. Each toggle is poked at most once per
  // ACTION_SETTLE_MS and the tasks then just wait for the state to show.
  const ACTION_SETTLE_MS = 2500;
  const lastAction = new Map();

  function actOnce(name, action) {
    const last = lastAction.get(name) ?? 0;
    if (Date.now() - last < ACTION_SETTLE_MS) return;
    lastAction.set(name, Date.now());
    action();
  }

  function collapseChat() {
    if (setting('hide-chat') !== '1') return true;
    const frame = document.querySelector('ytd-live-chat-frame#chat');
    const expanded = document.querySelector('ytd-watch-flexy[live-chat-present-and-expanded]');
    if (!frame) return !expanded;
    if (frame.collapsed && !expanded) return true;
    if (typeof frame.onShowHideChat === 'function') actOnce('chat', () => frame.onShowHideChat());
    return false;
  }

  // player.setAutonav(false) does not change YouTube's autoplay toggle
  // (verified 2026-10-12); clicking the toggle does, and YouTube remembers it.
  function disableAutoplay() {
    if (setting('no-autoplay') !== '1') return true;
    if (!location.pathname.startsWith('/watch')) return true;
    const state = document.querySelector('.ytp-autonav-toggle-button')?.getAttribute('aria-checked');
    if (state === 'false') return true;
    const toggle = document.querySelector('.ytp-autonav-toggle');
    if (state === 'true' && toggle) actOnce('autonav', () => toggle.click());
    return false;
  }

  function pinQuality() {
    const target = setting('quality');
    if (!target || target === 'auto') return true;
    const player = getPlayer();
    // /@channel/live keeps its URL while playing the channel's stream.
    const videoId = currentVideoId()
      || (/\/live\/?$/.test(location.pathname) ? player?.getVideoData?.()?.video_id : null);
    if (!videoId) return !/\/live\/?$/.test(location.pathname);
    if (typeof player?.setPlaybackQualityRange !== 'function' || typeof player.getAvailableQualityLevels !== 'function') return false;
    // During an ad the player answers for the ad; wait for the content.
    if (document.querySelector('.ad-showing')) return false;
    if (player.getVideoData?.()?.video_id !== videoId) return false;

    if (quality.videoId !== videoId) {
      quality.videoId = videoId;
      quality.requested = null;
      quality.userOverride = false;
    }
    if (quality.userOverride) return true;

    const preferred = player.getPreferredQuality?.();
    if (quality.requested && preferred && preferred !== 'auto' && preferred !== quality.requested) {
      quality.userOverride = true; // picked by hand in the quality menu
      return true;
    }

    const levels = (player.getAvailableQualityLevels() ?? []).filter((level) => level !== 'auto');
    if (!levels.length) return false;
    const chosen = closestQuality(target, levels);
    if (!chosen) return true;

    if (player.getPlaybackQuality?.() !== chosen || quality.requested !== chosen) {
      player.setPlaybackQualityRange(chosen, chosen);
      player.setPlaybackQuality?.(chosen);
      const requested = player.getPreferredQuality?.();
      quality.requested = requested && requested !== 'auto' ? requested : chosen;
    }
    return player.getPlaybackQuality?.() === chosen;
  }

  // Chat is stamped seconds after navigation finishes, often after every task
  // already reported done; watching the watch page's chat attributes re-runs
  // the tasks when it appears.
  let observedFlexy = null;
  const flexyObserver = new MutationObserver(kick);

  function observeWatchFlexy() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy || flexy === observedFlexy) return;
    flexyObserver.disconnect();
    flexyObserver.observe(flexy, {
      attributes: true,
      attributeFilter: ['should-stamp-chat', 'live-chat-present-and-expanded', 'video-id'],
    });
    observedFlexy = flexy;
  }

  function attachPlayerListener() {
    const player = getPlayer();
    if (!player || player === playerWithListener || typeof player.addEventListener !== 'function') return;
    player.addEventListener('onStateChange', kick);
    playerWithListener = player;
  }

  function runTasks() {
    timer = null;
    attachPlayerListener();
    observeWatchFlexy();
    let done = true;
    for (const task of [collapseChat, disableAutoplay, pinQuality]) {
      try {
        if (!task()) done = false;
      } catch (_) {
        done = false;
      }
    }
    if (!done && ++tries < MAX_TRIES) timer = setTimeout(runTasks, RETRY_MS);
  }

  function kick() {
    tries = 0;
    if (!timer) timer = setTimeout(runTasks, 0);
  }

  for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'yt-player-updated']) {
    document.addEventListener(event, kick);
  }
  new MutationObserver(kick).observe(root, {
    attributes: true,
    attributeFilter: ['data-ytcf-hide-chat', 'data-ytcf-no-autoplay', 'data-ytcf-quality'],
  });
  kick();
})();
