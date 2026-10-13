<p align="center">
  <img src="icons/icon128.png" width="72" alt="YT Curated Feed icon" />
</p>

<h1 align="center">YT Curated Feed</h1>

<p align="center">
  <b>Your YouTube homepage, showing only the channels you chose.</b><br />
  No algorithm. No Shorts spiral. No autoplay chain. Works with watch history off.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-ff3447" /></a>
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-ff3447" />
  <img alt="Manifest V3" src="https://img.shields.io/badge/Chrome-Manifest%20V3-1c1f28" />
  <img alt="No servers" src="https://img.shields.io/badge/servers-none-1c1f28" />
  <img alt="No tracking" src="https://img.shields.io/badge/tracking-none-1c1f28" />
</p>

<p align="center">
  <img src="docs/images/hero.png" alt="YT Curated Feed replacing the YouTube homepage with a feed of chosen channels" />
</p>

YouTube's homepage is built to keep you watching: recommendations, Shorts,
autoplay and the end-of-video wall exist to maximise watch time, not your goals.
You open YouTube for one lecture and surface two hours later.

**YT Curated Feed** gives you the homepage back. It shows the last 7 days of
uploads from the channels *you* picked, newest first, and switches off the
loops that pull you in. It is free, fully open source, has zero dependencies,
and talks to nobody but YouTube.

## Why it exists

- **Students** who need one lecture, not a rabbit hole.
- **Anyone fighting procrastination** and "one more video" loops.
- **People who want their subscriptions back**, in order, without a
  recommendation engine deciding what they see.

## Features

| | |
|---|---|
| **Your homepage, your channels** | Full-page takeover of youtube.com with new uploads from the channels you selected (import your subscriptions in one click, or add any channel by @handle). A compact panel above YouTube's own grid is one click away for enthusiasts. |
| **Works with watch history off** | Pause YouTube watch history and YouTube's homepage goes blank; your feed replaces it. YouTube stops profiling you and you still get a great homepage. |
| **Focus tools** | Hide Shorts (Shorts links open in the normal player), turn off autoplay, hide the end-of-video wall, recommendations, Mixes, search shelves, comments, live chat (properly collapsed, so the video gets the full width), end cards, playlist panel, merch, fundraisers, Explore/Trending, "More from YouTube" and the notification bell. |
| **Pin video quality** | Every video starts at the quality you choose (or the closest one it has). Picking another quality in the player still works. |
| **Watch-time dashboard** | Today, this week, a seven-day rhythm, and an optional daily limit that steps in when the allowance is used. |
| **Fast and resilient** | ~50 channels load in a few seconds and refresh in under one. If YouTube's RSS endpoint fails, the extension falls back to YouTube's own InnerTube API instead of dropping the channel. |
| **Private** | No account linking, no OAuth, no API keys, no analytics, no servers. Everything is stored in your browser. |

<p align="center">
  <img src="docs/images/history-off.png" width="49%" alt="With watch history paused, YouTube's homepage is blank; YT Curated Feed fills it" />
  <img src="docs/images/watch.png" width="49%" alt="A calm watch page with recommendations and autoplay removed" />
  <img src="docs/images/focus.png" width="49%" alt="Focus tools in the extension popup" />
  <img src="docs/images/time.png" width="49%" alt="Watch-time dashboard with a daily limit" />
</p>

### Versus YouTube's "Custom Feeds"

YouTube announced prompt-based Custom Feeds in 2026. They are a welcome
experiment, but they are a different thing:

| | YouTube Custom Feeds | YT Curated Feed |
|---|---|---|
| Who picks the videos | YouTube's algorithm, from your prompt | You, by channel |
| Watch history | Must be on | Works with it off |
| Availability | Rolling out, US first | Everywhere, today |
| Shorts, autoplay, end screens | Still there | Off with one toggle |

## Install

**From source (developer mode):**

1. Download this repository (`Code → Download ZIP`) or a
   [release](https://github.com/giri256/yt-curated-feed/releases) and unzip it.
2. Open `chrome://extensions` (also works in Brave, Edge and other Chromium
   browsers, version 111+).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the folder that contains `manifest.json`.

No build step, no `npm install`.

## Use

1. Click the extension icon → **Channels** → **Load my subscriptions** (or **+**
   to add a channel by @handle).
2. Tick the channels you actually want and **Save**.
3. Open youtube.com. Your homepage is now your feed.
4. Open **Focus** in the popup to switch off Shorts, autoplay and the rest, pick
   the homepage mode (full page or compact panel), and pin a video quality.

For the cleanest result, pause your watch history at
[youtube.com/feed/history](https://www.youtube.com/feed/history).

## Built in the open

- **Zero dependencies.** Plain JavaScript, HTML and CSS. No bundler, no
  framework, no `node_modules` in the extension. `build.mjs` only copies files.
- **Readable.** The whole extension is a handful of files you can audit in an
  evening; see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
  [`PROJECT_UNDERSTANDING.md`](PROJECT_UNDERSTANDING.md).
- **Talks only to YouTube.** Network requests go to `www.youtube.com` (public
  RSS feeds and the InnerTube endpoints YouTube's own site uses), sent without
  cookies. Nothing is sent anywhere else.
- **Tested.** `node:test` suites for the service worker and focus settings, plus
  a real-browser smoke test in headless Brave.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Selected channels, preferences, watch-time totals |
| `tabs` | Open the subscriptions page and the feed tab |
| `declarativeNetRequestWithHostAccess` | One session rule sets `Origin: https://www.youtube.com` on the extension's own InnerTube requests (YouTube rejects a `chrome-extension://` Origin) |
| Host `youtube.com` | Read RSS feeds, run the homepage feed and focus tools |

## Develop

```bash
npm test               # node:test suites (no dependencies to install)
npm run build          # copies the extension into dist/
BRAVE_EXECUTABLE_PATH=/usr/bin/brave npm run smoke:browser  # real-browser check (Brave)
```

Project layout:

```
manifest.json          MV3 manifest (load this folder unpacked)
src/background.js      service worker: feeds, InnerTube fallback, durations, storage, messages
src/content.js/.css    homepage takeover (full page) or compact panel
src/focus.js/.css      focus tools: classes on <html> + hiding rules
src/page-main.js       MAIN-world helper: live-chat collapse, autoplay off, quality pin
src/watch-tracker.js   watch-time accounting and daily-limit screen
src/popup.*            popup: dashboard, channels, focus, settings, support
src/feed.*             full-page feed tab
src/welcome.html       first-run page
tests/                 node:test suites
scripts/               real-browser smoke test
```

Contributions are welcome. Please open an issue first for larger changes, keep
the extension dependency-free, and run `npm test` before sending a pull request.

## Support the project

YT Curated Feed is free, with no ads, no data selling and no premium tier. If it
gave you some hours back:

- ☕ [Buy me a coffee](https://buymeacoffee.com/giri256)
- 💳 [PayPal](https://paypal.me/kgspavan)
- ⭐ Star the repo and tell a friend who needs their evenings back.

## Credits and license

- MIT licensed; see [LICENSE](LICENSE).
- The video-quality pin follows the approach of
  [YouTube Enhancer](https://github.com/YouTube-Enhancer/extension) (MIT).
- YT Curated Feed is an independent project, not affiliated with, endorsed or
  sponsored by YouTube or Google. YouTube is a trademark of Google LLC.
