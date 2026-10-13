# YT Curated Feed architecture and maintenance guide

This document describes the current source tree as inspected on 2026-10-13 (v2.1.0). It
is intended to give maintainers and future AI sessions enough context to make a
change without reverse-engineering the whole extension again.

## Product boundary

YT Curated Feed is a local, dependency-free Chrome Manifest V3 extension. A user
loads their YouTube subscriptions, selects a subset of channels, and sees public
uploads from the last seven calendar days. It does not use OAuth, an API key, a
server, cookies permission, or the YouTube Data API.

The extension relies on three YouTube-owned surfaces:

1. The signed-in `https://www.youtube.com/feed/channels` page supplies the user's
   subscription list through rendered DOM and Polymer/Lit data.
2. The public `https://www.youtube.com/feeds/videos.xml?channel_id=UC...` endpoint
   supplies up to the latest 15 public uploads per channel.
3. YouTube's InnerTube JSON API (`/youtubei/v1/player` for `lengthSeconds`,
   `/youtubei/v1/navigation/resolve_url` for handle → `UC...`). Calls go out
   without cookies; a `declarativeNetRequest` session rule rewrites their
   `Origin` to `https://www.youtube.com` because YouTube returns 403 to a
   `chrome-extension://` Origin. The heavy HTML pages (watch page ~1.3MB,
   channel page) remain as fallbacks when an InnerTube call fails.

Consequently, the subscription scraper depends on unstable page markup, while
the video feed depends on an undocumented availability/rate-limit envelope.

## Runtime components

| File | Chrome context | Responsibility |
| --- | --- | --- |
| `manifest.json` | Extension definition | Permissions, service worker, content-script matches, popup and resources |
| `src/background.js` | MV3 service worker | Storage, channel profile/handle resolution, scrape coordination, RSS aggregation, runtime message API |
| `src/channels-scraper.js` | YouTube subscriptions tab | Scroll the lazy-loaded channel list, extract channel records, publish progress/final snapshots |
| `src/popup.html` / `src/popup.js` | Action popup | Dashboard-first watch analytics/limits, sidebar navigation, scrape status, channel selection, feed preferences and backup actions |
| `src/import.html` / `src/import.js` | Extension page | Persistent file-picker/drop target for restoring JSON backups |
| `src/feed.html` / `src/feed.js` | Extension page | Full-page feed, filters, search, sorting and refresh |
| `src/content.js` / `src/content.css` | YouTube pages (`document_start`) | Homepage takeover (full) or compact panel in Shadow DOM, filters, sorting and SPA route lifecycle |
| `src/watch-tracker.js` | Every YouTube page | Active watch/Shorts playback accounting and daily-limit blocking overlay |
| `src/focus.js` / `src/focus.css` | Every YouTube page (isolated, `document_start`) | Focus-tool classes on `<html>`, hiding rules, Shorts redirect |
| `src/page-main.js` | Every YouTube page (MAIN world, `document_start`) | Live-chat collapse, autoplay off, video-quality pin via YouTube's own APIs |
| `src/welcome.html` | Extension page | First-run page opened by `runtime.onInstalled` |
| `src/stats.html` / `src/stats.js` | Extension page | Daily/weekly watch-time report and limit editor |
| `build.mjs` | Node utility | Copies extension assets to `dist/`; no compilation or bundling |

The project-root layout is canonical: loading the repository root as an unpacked
extension uses the paths in `manifest.json` directly.

## End-to-end flows

### 1. Discover subscriptions

1. The popup sends `SCRAPE_CHANNELS`.
2. The worker records scrape state, remembers the current tab, and opens or
   focuses `/feed/channels`.
3. The worker returns immediately; scrape state and progress are persisted so a
   popup closing or an MV3 worker restart does not own the operation's lifetime.
4. `channels-scraper.js` waits for `ytd-channel-renderer`, repeatedly harvests
   visible records, scrolls to the current document bottom, and emits
   `CHANNELS_PROGRESS` snapshots into temporary storage.
5. Completion requires stable renderer count, document height, bottom position,
   and continuation/loading state. Only then does the scraper emit
   `CHANNELS_READY`.
6. The worker transactionally replaces the official list, restores the former
   tab, closes only a tab it created itself, and hydrates missing profile fields
   in the background. A failed/interrupted scrape keeps the previous list.

The worker persists the scrape tab ID and listens for tab removal. If the user
closes the YouTube tab, status immediately returns to idle with an error while
retaining the last committed list. The popup also exposes `CANCEL_SCRAPE` so the
operation never traps the UI in its loading state.

