import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const backgroundPath = new URL('../src/background.js', import.meta.url);
const backgroundSource = readFileSync(backgroundPath, 'utf8')
  .replace('const FEED_RETRY_BASE_MS = 1000;', 'const FEED_RETRY_BASE_MS = 0;');

function makeXml(channelId, videoId, publishedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <title>${channelId}</title>
      <author><name>${channelId}</name></author>
      <entry>
        <yt:videoId>${videoId}</yt:videoId>
        <title>Video ${videoId}</title>
        <published>${publishedAt}</published>
        <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}" />
      </entry>
  </feed>`;
}

function makeWatchHtml(seconds) {
  return `<html><script>var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"${seconds}"}};</script></html>`;
}

function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

function createHarness({ fetchImpl, initialStorage = {} }) {
  const storage = structuredClone(initialStorage);
  const sessionStorage = {};
  let messageListener = null;
  let tabRemovedListener = null;
  let nextTabId = 10;
  const openTabs = new Map([[1, { id: 1, windowId: 1, url: 'https://example.com/' }]]);

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) { messageListener = listener; },
      },
      sendMessage() {},
    },
    storage: {
      local: {
        get(key, callback) {
          queueMicrotask(() => callback({ [key]: storage[key] }));
        },
        set(data, callback) {
          Object.assign(storage, structuredClone(data));
          queueMicrotask(() => callback?.());
        },
      },
      session: {
        get(key, callback) {
          queueMicrotask(() => callback({ [key]: sessionStorage[key] }));
        },
        set(data, callback) {
          Object.assign(sessionStorage, structuredClone(data));
          queueMicrotask(() => callback?.());
        },
      },
    },
    tabs: {
      async query(query) {
        if (query.active) return [openTabs.get(1)];
        if (query.url) {
          const prefix = query.url.replace(/\*$/, '');
          return [...openTabs.values()].filter((tab) => tab.url?.startsWith(prefix));
        }
        return [];
      },
      async get(id) {
        const tab = openTabs.get(id);
        if (!tab) throw new Error('No tab with id.');
        return tab;
      },
      async update(id, details) {
        const tab = { ...(openTabs.get(id) ?? { id, windowId: 1 }), ...details };
        openTabs.set(id, tab);
        return tab;
      },
      async create(details) {
        const tab = { id: nextTabId++, windowId: 1, ...details };
        openTabs.set(tab.id, tab);
        return tab;
      },
      async remove(id) {
        openTabs.delete(id);
        tabRemovedListener?.(id, { windowId: 1, isWindowClosing: false });
      },
      sendMessage(_tabId, _message, callback) { queueMicrotask(() => callback?.({ started: true })); },
      onRemoved: {
        addListener(listener) { tabRemovedListener = listener; },
      },
    },
    windows: {
      async update() {},
    },
  };

  class ThrowingDomParser {
    parseFromString() {
      throw new Error('DOMParser unavailable in test worker');
    }
  }

  const context = vm.createContext({
    AbortController,
    DOMParser: ThrowingDomParser,
    URL,
    chrome,
    console,
    fetch: fetchImpl,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    structuredClone,
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  assert.equal(typeof messageListener, 'function');

  function message(msg, sender = {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No response for ${msg.type}`)), 20000);
      messageListener(msg, sender, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  return { message, storage };
}

test('diagnostic logging is disabled by default in preferences', async () => {
  const harness = createHarness({ fetchImpl: async () => response(404) });
  const result = await harness.message({ type: 'GET_PREFERENCES' });
  assert.equal(result.preferences.enableLogging, false);
});

test('enableLogging preference round-trips through save', async () => {
  const harness = createHarness({ fetchImpl: async () => response(404) });
  const saved = await harness.message({ type: 'SAVE_PREFERENCES', preferences: { enableLogging: true } });
  assert.equal(saved.preferences.enableLogging, true);
  const again = await harness.message({ type: 'GET_PREFERENCES' });
  assert.equal(again.preferences.enableLogging, true);
});

