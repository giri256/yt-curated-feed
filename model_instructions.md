# YT Curated Feed: repository guide

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) completely before changing
runtime behavior. It is the source of truth for the extension's entry points,
message contracts, storage schema, data flows, and external dependencies.

Project constraints:

- This is a dependency-free Chrome Manifest V3 extension written in plain
  JavaScript. The project root is the canonical unpacked-extension directory.
- `src/background.js` is the only network/data orchestration layer. Keep the two
  UIs (`src/feed.js` and `src/content.js`) as consumers of the same message API.
- A channel that has no recent uploads and a channel whose request failed are
  different states. Do not silently turn transport failures into valid empty
  results.
- Preserve stored selections across subscription rescans, including selected
  channels that are absent from a later scrape.
- YouTube DOM and embedded JSON shapes are unstable. Keep extraction fallbacks
  and fail with actionable diagnostics when every fallback fails.
- Before handing off a change, run JavaScript syntax checks and the build check,
  then report any browser-only validation that still needs to be performed.

The working tree may contain user-owned uncommitted changes. Inspect and preserve
them; do not reset or overwrite unrelated work.