Channel identity extraction is ordered from strongest to weakest:

- nested component data containing a `UC...` ID;
- renderer markup or `/channel/UC...` links;
- `/@handle` as a temporary ID, resolved later (InnerTube `resolve_url`, with
  the channel page as fallback).

### 2. Save a curated selection

The popup keeps selection state locally while it is open. `SAVE_SELECTION`
persists both the ordered IDs and a metadata map. Feed generation uses this
saved snapshot; it does not depend on the popup remaining open.

The popup itself is a three-workspace shell rather than a linear setup wizard:

- **Overview** is the default and renders `GET_WATCH_STATS` as a circular daily
  allowance, summary metrics, seven-day bars, quick/custom limits, and Open Feed.
- **Channels** owns onboarding, active scrape progress, search, manual addition,
  selection and saved/unsaved state. An active scrape reopens this workspace.
- **Settings** owns the live/upcoming preference, import/export, expanded stats,
  and the session-opened-card summary.

Channel selection changes remain local and visibly marked as unsaved until
`SAVE_SELECTION`; opening the feed from Overview first commits a dirty selection.

### 3. Build a video feed

1. `feed.js` or `content.js` sends `GET_FEED` without arguments.
2. The worker reads `selectedChannelIds` and `selectedChannelsMeta`.
3. Handles are resolved to canonical `UC...` IDs when necessary. Each handle
   costs one InnerTube `navigation/resolve_url` call the first time (~0.3s;
   legacy handles answer with a `urlEndpoint` redirect such as `/c/Name`,
   followed for up to three hops; two attempts, five-second timeout; the
   channel-page scrape is the fallback), then persists in
   `resolvedChannelIds` so repeat loads (including after worker restarts)
   skip it; the per-load count is reported as `handleResolutions`.
4. A fresh successful per-channel cache entry (10-minute TTL) is used when
   available. Otherwise, a twelve-worker concurrency pool fetches the channel; a
   slow request does not block unrelated later work behind a batch boundary.
5. RSS requests have an eight-second timeout and retry transient network,
   timeout, HTTP 404/408/425/429, 5xx, and invalid-document failures up to
   four attempts, honoring Retry-After when present and otherwise backing off
   exponentially from one second (capped, jittered). 404 is retried because
   measured throttle windows serve error pages for live channels; dead
   channels answer fast, so retrying them costs little.
   After two failed RSS attempts the worker asks InnerTube `browse` for the
   channel's Videos tab (`fetchChannelViaInnertube`, params
   `EgZ2aWRlb3PyBgQKAjoA`). Its items carry title, views, duration and a
   relative time ("2 days ago"), so those videos get `publishedApprox: true`
   and need no duration hydration; the tab holds regular uploads only. If
   that fails too, the remaining RSS attempts run. Measured 2026-10-13: RSS
   failed ~60% of requests for live channels while `browse` succeeded.
6. Each successful Atom document is parsed, uploads older than the local-day
   seven-day cutoff are removed, and the result becomes that channel's new
   last-known-good cache entry. Durations already known from the previous
   cache entry for that channel are carried over, so a 10-minute refetch does
   not re-hydrate anything already seen. Each channel's videos start duration
   hydration the moment its own feed lands, but the RSS worker does not wait
   for it: hydration never holds one of the twelve RSS slots.
7. Videos still without a duration are hydrated through InnerTube `player`
   (~7KB, p50 ~0.3s) under one shared ten-wide cap across all channels;
   concurrent lookups of the same video share one request. A player response
   with `videoDetails` is final (upcoming/live report 0 → no badge); only a
   failed request falls back to the watch page (eight-second timeout). A missed
   duration leaves the video in the feed without a badge. Duration
   extraction accepts either string or numeric `lengthSeconds` and formats values
   as `M:SS` or `H:MM:SS`. A failed lookup leaves the video in the feed without a
   duration and does not turn the channel into a failed request.
8. Newly hydrated durations are written back into the same per-channel cache,
   including fresh/stale cache entries, so subsequent loads reuse them.
9. If all retries fail, a successful cache entry no older than eight days is
   filtered again and used as a degraded fallback. Otherwise the channel is
   explicitly reported as failed.
10. The worker deduplicates videos, sorts them newest-first, and returns both the
   merged array and aggregate `feedStatus` diagnostics in one message response.

Both feed surfaces receive the same video model and apply presentation-only
search, video-type filters and sorting. The homepage initially renders at most
12 cards and exposes a show-more button; the extension page renders all cards.
Livestream, scheduled/upcoming, and premiere indicators are classified as
`videoType: "live"`; that type is hidden by the default preference but can be
enabled in either UI.

