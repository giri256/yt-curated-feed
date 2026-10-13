# PROJECT_UNDERSTANDING — YT Curated Feed

Living summary for agents and contributors who have never seen this project.
Verified against the code on 2026-10-13 (v2.2.0). Deeper detail (all flows,
message API, storage schema) lives in `docs/ARCHITECTURE.md`.

## 1. What it is

A dependency-free Chrome/Brave Manifest V3 extension that replaces YouTube's
algorithmic homepage with the last 7 days of uploads from channels the user
chose, newest first, and adds "focus tools" that switch off YouTube's
engagement loops (Shorts, autoplay, end screens, recommendations, ...), a video
quality pin, and a watch-time dashboard with an optional daily limit. It works
with YouTube watch history turned off (the intended setup: YouTube's own
homepage goes blank and this feed replaces it). No OAuth, no API key, no server.

## 2. Current status

- Works: subscription import, selection, homepage takeover (full page, default)
  or compact panel, feed page, filters, durations, focus tools, quality pin,
  watch-time stats/limits, import/export, diagnostic logging (off by default;
  popup → Settings), first-run welcome page, donate links in popup.
- Feed speed (2026-10-12): cold load of 52 channels with durations ~4.7s,
  forced warm refresh ~0.4s, measured against live YouTube.
- RSS reliability (2026-10-13): the RSS endpoint answered 404/500 to ~60% of
  requests for live channels; the InnerTube `browse` fallback (Videos tab)
  answered every time, so those channels still load (approximate publish
  times, regular uploads only).
- Proven in headless Brave with the built extension against live YouTube:
  full-mode takeover spans the page (1345px of a 1600px window, YouTube grid
  hidden); compact panel sits above YouTube's grid; Shorts URL redirect; Shorts
  removed from search; live chat collapses and the player takes the full
  width; autoplay toggle flips off; quality pin (480p requested → `large`
  playing) on a watch page and on `/@channel/live`; watch page without
  recommendations centres the player.
- `npm test`: 39 tests pass. `npm run smoke:browser` passes (see §3).

## 3. Run, use, test

- Load unpacked: the **project root** (canonical) or `dist/` after
  `npm run build`. After editing `src/`, reload the extension.
- `npm test` — node:test suites in `tests/`; `background.js` runs in a `vm`
  context with mocked `chrome.*` and `fetch`.
- `BRAVE_EXECUTABLE_PATH=/usr/bin/brave npm run smoke:browser` — loads `dist/`
  in headless Brave, live YouTube. The Chromium singleton socket path must be
  short, so point `TMPDIR` at a short directory if it fails to start.
- State: `chrome.storage.local` (keys in ARCHITECTURE "Storage schema").
  Preferences live under `preferences` (`homepageMode`, `preferredQuality`,
  `focus.*`, `videoTypeFilters`, `enableLogging`).

## 4. Architecture

- **Service worker** (`src/background.js`) does all networking; UIs talk to it
  with `chrome.runtime.sendMessage` (`GET_FEED`, `GET_SELECTION`,
  `SAVE_SELECTION`, `GET_PREFERENCES`, `SCRAPE_CHANNELS`, ...).
- **Feed build** (`buildFeed`): selected IDs → per channel: fresh cache
  (10 min) or `fetchChannelRSSShared` → `resolveChannelId` (handles: memory →
  storage → InnerTube `navigation/resolve_url` → channel page) →
  `fetchChannelFeedXmlOrFallback`: RSS (2 attempts) → InnerTube `browse`
  Videos tab → remaining RSS retries → parse → carry over cached durations →
  duration hydration (InnerTube `player`, watch page fallback) without
  blocking the 12-wide RSS pool. Cached per channel in `channelFeedCacheV2`.
- **InnerTube calls**: POST JSON, `credentials: 'omit'`, WEB client context. A
  DNR session rule (`ensureInnertubeOriginRule`) sets
  `Origin: https://www.youtube.com` on this extension's `/youtubei/v1/`
  requests; without it YouTube answers 403.