test('appends and reads back a feed-timeline log entry', async () => {
  const harness = createHarness({ fetchImpl: async () => response(404) });
  const appended = await harness.message({
    type: 'APPEND_DIAGNOSTIC_LOG',
    entry: {
      source: 'homepage',
      event: 'feed.timeline',
      details: {
        pageOpenedAt: '2026-09-07T00:00:00.000Z',
        feedRequestSentAt: '2026-09-07T00:00:01.000Z',
        feedResponseAt: '2026-09-07T00:00:02.000Z',
        renderedAt: '2026-09-07T00:00:02.100Z',
      },
    },
  });
  assert.equal(appended.ok, true);

  const logs = await harness.message({ type: 'GET_DIAGNOSTIC_LOGS' });
  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].source, 'homepage');
  assert.equal(logs.entries[0].event, 'feed.timeline');
  assert.equal(logs.entries[0].details.renderedAt, '2026-09-07T00:00:02.100Z');
  assert.ok(logs.entries[0].ts);
});

test('clears diagnostic logs', async () => {
  const harness = createHarness({ fetchImpl: async () => response(404) });
  await harness.message({
    type: 'APPEND_DIAGNOSTIC_LOG',
    entry: { source: 'feed-page', event: 'feed.timeline', details: {} },
  });
  const cleared = await harness.message({ type: 'CLEAR_DIAGNOSTIC_LOGS' });
  assert.equal(cleared.ok, true);

  const logs = await harness.message({ type: 'GET_DIAGNOSTIC_LOGS' });
  assert.deepEqual(logs.entries, []);
});

test('GET_FEED reports timing diagnostics when logging is enabled', async () => {
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=')) return response(200, makeWatchHtml(60));
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    },
  });
  await harness.message({ type: 'SAVE_PREFERENCES', preferences: { enableLogging: true } });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_DIAG'],
    forceRefresh: true,
  });
  assert.ok(result.feedDiagnostics);
  assert.ok(result.feedDiagnostics.feedRequestReceivedAt);
  assert.ok(result.feedDiagnostics.feedCompletedAt);
  assert.ok(result.feedDiagnostics.durationMs >= 0);

  const logs = await harness.message({ type: 'GET_DIAGNOSTIC_LOGS' });
  assert.ok(logs.entries.some((entry) => entry.event === 'feed.request'));
});

function makeProfileHtml(channelId) {
  return `<html><head><title>Channel</title></head><body><script>{"externalId":"${channelId}"}</script></body></html>`;
}

function makeMultiXml(channelId, count, linkFor = (videoId) => `https://www.youtube.com/watch?v=${videoId}`) {
  const published = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const entries = Array.from({ length: count }, (_, index) => `
      <entry>
        <yt:videoId>video-${channelId}-${index}</yt:videoId>
        <title>Video ${index}</title>
        <published>${published}</published>
        <link rel="alternate" href="${linkFor(`video-${channelId}-${index}`)}" />
      </entry>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <title>${channelId}</title>
      <author><name>${channelId}</name></author>
      ${entries}
  </feed>`;
}

test('handle resolutions persist so repeat loads skip resolution requests', async () => {
  let profileFetches = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/feeds/videos.xml')) {
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    }
    if (url.includes('/youtubei/v1/player')) return response(200, JSON.stringify({ videoDetails: { lengthSeconds: '60' } }));
    profileFetches++;
    return response(200, JSON.stringify({ endpoint: { browseEndpoint: { browseId: 'UC_RESOLVED' } } }));
  };

  const first = createHarness({ fetchImpl });
  const firstResult = await first.message({
    type: 'GET_FEED',
    channelIds: ['@mixed'],
    forceRefresh: true,
  });
  assert.equal(profileFetches, 1);
  assert.equal(firstResult.videos.length, 1);
  assert.equal(first.storage.resolvedChannelIds?.['@mixed'], 'UC_RESOLVED');

  const second = createHarness({ fetchImpl, initialStorage: structuredClone(first.storage) });
  const secondResult = await second.message({
    type: 'GET_FEED',
    channelIds: ['@mixed'],
    forceRefresh: true,
  });
  assert.equal(profileFetches, 1);
  assert.equal(secondResult.videos.length, 1);
});

test('keeps at most ten duration fetches active', async () => {
  let watchActive = 0;
  let watchMaximumActive = 0;
  let watchCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=')) {
        watchCalls++;
        watchActive++;
        watchMaximumActive = Math.max(watchMaximumActive, watchActive);
        await new Promise((resolve) => setTimeout(resolve, 15));
        watchActive--;
        return response(200, makeWatchHtml(30));
      }
      return response(200, makeMultiXml('UC_WIDE', 15));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_WIDE'],
    forceRefresh: true,
  });

  assert.equal(result.videos.length, 15);
  assert.equal(watchCalls, 15);
  assert.equal(watchMaximumActive, 10);
});

