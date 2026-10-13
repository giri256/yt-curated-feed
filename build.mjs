/**
 * build.mjs  —  YT Curated Feed
 *
 * This extension has zero npm dependencies (uses YouTube's public RSS API).
 * "Building" just means copying src/ into dist/ so Chrome can load it.
 *
 * Usage:
 *   node build.mjs
 *
 * Alternatively, skip the build entirely and point Chrome's "Load unpacked"
 * at the PROJECT ROOT — the manifest.json there references src/ directly.
 */

import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT       = resolve(__dirname, 'dist');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT,                    { recursive: true });
mkdirSync(resolve(OUT, 'src'),   { recursive: true });
mkdirSync(resolve(OUT, 'icons'), { recursive: true });

// Every file in src/ ships; a hand-kept list silently dropped new files.
const srcFiles = readdirSync(resolve(__dirname, 'src'));

for (const f of srcFiles) {
  const src  = resolve(__dirname, 'src', f);
  const dest = resolve(OUT, 'src', f);
  if (existsSync(src)) { copyFileSync(src, dest); console.log(`  [copy] src/${f}`); }
  else console.warn(`  [warn] src/${f} not found — skipping`);
}

copyFileSync(resolve(__dirname, 'manifest.json'), resolve(OUT, 'manifest.json'));
console.log('  [copy] manifest.json');

const iconsDir = resolve(__dirname, 'icons');
if (existsSync(iconsDir)) {
  for (const f of readdirSync(iconsDir)) {
    copyFileSync(resolve(iconsDir, f), resolve(OUT, 'icons', f));
  }
  console.log('  [copy] icons/*');
}

console.log('\n✅  dist/ is ready.');
console.log('    → In Chrome: chrome://extensions → Developer mode ON → Load unpacked → select dist/\n');
