/**
 * focus.js — runs at document_start on every youtube.com page.
 *
 * Turns the saved focus preferences into classes on <html> (focus.css does
 * the hiding) and data attributes read by page-main.js (live chat, autoplay,
 * quality). Reads chrome.storage directly instead of messaging the worker so
 * the classes land before YouTube paints, and follows storage changes so
 * popup toggles apply to open tabs immediately.
 */
(() => {
  'use strict';

  // Mirrors DEFAULT_PREFERENCES.focus in background.js (a test keeps them equal).
  const FOCUS_DEFAULTS = {
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
  };

  const root = document.documentElement;
  let focus = { ...FOCUS_DEFAULTS };

  function toClassName(key) {
    return `ytcf-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  }

  function redirectShorts() {
    if (!focus.hideShorts) return;
    const id = location.pathname.match(/^\/shorts\/([\w-]{6,})/)?.[1];
    if (id) location.replace(`/watch?v=${id}`);
  }

  function apply(preferences = {}) {
    focus = { ...FOCUS_DEFAULTS, ...(preferences.focus ?? {}) };
    for (const key of Object.keys(FOCUS_DEFAULTS)) {
      root.classList.toggle(toClassName(key), Boolean(focus[key]));
    }
    root.setAttribute('data-ytcf-hide-chat', focus.hideLiveChat ? '1' : '0');
    root.setAttribute('data-ytcf-no-autoplay', focus.disableAutoplay ? '1' : '0');
    root.setAttribute('data-ytcf-quality', preferences.preferredQuality || 'auto');
    redirectShorts();
  }

  chrome.storage.local.get('preferences', (result) => apply(result?.preferences ?? {}));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.preferences) apply(changes.preferences.newValue ?? {});
  });
  document.addEventListener('yt-navigate-finish', redirectShorts);
})();
