import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const extensionPath = realpathSync(resolve(
  process.env.YTCF_EXTENSION_PATH || resolve(projectRoot, 'dist')
));
const manifestPath = resolve(extensionPath, 'manifest.json');

if (!existsSync(manifestPath)) {
  throw new Error(`No unpacked extension manifest at ${manifestPath}. Run npm run build first.`);
}

const braveCandidates = [
  process.env.BRAVE_EXECUTABLE_PATH,
  '/usr/bin/brave-browser',
  '/bin/brave-browser',
].filter(Boolean);
const braveExecutable = braveCandidates.find(existsSync);
if (!braveExecutable) {
  throw new Error('Brave Browser was not found. Set BRAVE_EXECUTABLE_PATH.');
}

const profileDir = mkdtempSync(resolve(tmpdir(), 'ytcf-brave-smoke-'));
const launchArgs = [
  '--headless=new',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profileDir}`,
  '--remote-debugging-port=0',
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  'about:blank',
];

const browser = spawn(braveExecutable, launchArgs, {
  detached: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let devtoolsPort = null;
let browserLog = '';
browser.stderr.setEncoding('utf8');
browser.stderr.on('data', (chunk) => {
  browserLog = `${browserLog}${chunk}`.slice(-20_000);
});

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate, timeoutMs, description) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    if (browser.exitCode != null) {
      throw new Error(`Brave exited early with code ${browser.exitCode}.\n${browserLog}`);
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.\n${browserLog}`);
}

function deriveExtensionId(unpackedPath) {
  const digest = createHash('sha256').update(unpackedPath).digest().subarray(0, 16);
  return [...digest]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

async function getTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return response.ok ? await response.json() : [];
  } catch (_) {
    return [];
  }
}

async function createTarget(port, url) {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
  );
  if (!response.ok) throw new Error(`Could not create Brave target (${response.status}).`);
  return await response.json();
}

async function evaluate(target, expression, timeoutMs = 45_000) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', () => rejectOpen(new Error('CDP WebSocket failed to open.')), { once: true });
  });

  const id = 1;
  const result = await new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => rejectResult(new Error('CDP evaluation timed out.')), timeoutMs);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      if (message.error) rejectResult(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        rejectResult(new Error(message.result.exceptionDetails.exception?.description || 'Browser evaluation failed.'));
      } else {
        resolveResult(message.result?.result?.value);
      }
    });
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });
  socket.close();
  return result;
}

async function closeBrowserThroughCdp() {
  if (!devtoolsPort) return;
  try {
    const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/version`);
    const version = await response.json();
    if (!version.webSocketDebuggerUrl) return;

    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolveClose) => {
      const finish = () => resolveClose();
      const timeout = setTimeout(finish, 1500);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ id: 99, method: 'Browser.close' }));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        if (JSON.parse(event.data).id !== 99) return;
        clearTimeout(timeout);
        finish();
      });
      socket.addEventListener('close', () => {
        clearTimeout(timeout);
        finish();
      }, { once: true });
      socket.addEventListener('error', finish, { once: true });
    });
    socket.close();
  } catch (_) {}
}

async function stopBrowser() {
  await closeBrowserThroughCdp();
  try { process.kill(-browser.pid, 'SIGTERM'); } catch (_) {}
  await delay(500);
  try { process.kill(-browser.pid, 'SIGKILL'); } catch (_) {}

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(200);
    }
  }
}

try {
  const activePortPath = resolve(profileDir, 'DevToolsActivePort');
  devtoolsPort = await waitFor(() => {
    if (!existsSync(activePortPath)) return null;
    return Number(readFileSync(activePortPath, 'utf8').split(/\r?\n/)[0]) || null;
  }, 20_000, 'Brave DevTools port');

  const extensionId = deriveExtensionId(extensionPath);
  const feedUrl = `chrome-extension://${extensionId}/src/feed.html`;
  const pageTarget = await createTarget(devtoolsPort, feedUrl);

  await waitFor(async () => {
    const targets = await getTargets(devtoolsPort);
    return targets.find((target) =>
      target.type === 'service_worker'
      && target.url === `chrome-extension://${extensionId}/src/background.js`
    );
  }, 20_000, 'extension MV3 service worker');

  const liveResult = await evaluate(pageTarget, `
    (async () => {
      const send = (message) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else if (response?.error) reject(new Error(response.error));
          else resolve(response);
        });
      });
      const feed = await send({
        type: 'GET_FEED',
        channelIds: ['UC_x5XG1OV2P6uZZ5FSM9Ttw', '@GoogleDevelopers'],
        channelsMeta: {
          UC_x5XG1OV2P6uZZ5FSM9Ttw: { name: 'Google for Developers' }
        },
        forceRefresh: true
      });
      // Direct InnerTube canary from an extension origin: proves YouTube
      // accepts the player call itself, not just the watch-page fallback.
      const playerStartedAt = Date.now();
      const playerResp = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        body: JSON.stringify({
          context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } },
          videoId: feed.videos?.[0]?.id || 'dQw4w9WgXcQ',
        }),
      });
      const playerJson = playerResp.ok ? await playerResp.json() : null;
      const innertube = {
        status: playerResp.status,
        lengthSeconds: playerJson?.videoDetails?.lengthSeconds ?? null,
        ms: Date.now() - playerStartedAt,
      };
      return {
        innertube,
        title: document.title,
        manifest: chrome.runtime.getManifest(),
        feedStatus: feed.feedStatus,
        videoCount: feed.videos?.length ?? 0,
        withDuration: feed.videos?.filter((video) => video.duration).length ?? 0,
        diagnostics: feed.feedDiagnostics,
      };
    })()
  `);

  console.log(`Live result: ${JSON.stringify({ feedStatus: liveResult.feedStatus, videoCount: liveResult.videoCount, withDuration: liveResult.withDuration, innertube: liveResult.innertube, diagnostics: liveResult.diagnostics })}`);
  assert.equal(liveResult.title, 'YT Curated Feed');
  assert.equal(liveResult.manifest.name, 'YT Curated Feed');
  assert.equal(liveResult.manifest.manifest_version, 3);
  assert.equal(liveResult.feedStatus.requestedChannels, 2);
  assert.equal(liveResult.feedStatus.failedChannels, 0);
  assert.equal(liveResult.feedStatus.fetchedChannels, 2);
  // InnerTube from the service worker: the handle resolved and every
  // hydrated video got a duration (zero only for upcoming/live premieres).
  assert.equal(liveResult.diagnostics.handleResolutions, 1);
  assert.equal(liveResult.innertube.status, 200);
  assert.ok(Number(liveResult.innertube.lengthSeconds) >= 0);
  assert.equal(liveResult.withDuration, liveResult.videoCount);

  console.log(`Brave: ${braveExecutable}`);
  console.log(`Extension: ${extensionPath}`);
  console.log(`MV3 service worker: OK (${extensionId})`);
  console.log(`Live YouTube RSS: OK (${liveResult.videoCount} recent videos parsed)`);
  console.log(`InnerTube: handle resolved, ${liveResult.withDuration}/${liveResult.videoCount} durations, player call ${liveResult.innertube.ms}ms`);
} finally {
  await stopBrowser();
}