A successful empty RSS feed and a failed request are distinct states. Both feed
surfaces show partial-load or stale-cache notices based on `feedStatus`; they do
not infer an upstream-empty channel from a failed transport.

### 4. Mark videos opened during this browser session

Both feed surfaces mark a card on left-click, middle-click, or `contextmenu`
before navigation completes. `MARK_VIDEO_OPENED` adds its ID to capped
`chrome.storage.session` history, then the worker broadcasts `VIDEO_OPENED` to
extension pages and injected YouTube content scripts. All matching cards update
immediately. Closing/restarting the browser clears this visual history; it is
deliberately excluded from backup export/import.

Right-click marks intent because browsers do not expose whether the user later
chooses “open in new tab” from the native context menu. Cancelling that menu can
therefore still grey the card.

### 5. Track and limit active YouTube playback

`watch-tracker.js` runs on all `www.youtube.com` routes but counts time only on
`/watch` and `/shorts/`. A tab contributes seconds while it is visible and its
main YouTube video element is ready, playing, and not ended. It periodically
sends small `WATCH_TIME_DELTA` messages, including a final partial interval on
pause, navigation, tab hiding, or unload.

The worker serializes those deltas into `watchTimeDaily[local YYYY-MM-DD]`, caps
individual reports to reduce runaway accounting, retains the latest 370 days,
and returns daily/weekly/last-seven-days summaries through `GET_WATCH_STATS`.
The current-week total starts on Monday.

`watchTimeLimitMinutes` is a daily local-time limit. Zero disables it. Once
today's recorded seconds meet the limit, the tracker pauses playback and mounts
a full-page Shadow DOM blocker on every YouTube tab. Saving a larger/disabled
limit or crossing local midnight removes it after the next status update.

### 6. Homepage takeover and focus tools

1. `content.js` runs at `document_start`. On the home route it starts the feed
   messages immediately (`startFeedLoad`) so the network work overlaps
   YouTube's own page load.
2. In `full` mode it sets `html.ytcf-home-full`; `focus.css` hides
   `ytd-browse[page-subtype="home"]` and the Shadow-DOM host takes a full flex
   row of `ytd-page-manager` (`content.css`). In `panel` mode YouTube's grid
   stays and the host sits above it, padded like the grid.
3. `focus.js` (isolated world, every YouTube page, `document_start`) reads
   `preferences` from `chrome.storage.local`, toggles one `ytcf-<kebab-key>`
   class per focus option on `<html>` and follows `storage.onChanged`, so popup
   toggles apply to open tabs at once. It also redirects `/shorts/<id>` to
   `/watch?v=<id>` when Shorts are hidden.
4. `focus.js` mirrors the options `page-main.js` needs into attributes:
   `data-ytcf-hide-chat`, `data-ytcf-no-autoplay`, `data-ytcf-quality`.
5. `page-main.js` (MAIN world) re-runs its tasks on YouTube navigation events,
   player state changes and chat attribute changes: collapse chat through
   `ytd-live-chat-frame.onShowHideChat()`, click the autoplay toggle off, and
   pin quality with `setPlaybackQualityRange(q, q)` for the closest available
   level not above the target, standing down when the user picks another
   quality.
6. With recommendations hidden, `focus.css` drops the empty secondary column
   (unless it holds a playlist or open chat) and caps/centres `#primary` so
   the player fits the viewport.

## Runtime message API

All messages are handled in `src/background.js`.

