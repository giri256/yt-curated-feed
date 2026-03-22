/**
 * channels-scraper.js
 * Content script injected on https://www.youtube.com/feed/channels
 *
 * Strategy:
 *  1. Wait for the channel grid to appear in the DOM.
 *  2. Incrementally scroll to the bottom, pausing between scrolls so
 *     YouTube's infinite-scroll can fire and render new items.
 *  3. After each scroll settle, extract new ytd-channel-renderer elements.
 *  4. When two consecutive scroll attempts add no new channels we consider
 *     the list complete.
 *  5. Post { type: 'CHANNELS_READY', channels } to the background SW.
 *
 * Channel ID extraction priority:
 *  a) Polymer internal data  (.data.channelId  — fastest, most reliable)
 *  b) href="/channel/UCxxxx" — direct UC ID from anchor
 *  c) href="/@handle"        — stored as "@handle"; background resolves to UC ID
 *     via a lightweight fetch of the channel page.
 */

(function () {
  'use strict';

  // Only run on the channels feed page
  if (!location.pathname.startsWith('/feed/channels')) return;

  // ── Avoid double-injection on SPA navigations ──────────────────────────
  if (window.__ytcfScraperRunning) return;
  window.__ytcfScraperRunning = true;

  // ── Constants ──────────────────────────────────────────────────────────
  const SCROLL_PAUSE_MS  = 1200;  // ms to wait after each scroll
  const MAX_SAME_COUNT   = 3;     // consecutive unchanged counts before stopping
  const PROGRESS_EVERY   = 10;    // send progress update every N new channels

  // ── State ──────────────────────────────────────────────────────────────
  const collected = new Map(); // channelId → channel object
  let   sameCount = 0;

  // ── Utilities ──────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Pull the best available text from a YT text-node shape:
   * { simpleText } | { runs: [{text}] } | plain string
   */
  function extractText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (node.simpleText) return node.simpleText;
    if (Array.isArray(node.runs)) return node.runs.map((r) => r.text ?? '').join('');
    return String(node);
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

  function normalizeThumbUrl(url = '') {
    let normalized = normalizeText(url);
    if (!normalized || normalized.startsWith('data:')) return '';
    if (normalized.startsWith('//')) normalized = `https:${normalized}`;
    return normalized.replace(/\\u0026/g, '&');
  }

  function getUrlFromSrcSet(srcset = '') {
    const first = normalizeText(srcset).split(',')[0]?.trim() ?? '';
    return first.split(/\s+/)[0] ?? '';
  }

  function getImageUrl(img) {
    if (!img) return '';

    return normalizeThumbUrl(
      img.currentSrc
      || img.src
      || img.getAttribute('src')
      || img.getAttribute('data-thumb')
      || img.getAttribute('data-src')
      || getUrlFromSrcSet(img.srcset || img.getAttribute('srcset') || '')
    );
  }

  function extractChannelIdFromMarkup(markup = '') {
    if (!markup) return '';

    const patterns = [
      /\/channel\/(UC[\w-]{20,})/i,
      /"channelId"\s*:\s*"(UC[\w-]{20,})"/i,
      /"browseId"\s*:\s*"(UC[\w-]{20,})"/i,
      /"externalId"\s*:\s*"(UC[\w-]{20,})"/i,
      /channel-id="(UC[\w-]{20,})"/i,
      /browse-id="(UC[\w-]{20,})"/i,
    ];

    for (const pattern of patterns) {
      const match = markup.match(pattern);
      if (match?.[1]) return match[1];
    }

    return '';
  }

  function extractHandleFromMarkup(markup = '') {
    const match = markup.match(/\/@([\w.-]+)/i);
    return match?.[1] ? `@${match[1]}` : '';
  }

  function getChannelIdFromData(data) {
    if (!data || typeof data !== 'object') return '';

    const seen = new WeakSet();
    const queue = [{ value: data, depth: 0 }];

    while (queue.length) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object') continue;
      if (seen.has(value)) continue;
      seen.add(value);

      if (typeof value.channelId === 'string' && /^UC[\w-]{20,}$/.test(value.channelId)) {
        return value.channelId;
      }
      if (typeof value.browseId === 'string' && /^UC[\w-]{20,}$/.test(value.browseId)) {
        return value.browseId;
      }
      if (typeof value.externalId === 'string' && /^UC[\w-]{20,}$/.test(value.externalId)) {
        return value.externalId;
      }

      if (depth >= 4) continue;

      const children = Array.isArray(value) ? value : Object.values(value);
      for (const child of children) {
        if (child && typeof child === 'object') {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }

    return '';
  }

  function getPreferredAnchor(el) {
    const anchors = Array.from(el.querySelectorAll('a[href]'));

    const byUcId = anchors.find((anchor) => /\/channel\/UC[\w-]{20,}/i.test(anchor.href || anchor.getAttribute('href') || ''));
    if (byUcId) return byUcId;

    const byHandle = anchors.find((anchor) => /\/@[\w.-]+/i.test(anchor.href || anchor.getAttribute('href') || ''));
    if (byHandle) return byHandle;

    return anchors[0] ?? null;
  }

  function getCleanAnchorText(anchor) {
    if (!anchor) return '';

    return cleanChannelName(
      anchor.getAttribute('title')
      || anchor.getAttribute('aria-label')
      || anchor.textContent
      || ''
    );
  }

  /** Pick the best-quality thumbnail URL from a thumbnails array. */
  function bestThumb(thumbs = []) {
    if (!thumbs.length) return '';
    const sorted = [...thumbs].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
    // prefer ~88-240px avatar
    const pick = sorted.find((t) => (t.width ?? 999) >= 88) ?? sorted.at(-1);
    let url = pick?.url ?? '';
    if (url.startsWith('//')) url = 'https:' + url;
    // Strip size params so we can request a fixed size later if needed
    return normalizeThumbUrl(url.replace(/=s\d+-c/, '=s88-c'));
  }

  /**
   * Try to extract a channel object from a single ytd-channel-renderer element.
   * Returns null if we can't determine a channel ID.
   */
  function extractFromRenderer(el) {
    // ── Method A: Polymer internal data ──
    // YouTube's web components store parsed API data on the element itself.
    // This is the most reliable source as it contains structured fields.
    const polyData = el.data              // LitElement style
      ?? el.__dataHost?.data             // some Polymer versions
      ?? el.__dataHost?.__data
      ?? el.__data;                      // older Polymer

    if (polyData) {
      const channelId = getChannelIdFromData(polyData);

      if (channelId) {
        return {
          id:              channelId,
          name:            cleanChannelName(extractText(polyData.title)) || '—',
          thumbnail:       bestThumb(polyData.thumbnail?.thumbnails),
          subscriberCount: extractText(polyData.subscriberCountText) || extractText(polyData.videoCountText) || '',
          handle:          cleanHandle(extractText(polyData.shortBylineText)),
        };
      }
    }

    // ── Method B: DOM parsing ──
    const anchor =
      getPreferredAnchor(el)
      ?? el.querySelector('a#channel-title')
      ?? el.querySelector('a#main-link')
      ?? el.querySelector('a[href*="/channel/"]')
      ?? el.querySelector('a[href*="/@"]');

    if (!anchor) return null;

    const href = anchor.href || anchor.getAttribute('href') || '';
    const titleEl =
      el.querySelector('#channel-title')
      ?? el.querySelector('yt-formatted-string#channel-title')
      ?? el.querySelector('.channel-name')
      ?? anchor;
    const name = cleanChannelName(
      titleEl?.getAttribute?.('title')
      ?? titleEl?.getAttribute?.('aria-label')
      ?? titleEl?.textContent
      ?? getCleanAnchorText(anchor)
    );

    const img = el.querySelector('yt-img-shadow img')
      ?? el.querySelector('#channel-thumbnail img')
      ?? el.querySelector('img');
    const thumbnail = getImageUrl(img);

    const subEl = el.querySelector('#subscribers') ?? el.querySelector('#video-count');
    const subscriberCount = subEl?.textContent?.trim() || '';

    // Extract channel ID from URL
    const ucMatch     = href.match(/\/channel\/(UC[\w-]+)/);
    const handleMatch = href.match(/\/@([\w.-]+)/);
    const markup = el.outerHTML || '';
    const markupChannelId = extractChannelIdFromMarkup(markup);
    const markupHandle = extractHandleFromMarkup(markup);

    if (ucMatch?.[1]) {
      return { id: ucMatch[1], name, thumbnail, subscriberCount, handle: markupHandle || '' };
    }
    if (markupChannelId) {
      return { id: markupChannelId, name, thumbnail, subscriberCount, handle: markupHandle || '' };
    }
    if (handleMatch?.[1]) {
      // Prefix '@' so background knows this needs resolution
      return { id: '@' + handleMatch[1], name, thumbnail, subscriberCount, handle: '@' + handleMatch[1] };
    }
    if (markupHandle) {
      return { id: markupHandle, name, thumbnail, subscriberCount, handle: markupHandle };
    }

    return null;
  }

  /** Scan the entire DOM for channel renderers and add new ones to `collected`. */
  function harvestRenderers() {
    const before = collected.size;
    const renderers = document.querySelectorAll('ytd-channel-renderer');

    for (const el of renderers) {
      const ch = extractFromRenderer(el);
      if (ch && ch.id && !collected.has(ch.id)) {
        collected.set(ch.id, ch);
      }
    }

    return collected.size - before; // how many new channels were added
  }

  /** Send a progress update to the background (non-blocking). */
  function sendProgress() {
    try {
      chrome.runtime.sendMessage({
        type:     'CHANNELS_PROGRESS',
        count:    collected.size,
        channels: [...collected.values()],
      });
    } catch (_) {}
  }

  /** Send the final result to the background. */
  function sendComplete() {
    try {
      chrome.runtime.sendMessage({
        type:     'CHANNELS_READY',
        channels: [...collected.values()],
      });
    } catch (_) {}
  }

  // ── Listen for a "start scraping" trigger from the popup/background ────
  // We start automatically on load, but also accept an explicit trigger.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCRAPE_NOW') {
      // Already running or about to run — just acknowledge
      sendResponse({ started: true });
    }
    if (msg.type === 'GET_SCRAPED_CHANNELS') {
      sendResponse({ channels: [...collected.values()], done: sameCount >= MAX_SAME_COUNT });
    }
  });

  // ── Show a subtle banner on the page so the user knows what's happening ─
  function showBanner() {
    if (document.getElementById('ytcf-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'ytcf-banner';
    banner.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 9999;
      background: #1a1a1a; border: 1px solid #333; border-left: 3px solid #ff0000;
      border-radius: 8px; padding: 10px 14px;
      font-family: system-ui, sans-serif; font-size: 12px; color: #f1f1f1;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
      display: flex; align-items: center; gap: 8px;
      max-width: 260px;
    `;
    banner.innerHTML = `
      <div style="width:12px;height:12px;border:2px solid #333;border-top-color:#ff0000;
                  border-radius:50%;animation:ytcf-spin 0.7s linear infinite;flex-shrink:0"></div>
      <span id="ytcf-banner-text">YT Curated: collecting channels…</span>
      <style>@keyframes ytcf-spin{to{transform:rotate(360deg)}}</style>
    `;
    document.body.appendChild(banner);
    return banner;
  }

  function updateBanner(text, done = false) {
    const el = document.getElementById('ytcf-banner-text');
    if (el) el.textContent = text;
    if (done) {
      const spinner = document.querySelector('#ytcf-banner > div');
      if (spinner) {
        spinner.style.border = '2px solid #00cc66';
        spinner.style.animation = 'none';
      }
      setTimeout(() => document.getElementById('ytcf-banner')?.remove(), 3000);
    }
  }

  // ── Main scroll-and-harvest loop ───────────────────────────────────────
  async function scrape() {
    // Wait for the first set of channel renderers to appear
    let waited = 0;
    while (!document.querySelector('ytd-channel-renderer') && waited < 8000) {
      await sleep(300);
      waited += 300;
    }

    if (!document.querySelector('ytd-channel-renderer')) {
      // No channels found — could be empty list or login required
      sendComplete();
      return;
    }

    showBanner();

    let lastProgressReport = 0;

    while (sameCount < MAX_SAME_COUNT) {
      const added = harvestRenderers();

      if (added === 0) {
        sameCount++;
      } else {
        sameCount = 0;
        // Send incremental progress updates
        if (collected.size - lastProgressReport >= PROGRESS_EVERY) {
          lastProgressReport = collected.size;
          sendProgress();
        }
      }

      updateBanner(`YT Curated: ${collected.size} channels found…`);

      // Scroll to bottom to trigger next page load
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      await sleep(SCROLL_PAUSE_MS);

      // Also try triggering a scroll event in case YT uses scroll listeners
      window.dispatchEvent(new Event('scroll'));
      await sleep(200);
    }

    // Final harvest after scrolling stops
    harvestRenderers();

    updateBanner(`YT Curated: ✓ ${collected.size} channels collected`, true);
    sendComplete();

    // Scroll back to top so the user sees the channels page normally
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Kick off after a short delay to let the page's own JS finish initialising
  setTimeout(scrape, 600);
})();
