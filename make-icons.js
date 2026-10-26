/* Generates the PWA icons (indigo tile + white waveform bars) into docs/.
   Zero dependencies — a minimal PNG encoder over zlib. Run once: node make-icons.js */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, 'docs');

/* ---- tiny PNG writer (8-bit RGBA) ---- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- the mark: full-bleed indigo tile, three white rounded bars ---- */

const BG = [0x4f, 0x46, 0xe5];     // --accent
const FG = [0xff, 0xff, 0xff];

// capsule signed distance: vertical bar centred at (cx, cy), half-height hh, radius r
function capsule(px, py, cx, cy, hh, r) {
  const dy = Math.max(Math.abs(py - cy) - hh, 0);
  return Math.hypot(px - cx, dy) - r;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bars = [
    { cx: 0.335, hh: 0.115 },
    { cx: 0.500, hh: 0.215 },
    { cx: 0.665, hh: 0.155 },
  ];
  const r = size * 0.052;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let d = Infinity;
      for (const b of bars) {
        d = Math.min(d, capsule(px, py, b.cx * size, size / 2, b.hh * size, r));
      }
      // 1px smooth edge between bar and background
      const t = Math.max(0, Math.min(1, 0.5 - d));
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(BG[0] + (FG[0] - BG[0]) * t);
      rgba[o + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * t);
      rgba[o + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * t);
      rgba[o + 3] = 255;
    }
  }
  return png(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  fs.writeFileSync(path.join(OUT_DIR, name), drawIcon(size));
  console.log(`✓ docs/${name} (${size}×${size})`);
}
