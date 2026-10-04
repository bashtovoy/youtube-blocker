#!/usr/bin/env node
/* make-icons.js — генерирует валидные PNG-иконки 48 и 96 без внешних зависимостей */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* --- CRC32 --- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/* --- рисование знака «запрет» --- */
function render(size) {
  const SS = 4;                 // суперсэмплинг для сглаживания
  const c = size / 2;
  const Ro = size * 0.44;       // внешний радиус
  const ringT = size * 0.13;    // толщина кольца
  const barHalf = size * 0.06;  // половина толщины черты
  const sqrt2 = Math.SQRT1_2;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0; const total = SS * SS;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - c;
          const py = y + (sy + 0.5) / SS - c;
          const dist = Math.hypot(px, py);
          const inside = dist <= Ro;
          const ring = inside && dist >= (Ro - ringT);
          const along = (px + py) * sqrt2;
          const perp = (-px + py) * sqrt2;
          const bar = inside && Math.abs(perp) <= barHalf && Math.abs(along) <= (Ro - ringT * 0.5);
          if (ring || bar) hit++;
        }
      }
      const cov = hit / total;
      const i = (y * size + x) * 4;
      rgba[i] = 200; rgba[i + 1] = 30; rgba[i + 2] = 30;
      rgba[i + 3] = Math.round(255 * cov);
    }
  }
  return rgba;
}

function encodePNG(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [48, 96]) {
  const buf = encodePNG(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), buf);
  console.log('записано icon' + size + '.png', buf.length, 'байт');
}
console.log('готово');
