// Generates clock icons as valid PNGs using only Node's zlib (no deps).
// Draws a filled circle (clock face) with two hands on a transparent background.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../public/icons');

/** @param {number} size */
function render(size) {
  const px = new Uint8Array(size * size * 4); // RGBA
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.44;
  const rInner = size * 0.4;

  const face = [37, 99, 235]; // blue
  const hand = [255, 255, 255];

  const set = (x, y, [rr, gg, bb], a = 255) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= size || yi >= size) return;
    const i = (yi * size + xi) * 4;
    px[i] = rr; px[i + 1] = gg; px[i + 2] = bb; px[i + 3] = a;
  };

  // Face (anti-aliased edge).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= rInner) {
        set(x, y, face, 255);
      } else if (d <= r) {
        const a = Math.max(0, Math.min(255, Math.round((r - d) / (r - rInner) * 255)));
        set(x, y, face, a);
      }
    }
  }

  // Hands: hour to 2 o'clock, minute to 12.
  const drawLine = (x0, y0, x1, y1, w) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let dx = -w; dx <= w; dx++) {
        for (let dy = -w; dy <= w; dy++) {
          if (dx * dx + dy * dy <= w * w) set(x + dx, y + dy, hand, 255);
        }
      }
    }
  };
  const hw = Math.max(1, Math.round(size * 0.035));
  drawLine(cx, cy, cx, cy - rInner * 0.6, hw); // minute (up)
  drawLine(cx, cy, cx + rInner * 0.45, cy - rInner * 0.3, hw); // hour

  return px;
}

/** Encode an RGBA buffer as a PNG. */
function encodePng(size, rgba) {
  const bytesPerRow = size * 4;
  const raw = Buffer.alloc((bytesPerRow + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (bytesPerRow + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * bytesPerRow, bytesPerRow).copy(
      raw,
      y * (bytesPerRow + 1) + 1,
    );
  }
  const idat = deflateSync(raw);

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, render(size));
  writeFileSync(resolve(OUT_DIR, `icon${size}.png`), png);
  // eslint-disable-next-line no-console
  console.log(`wrote icon${size}.png (${png.length} bytes)`);
}