test('starts hydrating fast channels before slow channel RSS finishes', async () => {
  const events = [];
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=')) {
        events.push('watch');
        return response(200, makeWatchHtml(30));
      }
      const id = new URL(url).searchParams.get('channel_id');
      if (id === 'UC_SLOW') {
        await new Promise((resolve) => setTimeout(resolve, 300));
        events.push('rss-slow-done');
      }
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_FAST', 'UC_SLOW'],
    forceRefresh: true,
  });

  assert.ok(events.includes('watch'));
  assert.ok(events.indexOf('watch') < events.indexOf('rss-slow-done'));
});

function makeMixedXml(channelId) {
  const published = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <title>${channelId}</title>
      <author><name>${channelId}</name></author>
      <entry>
        <yt:videoId>video-std</yt:videoId>
        <title>Standard video</title>
        <published>${published}</published>
        <link rel="alternate" href="https://www.youtube.com/watch?v=video-std" />
      </entry>
      <entry>
        <yt:videoId>video-short</yt:videoId>
        <title>Short video</title>
        <published>${published}</published>
        <link rel="alternate" href="https://www.youtube.com/shorts/video-short" />
      </entry>
  </feed>`;
}

test('GET_FEED skips duration hydration for filtered-out video types', async () => {
  let watchCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=') || url.includes('/shorts/')) {
        watchCalls++;
        return response(200, makeWatchHtml(60));
      }
      return response(200, makeMixedXml('UC_MIXED'));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_MIXED'],
    videoTypeFilters: { standard: true, shorts: false, live: false, other: false },
    forceRefresh: true,
  });

  assert.equal(watchCalls, 1);
  assert.equal(result.videos.length, 2);
  assert.equal(result.videos.find((video) => video.id === 'video-std').duration, '1:00');
  assert.equal(result.videos.find((video) => video.id === 'video-short').duration, '');
  assert.equal(result.feedDiagnostics.hydrationRequested, 1);
  assert.equal(result.feedDiagnostics.hydrationSkipped, 1);
});

test('GET_FEED breaks down channel failures by reason', async () => {
  const harness = createHarness({
    fetchImpl: async (url) => {
      const id = new URL(url).searchParams.get('channel_id');
      if (id === 'UC_429') return response(429);
      if (id === 'UC_500') return response(503);
      if (id === 'UC_NET') throw new Error('socket hang up');
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_OK', 'UC_429', 'UC_500', 'UC_NET'],
    forceRefresh: true,
  });

  assert.equal(result.videos.length, 1);
  assert.equal(result.feedStatus.failedChannels, 3);
  // Field-by-field: the breakdown object comes from the VM realm, where
  // prototype checks make deep object equality unreliable. Primitives
  // compare fine.
  const breakdown = result.feedDiagnostics.failureBreakdown;
  assert.equal(breakdown.rateLimited, 1);
  assert.equal(breakdown.serverError, 1);
  assert.equal(breakdown.timeout, 0);
  assert.equal(breakdown.network, 1);
  assert.equal(breakdown.other, 0);
});

test('GET_FEED retries a 404 and recovers instead of failing the channel', async () => {
  let calls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=')) return response(200, makeWatchHtml(60));
      calls++;
      if (calls === 1) return response(404);
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_FLAKY'],
    forceRefresh: true,
  });

  assert.equal(result.videos.length, 1);
  assert.equal(result.feedStatus.failedChannels, 0);
});

test('GET_FEED honors Retry-After instead of the default backoff', async () => {
  let calls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=')) return response(200, makeWatchHtml(60));
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => (String(name).toLowerCase() === 'retry-after' ? '0' : null) },
          async text() { return ''; },
        };
      }
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const started = Date.now();
  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_THROTTLED'],
    forceRefresh: true,
  });

  assert.equal(result.videos.length, 1);
  assert.equal(result.feedStatus.failedChannels, 0);
  // Default backoff alone would wait a full second before retrying.
  assert.ok(Date.now() - started < 1000, 'expected the server-demanded pause to win');
});

test('strict refresh forces fetch, serves no stale cache, reports every failure', async () => {
  let shouldFail = false;
  let rssCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/youtubei/v1/player')) return response(200, JSON.stringify({ videoDetails: { lengthSeconds: '60' } }));
      rssCalls++;
      if (shouldFail) return response(503);
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const first = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_STRICT'],
    forceRefresh: true,
  });
  assert.equal(first.videos.length, 1);
  assert.equal(rssCalls, 1);

  // Strict implies force: fresh cache present, yet the network is hit again.
  const strictFresh = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_STRICT'],
    strict: true,
  });
  assert.equal(strictFresh.videos.length, 1);
  assert.equal(rssCalls, 2);

  // Age the cache past the 10-minute fresh window (stale but usable).
  harness.storage.channelFeedCacheV2.UC_STRICT.fetchedAt = Date.now() - 3600 * 1000;
  shouldFail = true;

  const strict = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_STRICT'],
    strict: true,
  });
  assert.equal(strict.videos.length, 0);
  assert.equal(strict.feedStatus.failedChannels, 1);
  assert.equal(strict.feedStatus.staleChannels, 0);

  const lenient = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_STRICT'],
  });
  assert.equal(lenient.videos.length, 1);
  assert.equal(lenient.feedStatus.staleChannels, 1);
});

test('strict refresh retries failing channels up to eight attempts', async () => {
  const attempts = new Map();
  const harness = createHarness({
    fetchImpl: async (url) => {
      const id = new URL(url).searchParams.get('channel_id');
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      return response(503);
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_STRICT_FAIL'],
    strict: true,
  });

  assert.equal(attempts.get('UC_STRICT_FAIL'), 8);
  assert.equal(result.feedStatus.failedChannels, 1);
});

test('GET_FEED reports per-stage fetch timings', async () => {
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/watch?v=')) return response(200, makeWatchHtml(60));
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_DIAG'],
    forceRefresh: true,
  });

  assert.ok(result.feedDiagnostics.rssMs >= 0);
  assert.ok(result.feedDiagnostics.hydrationMs >= 0);
  assert.equal(result.feedDiagnostics.hydrationRequested, 1);
  assert.equal(result.feedDiagnostics.hydrationSkipped, 0);
});

function playerJson(seconds) {
  return JSON.stringify({ videoDetails: { lengthSeconds: String(seconds) } });
}

test('durations come from the InnerTube player endpoint without watch-page fetches', async () => {
  let watchFetches = 0;
  let playerBodies = [];
  const harness = createHarness({
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/feeds/videos.xml')) return response(200, makeXml('UC_PLAYER', 'vid-player'));
      if (url.includes('/youtubei/v1/player')) {
        playerBodies.push(JSON.parse(init.body));
        return response(200, playerJson(754));
      }
      if (url.includes('/watch?v=')) watchFetches++;
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await harness.message({ type: 'GET_FEED', channelIds: ['UC_PLAYER'], forceRefresh: true });
  assert.equal(result.videos[0].duration, '12:34');
  assert.equal(watchFetches, 0);
  assert.equal(playerBodies.length, 1);
  assert.equal(playerBodies[0].videoId, 'vid-player');
});

test('a player response with zero length is final and skips the watch-page fallback', async () => {
  let watchFetches = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/feeds/videos.xml')) return response(200, makeXml('UC_UPCOMING', 'vid-upcoming'));
      if (url.includes('/youtubei/v1/player')) return response(200, playerJson(0));
      if (url.includes('/watch?v=')) watchFetches++;
      return response(200, makeWatchHtml(60));
    },
  });

  const result = await harness.message({ type: 'GET_FEED', channelIds: ['UC_UPCOMING'], forceRefresh: true });
  assert.equal(result.videos[0].duration, '');
  assert.equal(watchFetches, 0);
});

test('handle resolution follows a legacy urlEndpoint redirect without scraping the channel page', async () => {
  const resolveUrls = [];
  let pageFetches = 0;
  const harness = createHarness({
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/navigation/resolve_url')) {
        const target = JSON.parse(init.body).url;
        resolveUrls.push(target);
        if (target.endsWith('/@legacy')) {
          return response(200, JSON.stringify({ endpoint: { urlEndpoint: { url: 'https://www.youtube.com/c/LegacyName' } } }));
        }
        return response(200, JSON.stringify({ endpoint: { browseEndpoint: { browseId: 'UC_LEGACY' } } }));
      }
      if (url.includes('/feeds/videos.xml')) {
        const id = new URL(url).searchParams.get('channel_id');
        return response(200, makeXml(id, `video-${id}`));
      }
      if (url.includes('/youtubei/v1/player')) return response(200, playerJson(60));
      pageFetches++;
      return response(404);
    },
  });

  const result = await harness.message({ type: 'GET_FEED', channelIds: ['@legacy'], forceRefresh: true });
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].channelId, 'UC_LEGACY');
  assert.equal(resolveUrls.length, 2);
  assert.equal(resolveUrls[1], 'https://www.youtube.com/c/LegacyName');
  assert.equal(pageFetches, 0);
  assert.equal(harness.storage.resolvedChannelIds?.['@legacy'], 'UC_LEGACY');
});

test('handle resolution retries a failed InnerTube call, then falls back to the channel page', async () => {
  let resolveCalls = 0;
  let pageFetches = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/navigation/resolve_url')) {
        resolveCalls++;
        return response(503);
      }
      if (url.includes('/feeds/videos.xml')) {
        const id = new URL(url).searchParams.get('channel_id');
        return response(200, makeXml(id, `video-${id}`));
      }
      if (url.includes('/youtubei/v1/player')) return response(200, playerJson(60));
      pageFetches++;
      return response(200, makeProfileHtml('UC_FALLBACK'));
    },
  });

  const result = await harness.message({ type: 'GET_FEED', channelIds: ['@fallback'], forceRefresh: true });
  assert.equal(resolveCalls, 2);
  assert.equal(pageFetches, 1);
  assert.equal(result.videos[0].channelId, 'UC_FALLBACK');
});

test('refetching a channel reuses known durations instead of re-hydrating', async () => {
  let playerCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/feeds/videos.xml')) return response(200, makeXml('UC_CARRY', 'vid-carry'));
      if (url.includes('/youtubei/v1/player')) {
        playerCalls++;
        return response(200, playerJson(90));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  await harness.message({ type: 'GET_FEED', channelIds: ['UC_CARRY'], forceRefresh: true });
  const second = await harness.message({ type: 'GET_FEED', channelIds: ['UC_CARRY'], forceRefresh: true });
  assert.equal(second.feedStatus.fetchedChannels, 1);
  assert.equal(second.videos[0].duration, '1:30');
  assert.equal(playerCalls, 1);
  assert.equal(second.feedDiagnostics.hydrationRequested, 0);
});

test('slow duration lookups do not hold RSS slots from later channels', async () => {
  const ids = Array.from({ length: 13 }, (_, index) => `UC_SLOT_${index}`);
  let lastRssStartedAt = 0;
  let firstDurationEndedAt = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/feeds/videos.xml')) {
        lastRssStartedAt = Date.now();
        const id = new URL(url).searchParams.get('channel_id');
        return response(200, makeXml(id, `video-${id}`));
      }
      if (url.includes('/youtubei/v1/player')) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!firstDurationEndedAt) firstDurationEndedAt = Date.now();
        return response(200, playerJson(60));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await harness.message({ type: 'GET_FEED', channelIds: ids, forceRefresh: true });
  assert.equal(result.videos.length, 13);
  assert.ok(result.videos.every((video) => video.duration === '1:00'));
  assert.ok(lastRssStartedAt < firstDurationEndedAt, 'the 13th RSS request waited on hydration');
});

test('concurrent hydrations of the same video share one duration lookup', async () => {
  let playerCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/feeds/videos.xml')) return response(200, makeXml('UC_SAME', 'vid-shared'));
      if (url.includes('/navigation/resolve_url')) {
        return response(200, JSON.stringify({ endpoint: { browseEndpoint: { browseId: 'UC_SAME' } } }));
      }
      if (url.includes('/youtubei/v1/player')) {
        playerCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return response(200, playerJson(42));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await harness.message({ type: 'GET_FEED', channelIds: ['UC_SAME', '@same'], forceRefresh: true });
  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].duration, '0:42');
  assert.equal(playerCalls, 1);
});