| Type | Main caller | Result / effect |
| --- | --- | --- |
| `GET_CHANNELS` | Popup | Cached subscription records and cache timestamp |
| `GET_SCRAPE_STATUS` | Popup | Persisted in-progress flag, start time, progress count and last error |
| `SCRAPE_CHANNELS` | Popup | Persists start state, opens/focuses the scrape tab, returns immediately |
| `CANCEL_SCRAPE` | Popup | Stops the current scrape, closes an extension-created tab and retains the previous list |
| `CHANNELS_PROGRESS` | Scraper | Updates temporary progress keys without touching the official list |
| `CHANNELS_READY` | Scraper | Transactionally commits final snapshot, completes scrape and closes an extension-created tab |
| `CHANNELS_FAILED` | Scraper | Keeps the official list and stores an actionable scrape error |
| `CHANNELS_CACHE_UPDATED` | Worker to popup | Announces background metadata hydration |
| `ADD_CHANNEL` | Popup | Resolves a URL/handle/ID and upserts the cached channel |
| `SAVE_SELECTION` | Popup | Persists chosen IDs and selected metadata |
| `GET_SELECTION` | Popup/feed UIs | Returns chosen IDs and selected metadata |
| `GET_FEED` | Feed UIs | Returns merged `videos` plus per-request `feedStatus`; accepts `forceRefresh`, optional `videoTypeFilters` (ticked types only hydrate durations), and optional `strict` (real refresh: implies force, no stale fallback, extended 8-attempt retry ladder; feed page Refresh/retry use it, normal loads don't) |
| `GET_PREFERENCES` / `SAVE_PREFERENCES` | Feed UIs | Reads/writes video-type filters and the opt-in `enableLogging` flag (default off) |
| `APPEND_DIAGNOSTIC_LOG` / `GET_DIAGNOSTIC_LOGS` / `CLEAR_DIAGNOSTIC_LOGS` | Feed UIs, popup | Stores/reads/clears the capped opt-in diagnostic timeline (`feed.timeline`, `feed.request`) |
| `GET_FEED` (diagnostics) | Feed UIs | Response also carries `feedDiagnostics` (request-received/completed timestamps, total duration, per-stage `rssMs`/`hydrationMs`, `hydrationRequested`/`hydrationSkipped`/`handleResolutions` counts, per-reason `failureBreakdown`, channel counts); timeline entries log fetched-versus-shown counts |
| `EXPORT_DATA` / `IMPORT_DATA` | Popup | Serializes/restores channels, selection and preferences |
| `GET_OPENED_VIDEOS` | Feed UIs | Returns session-only opened video IDs |
| `MARK_VIDEO_OPENED` | Feed UIs | Records an ID in session storage and broadcasts `VIDEO_OPENED` |
| `WATCH_TIME_DELTA` | Watch tracker | Adds bounded active-playback seconds and returns current blocking status |
| `GET_WATCH_STATS` | Stats/tracker | Returns today, week and seven-day totals plus daily-limit state |
| `SAVE_WATCH_LIMIT` | Stats page | Persists the daily minute limit and broadcasts `WATCH_STATUS_UPDATED` |

The `send()` wrappers reject `chrome.runtime.lastError` and any response with an
`error` property. The worker returns `true` from its message listener to keep the
response channel open for asynchronous work.

## Persisted storage schema

Durable data is in `chrome.storage.local`.

| Key | Shape | Meaning |
| --- | --- | --- |
| `allChannels` | `Channel[]` | Latest subscription scrape plus manually added channels |
| `allChannelsMeta` | `{[id]: ChannelMeta}` | Metadata mirror used during hydration/export |
| `channelsLoadedAt` | epoch milliseconds | Time the scraper declared the snapshot complete |
| `scrapeInProgress` | boolean | Cross-popup scrape status |
| `scrapeStartedAt` | epoch milliseconds | Start time for stale-status diagnosis |
| `scrapeProgressCount` | number | Current temporary renderer count |
| `scrapeChannelsProgress` | `Channel[]` | Temporary in-progress snapshot; never the official list |
| `scrapeError` | string | Last scrape failure shown by the popup |
| `scrapeTabId` | number or null | Persisted tab identity used to detect user closure/worker restart |
| `scrapeTabCreatedByExtension` | boolean | Whether cleanup may close the tracked tab |
| `scrapeReturnTabId` / `scrapeReturnWindowId` | numbers or null | Previous browser location restored after scrape cleanup |
| `selectedChannelIds` | `string[]` | Ordered curated selection |
| `selectedChannelsMeta` | `{[id]: ChannelMeta}` | Feed labels/avatars independent of the latest scrape |
| `preferences` | object | `videoTypeFilters` for standard/shorts/live/other (Shorts off by default), `enableLogging` (default `false`), `homepageMode` (`full` default / `panel`), `preferredQuality` (`auto` or a YouTube quality label such as `hd1080`), `focus` (boolean per focus tool; defaults in `DEFAULT_PREFERENCES.focus`, mirrored in `focus.js`) |
| `resolvedChannelIds` | `{[handle]: UC...}` | Handle resolutions persisted across worker restarts; UC IDs are stable so entries never expire |
| `diagnosticLogs` | capped array (200) | Opt-in timeline entries `{ts, source, event, details}`: page-opened (navigation start via `performance.timeOrigin`, since content scripts run at `document_idle`) → feed-requested → response → rendered, plus fetched-versus-shown counts |
| `manuallyAddedChannelIds` | `string[]` | Manual entries that must survive subscription rescans |
| `channelFeedCacheV2` | `{[id]: CachedFeed}` | Last successful per-channel RSS result and fetch time |
| `watchTimeDaily` | `{[localDate]: seconds}` | Active YouTube playback totals, retained for 370 days |
| `watchTimeLimitMinutes` | number | Daily local-time limit; `0` disables blocking |

`chrome.storage.session` contains ephemeral interaction state:

| Key | Shape | Meaning |
| --- | --- | --- |
| `openedVideoIds` | `string[]` | Capped session-only IDs used for grey opened-card styling |

Conceptual models:

```text
Channel = {
  id: "UC..." | "@handle",
  name, handle, thumbnail, subscriberCount
}

Video = {
  id, url, title, thumbnail,
  channelId, channelName, channelThumbnail,
  channelSubscriberCount, channelSubscriberCountNum,
  publishedAt, publishedText, ageSortKey,
  viewCount, viewCountNum, duration, videoType
}
```

Normalization at the worker boundary collapses whitespace, removes duplicated
labels, normalizes handles/thumbnails, and parses compact numeric counts.

## Behavioral invariants

- The seven-day filter is applied from local midnight minus seven days, not from
  exactly 168 hours before the request.
- The RSS feed returns a maximum of 15 uploads. A very active channel can have
  older-but-still-in-range uploads omitted upstream.
- Selected channel metadata must survive a later incomplete subscription scrape.
- Scrape progress must never replace the last committed subscription list.
- Rescanning subscriptions must not implicitly change the saved selection.
- A selected handle may migrate to a matching canonical `UC...` ID during a
  successful rescan without changing the selected channel.
- Feed ordering defaults to ascending `ageSortKey` (newest first).
- UI filters must not refetch or mutate the stored selection.
- Live/upcoming filtering is presentation-only; enabling it must not refetch.
- Opened-video state is session-only and must not enter local backups.
- Watch time must count playback, not merely an open YouTube tab.
- A feed request should be deterministic for the same successful upstream
  responses. Partial upstream failure must be visible and recoverable.
- MV3 workers can be suspended and restarted, so correctness must not depend on
  in-memory maps. In-memory caches are optimizations only.

## Known integration risks and debugging map

For missing subscriptions, inspect the scraper first: renderer count, scroll
height growth, continuation/loading indicators, ID extraction fallback chosen,
and the final stability diagnostics. Progress lives in temporary keys; verify
that `CHANNELS_READY` committed before inspecting `allChannels`.

For selected channels missing from a video feed, inspect the worker: requested
ID, resolved ID, attempt count, HTTP status or network exception, XML validity,
entry count, recent-entry count, and aggregate success/failure totals. Do not
infer an upstream-empty channel from an absent video card.

For homepage-only problems, compare the full-page feed. If both are wrong, the
cause is normally selection/storage or worker aggregation. If only the homepage
is wrong, inspect Shadow DOM rendering and YouTube SPA navigation.

The popup polls persisted scrape status before reading the committed cache. An
old non-empty channel cache is never evidence that the current scrape completed.

## Build and validation

No install step is required. Useful static checks are:

```bash
node --check src/background.js
node --check src/channels-scraper.js
node --check src/popup.js
node --check src/feed.js
node --check src/content.js
node --check src/watch-tracker.js
node --check src/stats.js
npm test
npm run build
npm run smoke:browser
```

`npm run smoke:browser` launches `/usr/bin/brave-browser` (override with
`BRAVE_EXECUTABLE_PATH`) using a temporary profile, the container-safe
`--no-sandbox` and `--disable-setuid-sandbox` flags, and the unpacked `dist/`
extension. It verifies that the MV3 worker starts and performs a live YouTube RSS
request through the real extension runtime. Override the unpacked directory with
`YTCF_EXTENSION_PATH` when needed.

Then load the project root at `chrome://extensions`, enable service-worker DevTools,
and test with selected channels that cover: recent uploads, no recent uploads, a
handle-derived ID, and enough channels to exercise the concurrency pool.

The optional build recreates `dist/` with the same `src/`, `icons/`, and manifest
layout as the project root. Both the root and a freshly built `dist/` are valid
unpacked-extension directories.

## Safe change checklist

1. Read this document and `git diff` before editing.
2. Identify which boundary owns the bug: scraper, storage/message API, RSS
   aggregation, or one UI.
3. Preserve valid cached/selected data when an external request fails.
4. Add observable result metadata for partial work rather than silently dropping
   a channel.
5. Keep Chrome-specific logic thin enough that parsing, retry and aggregation
   behavior can be exercised outside Chrome.
6. Run static/build checks and manually test browser-only paths proportional to
   the change.
