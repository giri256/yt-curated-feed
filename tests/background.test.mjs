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

function makePlayerJson(seconds) {
  return JSON.stringify({ videoDetails: { lengthSeconds: String(seconds) } });
}

function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return body; },
  };
}

test('hydrates feed videos with their YouTube player duration', async () => {
  let durationFetches = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/feeds/videos.xml')) {
        return response(200, makeXml('UC_DURATION', 'video-duration'));
      }
      if (url.includes('/watch?v=video-duration')) {
        durationFetches++;
        return response(200, makeWatchHtml(3723));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_DURATION'],
    forceRefresh: true,
  });

  assert.equal(result.videos[0].duration, '1:02:03');
  assert.equal(durationFetches, 1);
});

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
      // Exercise the service worker's regex fallback, which is also used when
      // DOMParser is unavailable in a worker context.
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

  return {
    message,
    storage,
    closeTab: (tabId) => chrome.tabs.remove(tabId),
  };
}

test('retries a transient channel failure instead of dropping it', async () => {
  const attempts = new Map();
  const harness = createHarness({
    fetchImpl: async (url) => {
      const id = new URL(url).searchParams.get('channel_id');
      const count = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, count);
      if (id === 'UC_A' && count === 1) return response(503);
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_A', 'UC_B'],
    channelsMeta: {},
    forceRefresh: true,
  });

  assert.deepEqual(Array.from(result.videos, (video) => video.id).sort(), ['video-UC_A', 'video-UC_B']);
  assert.equal(attempts.get('UC_A'), 2);
  assert.equal(result.feedStatus.failedChannels, 0);
  assert.equal(result.feedStatus.successfulChannels, 2);
});

test('returns an explicit partial-feed issue after permanent failure', async () => {
  const attempts = new Map();
  const harness = createHarness({
    fetchImpl: async (url) => {
      const id = new URL(url).searchParams.get('channel_id');
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      if (id === 'UC_FAIL') return response(503);
      return response(200, makeXml(id, `video-${id}`));
    },
  });

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: ['UC_GOOD', 'UC_FAIL'],
    channelsMeta: { UC_FAIL: { name: 'Unavailable channel' } },
    forceRefresh: true,
  });

  assert.deepEqual(Array.from(result.videos, (video) => video.id), ['video-UC_GOOD']);
  assert.equal(attempts.get('UC_FAIL'), 4);
  assert.equal(result.feedStatus.failedChannels, 1);
  assert.equal(result.feedStatus.issues[0].channelName, 'Unavailable channel');
  assert.equal(result.feedStatus.issues[0].httpStatus, 503);
  assert.equal(result.feedStatus.issues[0].usingStaleCache, false);
});

test('uses fresh cache for speed and stale successful cache on refresh failure', async () => {
  let shouldFail = false;
  let rssCalls = 0;
  let browseCalls = 0;
  let durationCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/youtubei/v1/player')) {
        durationCalls++;
        return response(200, makePlayerJson(125));
      }
      if (url.includes('/youtubei/v1/browse')) {
        browseCalls++;
        return response(503);
      }
      rssCalls++;
      if (shouldFail) return response(503);
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, 'cached-video'));
    },
  });

  const first = await harness.message({ type: 'GET_FEED', channelIds: ['UC_CACHE'], forceRefresh: true });
  assert.equal(first.videos.length, 1);
  assert.equal(first.videos[0].duration, '2:05');
  assert.equal(rssCalls, 1);
  assert.equal(durationCalls, 1);

  const second = await harness.message({ type: 'GET_FEED', channelIds: ['UC_CACHE'] });
  assert.equal(second.videos.length, 1);
  assert.equal(second.feedStatus.cachedChannels, 1);
  assert.equal(rssCalls, 1);
  assert.equal(durationCalls, 1);

  shouldFail = true;
  const third = await harness.message({ type: 'GET_FEED', channelIds: ['UC_CACHE'], forceRefresh: true });
  assert.equal(third.videos[0].id, 'cached-video');
  assert.equal(third.feedStatus.failedChannels, 0);
  assert.equal(third.feedStatus.staleChannels, 1);
  assert.equal(third.feedStatus.issues[0].usingStaleCache, true);
  assert.equal(rssCalls, 5);
  assert.equal(browseCalls, 2);
  assert.equal(durationCalls, 1);
});

