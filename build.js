/* Builds the deployable bundles from public/:
   1. dist/transcriber.html — single self-contained file for the internal-microsites
      platform (direct-to-Soniox mode; DROPBOX_TOKEN from .env embedded when set).
   2. docs/ — the same app as an installable PWA for GitHub Pages: index.html +
      manifest + service worker (+ icons from make-icons.js). Never carries the
      Dropbox token: this bundle is meant for a public host.
   Run: node build.js */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');
const DOCS = path.join(ROOT, 'docs');

const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

// .env is never committed; DROPBOX_TOKEN from it is embedded into the microsite
// build so the published page can back up recordings/transcripts. Absent → off.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const DBX = process.env.DROPBOX_TOKEN || '';

const css = read('style.css');
const sessions = read('sessions.js');
const app = read('app.js');
const index = read('index.html');

const replaceOnce = (haystack, needle, replacement) => {
  if (!haystack.includes(needle)) {
    console.error(`✗ build failed: could not find ${JSON.stringify(needle)} in index.html`);
    process.exit(1);
  }
  return haystack.replace(needle, () => replacement); // fn replacer: no $-substitution surprises
};

// one self-contained page; the Dropbox token is only ever in the microsite build
function buildHtml(dbxToken) {
  let html = index;
  html = replaceOnce(html, '<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
  html = replaceOnce(html, '<script src="sessions.js"></script>',
    `<script>\nwindow.__DIRECT__ = true; // single-file build: browser talks to api.soniox.com directly\n`
    + (dbxToken ? `window.__DBX_TOKEN__ = ${JSON.stringify(dbxToken)}; // Dropbox backup (from .env at build time)\n` : '')
    + `${sessions}\n</script>`);
  html = replaceOnce(html, '<script src="app.js"></script>', `<script>\n${app}\n</script>`);
  return html;
}

/* ---------- 1. microsite single file ---------- */

const micrositeHtml = buildHtml(DBX);

// The microsites platform rejects HTML with relative asset references; only
// https:, data:, blob:, and #anchors are self-contained.
const relRef = micrositeHtml.match(/(?:src|href)="(?!https:|data:|#)[^"]*"/);
if (relRef) {
  console.error(`✗ build failed: relative reference remains: ${relRef[0]}`);
  process.exit(1);
}
if (!/^<!doctype html>/i.test(micrositeHtml)) {
  console.error('✗ build failed: file must start with <!doctype html>');
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'transcriber.html'), micrositeHtml);
console.log(`✓ dist/transcriber.html — ${(micrositeHtml.length / 1024).toFixed(1)} KB, self-contained`);
console.log(`  Dropbox backup: ${DBX ? 'token embedded from .env — do not commit this build' : 'no DROPBOX_TOKEN in .env — feature off in this build'}`);
console.log('  Publish it with /publish-page in Slack (upload dist/transcriber.html).');

/* ---------- 2. GitHub Pages PWA ---------- */

const ver = crypto.createHash('md5').update(buildHtml('')).digest('hex').slice(0, 10);

const manifest = {
  name: 'Interview Transcriber',
  short_name: 'Transcriber',
  description: 'Drag-and-drop Soniox transcription with a synced player and word-level transcript editor',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#f5f3ef',
  theme_color: '#4f46e5',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const sw = `/* Interview Transcriber service worker — app shell cached for offline use;
   API calls (Soniox, Dropbox) are cross-origin and never intercepted. */
'use strict';
const CACHE = 'transcriber-${ver}';
const SHELL = ['./', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// cache-first with background refresh: instant loads, updates on the next visit
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
`;

let pages = buildHtml(''); // public host: never embed the Dropbox token
pages = replaceOnce(pages, '</head>',
  `<link rel="manifest" href="manifest.webmanifest">\n`
  + `<meta name="theme-color" content="#4f46e5">\n`
  + `<link rel="apple-touch-icon" href="apple-touch-icon.png">\n`
  + `<meta name="apple-mobile-web-app-capable" content="yes">\n`
  + `<meta name="apple-mobile-web-app-status-bar-style" content="default">\n`
  + `</head>`);
pages = replaceOnce(pages, '</body>',
  `<script>\nif ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {\n`
  + `  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));\n`
  + `}\n</script>\n</body>`);

fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, 'index.html'), pages);
fs.writeFileSync(path.join(DOCS, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(DOCS, 'sw.js'), sw);
fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');
const haveIcons = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
  .every((f) => { try { return fs.statSync(path.join(DOCS, f)).size > 0; } catch { return false; } });
console.log(`✓ docs/ PWA — index.html ${(pages.length / 1024).toFixed(1)} KB, sw cache transcriber-${ver}, no Dropbox token`);
if (!haveIcons) console.log('  ⚠ icons missing — run: node make-icons.js');