- **Homepage** (`content.js`, `document_start`): prefetches the feed while the
  page loads; on `/` inserts a Shadow-DOM host before
  `ytd-browse[page-subtype="home"]`. Full mode sets `html.ytcf-home-full`
  (focus.css hides YouTube's grid). The host takes a full flex row of
  `ytd-page-manager` (content.css), so it spans the page / sits above the grid.
- **Focus tools**: `focus.js` (isolated world, `document_start`) reads
  `preferences` straight from storage, toggles `ytcf-*` classes on `<html>`
  for `focus.css`, writes `data-ytcf-*` attributes for `page-main.js`, and
  redirects `/shorts/ID` to `/watch?v=ID`. `page-main.js` (MAIN world) uses
  YouTube's own element/player APIs: chat collapse via
  `ytd-live-chat-frame.onShowHideChat()`, autoplay via clicking the toggle,
  quality via `setPlaybackQualityRange`.
- **Watch time**: `watch-tracker.js` counts visible playback, worker stores
  daily totals, overlay covers YouTube when the limit is reached.

## 5. File map

- `manifest.json` — permissions (`storage`, `tabs`,
  `declarativeNetRequestWithHostAccess`), content scripts, Chrome 111+. **Entry.**
- `src/background.js` — service worker (above). **Entry.**
- `src/content.js` / `content.css` — homepage takeover / compact panel.
- `src/focus.js` / `focus.css` — focus-tool classes and hiding rules.
- `src/page-main.js` — MAIN-world chat collapse, autoplay off, quality pin.
- `src/feed.html` / `feed.js` — full-page feed (Refresh = strict refresh).
- `src/popup.html` / `popup.js` — dashboard, channels, Focus view, settings,
  support card.
- `src/welcome.html` — first-run page (opened by `onInstalled`).
- `src/channels-scraper.js` — subscription-list reader on `/feed/channels`.
- `src/watch-tracker.js` — watch-time accounting + limit overlay.
- `src/stats.*`, `src/import.*` — stats page, backup import page.
- `icons/` — `icon.svg` (master), PNGs at 16 (simplified), 48, 128.
- `build.mjs` — copies files into `dist/` (no bundling).
- `tests/` — `background`, `diagnostics`, `focus` suites.
- `scripts/brave-smoke.mjs` — real-browser smoke test.
- `docs/ARCHITECTURE.md` — flows, message API, storage schema.
- `docs/images/` — README images.

## 6. Key decisions and why

- RSS first: exact publish timestamps, includes Shorts, cheap. No duration,
  no validators, no type filter. InnerTube `browse` only as fallback because
  its times are relative ("2 days ago").
- InnerTube instead of HTML pages for durations and handles: ~7KB / ~0.3s vs
  ~1.3MB / 3.6–4.7s.
- Focus tools are a clean-room implementation (Unhook's licence forbids
  derivative works; its code was not used). The quality pin follows YouTube
  Enhancer's approach (MIT), credited in `page-main.js` and README.
- Live chat: CSS-only hiding leaves YouTube reserving the chat column; a real
  collapse through YouTube's handler gives the player the width back.
- Full-page homepage is the default; the compact panel is opt-in.
- Shorts are off by default both as a focus tool and as a feed filter.
- Rejected: Range requests on watch pages (ignored), conditional GET on RSS
  (no validators), serving stale results by default (stale only as failure
  fallback, never on strict refresh), `player.setAutonav(false)` (doesn't
  change the toggle).

## 7. Gotchas

- `chrome-extension://` Origin → 403 on InnerTube; only a real-browser test
  catches regressions (`smoke:browser`).
- `INNERTUBE_CONTEXT.clientVersion` is hardcoded; check it first if InnerTube
  calls start failing.
- Outer-document CSS beats `:host` rules: the content host's own box
  (background, padding, flex) is styled in `content.css`, not the shadow root.
- YouTube stamps live chat seconds after navigation; `page-main.js` watches
  `ytd-watch-flexy` chat attributes and re-runs its tasks. YouTube toggles are
  async: each is poked at most once per `ACTION_SETTLE_MS`.
- The quality pin waits out ads (`.ad-showing`) and stands down once the user
  picks a quality by hand.
- RSS throttling shows as 404/500, not 429; 404 is retried. Tuning constants:
  `FEED_CONCURRENCY`, `FEED_REQUEST_*`, `FEED_RETRY_*`, `STRICT_*`,
  `RSS_ATTEMPTS_BEFORE_FALLBACK`, `VIDEO_DURATION_CONCURRENCY`,
  `INNERTUBE_TIMEOUT_MS`, `INNERTUBE_ATTEMPTS`.
- Tests route fetches by URL substring; mocks must handle `/youtubei/v1/player`,
  `/browse` and `/navigation/resolve_url`. Cross-realm `vm` objects defeat
  `deepStrictEqual`; compare strings/fields.
- `focus.js` `FOCUS_DEFAULTS` must mirror `DEFAULT_PREFERENCES.focus`
  (a test enforces it), and every focus key needs a CSS rule (also tested).

## 8. Where to start

- Slow/failing feed: popup → Settings → Diagnostic logging, then `buildFeed`,
  `fetchChannelFeedXmlOrFallback`, `hydrateVideoDurations`.
- A focus toggle stopped working: selectors in `focus.css` (YouTube renames
  elements); player behaviour in `page-main.js`.
- Homepage layout: `content.css` (host box) and the shadow styles in
  `content.js` `createPanel`.
- Adding a focus option: `DEFAULT_PREFERENCES.focus` + `FOCUS_DEFAULTS` +
  a `focus.css` rule + `FOCUS_OPTIONS` in `popup.js`.
- Channel "could not resolve": `resolveChannelId`, `resolveHandleViaInnertube`.

## 9. Related

- Store and marketing assets live outside the repo in the owner's workspace
  (`../assets_publish`): listing copy, rendered images and their HTML sources.
