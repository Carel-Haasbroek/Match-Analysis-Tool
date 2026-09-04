'use strict';
/*
 * Generates build/icon.ico and build/icon.png from code, so the icon is
 * reproducible and reviewable rather than an opaque binary in the repo.
 *
 *   node build/make-icon.js
 *
 * No dependencies: the PNG encoder is a few lines over zlib, and an .ico is
 * just a small header wrapping PNG payloads.
 *
 * The mark: the app's deep indigo panel, a magenta play triangle, and the cyan
 * timeline with one note mark on it - the two colours the UI uses for "action"
 * and "time".
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG ---------- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba){
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++){
    raw[y * (stride + 1)] = 0;                          /* filter: none */
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    /* bit depth */
  ihdr[9] = 6;    /* colour type: RGBA */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- drawing, in a 0..1 unit square ---------- */
function hex(s){
  return [parseInt(s.slice(1,3),16), parseInt(s.slice(3,5),16), parseInt(s.slice(5,7),16)];
}
const PANEL_TOP = hex('#241a44');
const PANEL_BOT = hex('#120d1f');
const MAGENTA   = hex('#ff4d9d');
const CYAN      = hex('#3ce8e0');

function insideRoundRect(x, y, r){
  const cx = Math.min(x, 1 - x), cy = Math.min(y, 1 - y);
  if (cx > r || cy > r) return x >= 0 && x <= 1 && y >= 0 && y <= 1;
  const dx = r - cx, dy = r - cy;
  return dx * dx + dy * dy <= r * r;
}
/* point-in-triangle by sign of cross products */
function insideTri(x, y, a, b, c){
  const s = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(neg && pos);
}
function insideRect(x, y, x0, y0, x1, y1){ return x >= x0 && x <= x1 && y >= y0 && y <= y1; }

/* Returns [r,g,b,a] for a point, or null for transparent. */
function shade(x, y){
  if (!insideRoundRect(x, y, 0.22)) return null;

  const t = Math.max(0, Math.min(1, y));
  let col = [
    Math.round(PANEL_TOP[0] + (PANEL_BOT[0] - PANEL_TOP[0]) * t),
    Math.round(PANEL_TOP[1] + (PANEL_BOT[1] - PANEL_TOP[1]) * t),
    Math.round(PANEL_TOP[2] + (PANEL_BOT[2] - PANEL_TOP[2]) * t)
  ];

  /* Timeline with one note mark. Both are chunky on purpose: at 16px thin shapes
     average away to a smudge when the supersampled render is downsampled. */
  if (insideRect(x, y, 0.175, 0.750, 0.825, 0.825)) col = CYAN;
  if (insideRect(x, y, 0.590, 0.695, 0.665, 0.880)) col = MAGENTA;

  /* play triangle, sized to stay legible in a taskbar */
  if (insideTri(x, y, [0.290, 0.165], [0.290, 0.625], [0.760, 0.395])) col = MAGENTA;

  return [col[0], col[1], col[2], 255];
}

/* supersample, because a 16px icon with hard edges looks broken */
function render(size){
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++){
    for (let px = 0; px < size; px++){
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++){
        for (let sx = 0; sx < SS; sx++){
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (c){ r += c[0]; g += c[1]; b += c[2]; a += c[3]; }
        }
      }
      const n = SS * SS, i = (py * size + px) * 4;
      /* average colour over covered samples only, so edges do not darken toward black */
      const cov = a / 255;
      out[i]     = cov ? Math.round(r / cov) : 0;
      out[i + 1] = cov ? Math.round(g / cov) : 0;
      out[i + 2] = cov ? Math.round(b / cov) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ---------- .ico ---------- */
function buildIco(entries){
  const dir = Buffer.alloc(6 + 16 * entries.length);
  dir.writeUInt16LE(0, 0);                 /* reserved */
  dir.writeUInt16LE(1, 2);                 /* type: icon */
  dir.writeUInt16LE(entries.length, 4);

  let offset = dir.length;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    dir[p]     = e.size >= 256 ? 0 : e.size;   /* 0 means 256 */
    dir[p + 1] = e.size >= 256 ? 0 : e.size;
    dir[p + 2] = 0;                             /* palette count */
    dir[p + 3] = 0;                             /* reserved */
    dir.writeUInt16LE(1, p + 4);                /* colour planes */
    dir.writeUInt16LE(32, p + 6);               /* bits per pixel */
    dir.writeUInt32LE(e.png.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += e.png.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.png)]);
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map((size) => ({ size, png: encodePng(size, size, render(size)) }));

const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon.ico'), buildIco(entries));
fs.writeFileSync(path.join(dir, 'icon.png'), entries[entries.length - 1].png);

console.log('icon.ico  ' + SIZES.join(', ') + '  (' + fs.statSync(path.join(dir, 'icon.ico')).size + ' bytes)');
console.log('icon.png  256x256 (' + fs.statSync(path.join(dir, 'icon.png')).size + ' bytes)');
