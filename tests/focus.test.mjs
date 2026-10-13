import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const backgroundSource = read('../src/background.js');

// Evaluates an object literal assigned to `const <name> = {...};` in a source file.
function extractObject(source, name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      return vm.runInNewContext(`(${source.slice(source.indexOf('{', start), i + 1)})`);
    }
  }
  throw new Error('unbalanced');
}

function createWorker() {
  const storage = {};
  let listener = null;
  const chrome = {
    runtime: { lastError: null, onMessage: { addListener(l) { listener = l; } }, sendMessage() {} },
    storage: {
      local: {
        get(key, cb) { queueMicrotask(() => cb({ [key]: storage[key] })); },
        set(data, cb) { Object.assign(storage, structuredClone(data)); queueMicrotask(() => cb?.()); },
      },
      session: { get(key, cb) { queueMicrotask(() => cb({})); }, set(_d, cb) { queueMicrotask(() => cb?.()); } },
    },
    tabs: { async query() { return []; }, onRemoved: { addListener() {} } },
    windows: { async update() {} },
  };
  vm.runInContext(backgroundSource, vm.createContext({
    AbortController, URL, chrome, console, fetch: async () => ({ ok: false, status: 404, text: async () => '' }),
    queueMicrotask, setTimeout, clearTimeout, structuredClone,
  }));
  const message = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
  return { message, storage };
}

test('focus.js defaults mirror the worker defaults', () => {
  const workerDefaults = extractObject(backgroundSource, 'DEFAULT_PREFERENCES').focus;
  const contentDefaults = extractObject(read('../src/focus.js'), 'FOCUS_DEFAULTS');
  assert.equal(JSON.stringify(contentDefaults), JSON.stringify(workerDefaults));
});

test('every focus key has a CSS rule, except the ones page-main.js handles', () => {
  const css = read('../src/focus.css');
  const keys = Object.keys(extractObject(read('../src/focus.js'), 'FOCUS_DEFAULTS'));
  for (const key of keys) {
    if (key === 'disableAutoplay') continue;
    const className = `ytcf-${key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`)}`;
    assert.ok(css.includes(`html.${className} `), `no rule for ${className}`);
  }
});

test('preferences default to full homepage, auto quality and focus defaults', async () => {
  const worker = createWorker();
  const { preferences } = await worker.message({ type: 'GET_PREFERENCES' });
  assert.equal(preferences.homepageMode, 'full');
  assert.equal(preferences.preferredQuality, 'auto');
  assert.equal(preferences.focus.hideShorts, true);
  assert.equal(preferences.focus.hideLiveChat, false);
});

test('saving merges focus keys and rejects invalid layout values', async () => {
  const worker = createWorker();
  await worker.message({ type: 'SAVE_PREFERENCES', preferences: { focus: { hideLiveChat: true } } });
  const saved = await worker.message({
    type: 'SAVE_PREFERENCES',
    preferences: { focus: { hideComments: true, bogus: true }, homepageMode: 'sideways', preferredQuality: 'hd1080' },
  });
  assert.equal(saved.preferences.focus.hideLiveChat, true);
  assert.equal(saved.preferences.focus.hideComments, true);
  assert.equal(saved.preferences.focus.hideShorts, true);
  assert.equal('bogus' in saved.preferences.focus, false);
  assert.equal(saved.preferences.homepageMode, 'full');
  assert.equal(saved.preferences.preferredQuality, 'hd1080');

  const panel = await worker.message({ type: 'SAVE_PREFERENCES', preferences: { homepageMode: 'panel' } });
  assert.equal(panel.preferences.homepageMode, 'panel');
  assert.equal(panel.preferences.preferredQuality, 'hd1080');
});

test('quality pin picks the closest level at or below the target', () => {
  const source = read('../src/page-main.js');
  const order = source.match(/const QUALITY_ORDER = (\[[^\]]+\]);/)[1];
  const fnStart = source.indexOf('function closestQuality');
  const fnEnd = source.indexOf('\n  }\n', fnStart) + 4;
  const closestQuality = vm.runInNewContext(`const QUALITY_ORDER = ${order}; ${source.slice(fnStart, fnEnd)}; closestQuality`);
  assert.equal(closestQuality('hd1080', ['hd2160', 'hd1080', 'hd720', 'large']), 'hd1080');
  assert.equal(closestQuality('hd1080', ['hd720', 'large', 'medium']), 'hd720');
  assert.equal(closestQuality('hd1440', ['hd2160', 'hd1080']), 'hd1080');
  assert.equal(closestQuality('tiny', ['hd720', 'large']), 'large');
  assert.equal(closestQuality('hd1080', []), null);
});
