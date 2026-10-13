# Privacy policy — YT Curated Feed

_Last updated: 2026-10-13_

YT Curated Feed has no advertising, analytics, telemetry, account-linking service or developer-operated backend. The developer does not receive your settings, selected-channel list or watch-time totals.

**What is stored locally.** Your selected channels, preferences and daily watch-time totals are saved in Chrome's extension storage on your device. They stay there unless you export a backup yourself.

**Network requests.** To build the feed, the extension requests public channel feeds and video/channel metadata from YouTube. It also loads channel avatars from YouTube's thumbnail host. Requests may include the public channel or video IDs needed for the feed and are sent without your YouTube cookies. This data is requested from YouTube, not sent to the extension developer or a third-party analytics service. Importing subscriptions reads the list inside a YouTube tab in your own browser; your selected channels are stored locally by the extension.

**No telemetry or developer server.** The extension has no analytics, no ads, no third-party tracking code and no developer-operated server.

**Permissions.** `storage` saves preferences and watch-time totals locally; `tabs` opens the subscriptions page for import and the feed page; `declarativeNetRequestWithHostAccess` sets the `Origin` header YouTube expects on the extension's own InnerTube requests; YouTube host access runs the curated feed and focus tools and fetches public channel/video information.

**Contact.** Questions: open an issue at
https://github.com/giri256/yt-curated-feed/issues

YT Curated Feed is independent and is not affiliated with YouTube or Google.