test('deduplicates selected IDs and keeps at most twelve channel requests active', async () => {
  let rssActive = 0;
  let rssMaximumActive = 0;
  let rssCalls = 0;
  let durationCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url) => {
      if (url.includes('/youtubei/v1/player')) {
        durationCalls++;
        return response(200, makePlayerJson(30));
      }
      rssCalls++;
      rssActive++;
      rssMaximumActive = Math.max(rssMaximumActive, rssActive);
      await new Promise((resolve) => setTimeout(resolve, 15));
      rssActive--;
      const id = new URL(url).searchParams.get('channel_id');
      return response(200, makeXml(id, `video-${id}`));
    },
  });
  const ids = Array.from({ length: 15 }, (_, index) => `UC_${index}`);

  const result = await harness.message({
    type: 'GET_FEED',
    channelIds: [ids[0], ...ids, ids[0]],
    forceRefresh: true,
  });

  assert.equal(rssCalls, ids.length);
  assert.equal(durationCalls, ids.length);
  assert.equal(result.videos.length, ids.length);
  assert.equal(rssMaximumActive, 12);
});

test('scrape progress is temporary and final commit preserves selected channels', async () => {
  const oldChannels = [
    { id: 'UC_OLD', name: 'Old subscription', thumbnail: 'https://img/old.jpg' },
    { id: 'UC_KEEP', name: 'Selected channel', thumbnail: 'https://img/keep.jpg' },
  ];
  const harness = createHarness({
    fetchImpl: async () => response(404),
    initialStorage: {
      allChannels: oldChannels,
      selectedChannelIds: ['UC_KEEP'],
      selectedChannelsMeta: {
        UC_KEEP: { name: 'Selected channel', thumbnail: 'https://img/keep.jpg' },
      },
    },
  });

  const started = await harness.message({ type: 'SCRAPE_CHANNELS' });
  assert.equal(started.started, true);

  await harness.message({
    type: 'CHANNELS_PROGRESS',
    channels: [{ id: 'UC_NEW', name: 'New subscription', thumbnail: 'https://img/new.jpg' }],
  }, { tab: { id: started.tabId } });
  assert.deepEqual(harness.storage.allChannels, oldChannels);
  assert.equal(harness.storage.scrapeProgressCount, 1);

  await harness.message({
    type: 'CHANNELS_READY',
    channels: [{ id: 'UC_NEW', name: 'New subscription', thumbnail: 'https://img/new.jpg' }],
  }, { tab: { id: started.tabId } });

  assert.deepEqual(harness.storage.allChannels.map((channel) => channel.id), ['UC_NEW', 'UC_KEEP']);
  assert.equal(harness.storage.scrapeInProgress, false);
  assert.deepEqual(harness.storage.scrapeChannelsProgress, []);
});

test('final scrape migrates a selected handle to its canonical channel ID', async () => {
  const harness = createHarness({
    fetchImpl: async () => response(404),
    initialStorage: {
      selectedChannelIds: ['@chosen'],
      selectedChannelsMeta: {
        '@chosen': { name: 'Chosen', handle: '@chosen', thumbnail: 'https://img/old.jpg' },
      },
    },
  });

  const started = await harness.message({ type: 'SCRAPE_CHANNELS' });
  await harness.message({
    type: 'CHANNELS_READY',
    channels: [{
      id: 'UC_CANONICAL',
      name: 'Chosen',
      handle: '@chosen',
      thumbnail: 'https://img/new.jpg',
    }],
  }, { tab: { id: started.tabId } });

  assert.deepEqual(Array.from(harness.storage.selectedChannelIds), ['UC_CANONICAL']);
  assert.equal(harness.storage.selectedChannelsMeta.UC_CANONICAL.handle, '@chosen');
  assert.equal(harness.storage.selectedChannelsMeta['@chosen'], undefined);
  assert.deepEqual(Array.from(harness.storage.allChannels, (channel) => channel.id), ['UC_CANONICAL']);
});

