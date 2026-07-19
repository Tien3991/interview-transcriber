/* Builds the single self-contained HTML file for the internal-microsites platform.
   Inlines style.css + sessions.js + app.js into public/index.html, flips the client
   into direct-to-Soniox mode (no proxy server), and writes dist/transcriber.html.
   Run: node build.js */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'transcriber.html');

const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

let html = read('index.html');
const css = read('style.css');
const sessions = read('sessions.js');
const app = read('app.js');

const replaceOnce = (haystack, needle, replacement) => {
  if (!haystack.includes(needle)) {
    console.error(`✗ build failed: could not find ${JSON.stringify(needle)} in index.html`);
    process.exit(1);
  }
  return haystack.replace(needle, () => replacement); // fn replacer: no $-substitution surprises
};

html = replaceOnce(html, '<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`);
html = replaceOnce(html, '<script src="sessions.js"></script>',
  `<script>\nwindow.__DIRECT__ = true; // single-file build: browser talks to api.soniox.com directly\n${sessions}\n</script>`);
html = replaceOnce(html, '<script src="app.js"></script>', `<script>\n${app}\n</script>`);

// The microsites platform rejects HTML with relative asset references; only
// https:, data:, blob:, and #anchors are self-contained.
const relRef = html.match(/(?:src|href)="(?!https:|data:|#)[^"]*"/);
if (relRef) {
  console.error(`✗ build failed: relative reference remains: ${relRef[0]}`);
  process.exit(1);
}
if (!/^<!doctype html>/i.test(html)) {
  console.error('✗ build failed: file must start with <!doctype html>');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`✓ built ${path.relative(ROOT, OUT)} — ${(html.length / 1024).toFixed(1)} KB, self-contained`);
console.log('  Publish it with /publish-page in Slack (upload dist/transcriber.html).');