test('closing the scrape tab cancels loading and preserves the committed list', async () => {
  const previousChannels = [
    { id: 'UC_PREVIOUS', name: 'Previous channel', thumbnail: 'https://img/previous.jpg' },
  ];
  const harness = createHarness({
    fetchImpl: async () => response(404),
    initialStorage: { allChannels: previousChannels },
  });

  const started = await harness.message({ type: 'SCRAPE_CHANNELS' });
  await harness.closeTab(started.tabId);
  const status = await harness.message({ type: 'GET_SCRAPE_STATUS' });

  assert.equal(status.inProgress, false);
  assert.match(status.error, /tab was closed/i);
  assert.deepEqual(harness.storage.allChannels, previousChannels);
});

test('tracks session-opened videos and enforces the configured daily watch limit', async () => {
  const harness = createHarness({ fetchImpl: async () => response(404) });

  await harness.message({ type: 'MARK_VIDEO_OPENED', videoId: 'video-1' });
  const opened = await harness.message({ type: 'GET_OPENED_VIDEOS' });
  assert.deepEqual(Array.from(opened.videoIds), ['video-1']);

  await harness.message({ type: 'SAVE_WATCH_LIMIT', minutes: 1 });
  let result;
  for (let index = 0; index < 4; index++) {
    result = await harness.message({ type: 'WATCH_TIME_DELTA', seconds: 15 });
  }
  assert.equal(result.stats.todaySeconds, 60);
  assert.equal(result.stats.blocked, true);
});

function makeBrowseJson(items) {
  return JSON.stringify({
    metadata: { channelMetadataRenderer: { title: 'Fallback Channel', avatar: { thumbnails: [{ url: 'https://yt3.googleusercontent.com/avatar=s900' }] } } },
    contents: { twoColumnBrowseResultsRenderer: { tabs: [
      { tabRenderer: { title: 'Home' } },
      { tabRenderer: { selected: true, content: { richGridRenderer: { contents: items.map(({ id, title, views, ago, duration }) => ({
        richItemRenderer: { content: { lockupViewModel: {
          contentId: id,
          contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
          contentImage: { thumbnailViewModel: { overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: duration } }] } }] } },
          metadata: { lockupMetadataViewModel: {
            title: { content: title },
            metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: views } }, { text: { content: ago } }] }] } },
          } },
        } } },
      })) } } } },
    ] } },
  });
}

test('falls back to the InnerTube videos tab when RSS keeps failing', async () => {
  let rssCalls = 0;
  let browseBodies = [];
  let durationCalls = 0;
  const harness = createHarness({
    fetchImpl: async (url, init = {}) => {
      if (url.includes('/youtubei/v1/browse')) {
        browseBodies.push(JSON.parse(init.body));
        return response(200, makeBrowseJson([
          { id: 'fresh-video', title: 'Fresh lecture', views: '8.3K views', ago: '12 hours ago', duration: '7:47' },
          { id: 'week-old', title: 'Old lecture', views: '1M views', ago: '3 weeks ago', duration: '1:02:03' },
        ]));
      }
      if (url.includes('/youtubei/v1/player')) {
        durationCalls++;
        return response(200, makePlayerJson(60));
      }
      rssCalls++;
      return response(500);
    },
  });

  const before = Date.now();
  const resp = await harness.message({ type: 'GET_FEED', channelIds: ['UC_FALLBACK'], forceRefresh: true });
  assert.equal(rssCalls, 2);
  assert.equal(browseBodies.length, 1);
  assert.equal(browseBodies[0].browseId, 'UC_FALLBACK');
  assert.equal(resp.feedStatus.failedChannels, 0);
  assert.equal(resp.videos.map((video) => video.id).join(','), 'fresh-video');
  const [video] = resp.videos;
  assert.equal(video.title, 'Fresh lecture');
  assert.equal(video.duration, '7:47');
  assert.equal(video.channelName, 'Fallback Channel');
  assert.equal(video.viewCount, '8.3K views');
  assert.equal(video.publishedApprox, true);
  assert.ok(Math.abs(before - 12 * 60 * 60 * 1000 - video.publishedAt) < 5000);
  assert.equal(durationCalls, 0);
});
