import fs from "node:fs";
import zlib from "node:zlib";

/* ---------- minimal PNG reader (8-bit, non-interlaced, RGB/RGBA/gray) ---------- */
function decode(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, ihdr = null, idat = [], pal = null, trns = null;
  while (off + 8 <= b.length) {
    const len = b.readUInt32BE(off), type = b.toString("ascii", off + 4, off + 8), body = off + 8;
    if (type === "IHDR")
      ihdr = {
        w: b.readUInt32BE(body), h: b.readUInt32BE(body + 4),
        depth: b[body + 8], color: b[body + 9], interlace: b[body + 12],
      };
    else if (type === "IDAT") idat.push(b.subarray(body, body + len));
    else if (type === "PLTE") pal = b.subarray(body, body + len);
    else if (type === "tRNS") trns = b.subarray(body, body + len);
    else if (type === "IEND") break;
    off = body + len + 4;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
  if (ihdr.interlace) throw new Error("interlaced PNG unsupported");

  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
  if (!CH) throw new Error(`unsupported colour type ${ihdr.color}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { w, h } = ihdr, stride = w * CH;
  const out = Buffer.alloc(h * stride);

  // undo per-scanline filtering
  for (let y = 0, p = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= CH ? cur[i - CH] : 0;
      const bb = prev ? prev[i] : 0;
      const c = prev && i >= CH ? prev[i - CH] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? bb : c;
      }
      cur[i] = v & 255;
    }
  }

  // normalise to RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    const s = i * CH, d = i * 4;
    if (ihdr.color === 6) { rgba[d] = out[s]; rgba[d+1] = out[s+1]; rgba[d+2] = out[s+2]; rgba[d+3] = out[s+3]; }
    else if (ihdr.color === 2) { rgba[d] = out[s]; rgba[d+1] = out[s+1]; rgba[d+2] = out[s+2]; rgba[d+3] = 255; }
    else if (ihdr.color === 0) { rgba[d] = rgba[d+1] = rgba[d+2] = out[s]; rgba[d+3] = 255; }
    else if (ihdr.color === 4) { rgba[d] = rgba[d+1] = rgba[d+2] = out[s]; rgba[d+3] = out[s+1]; }
    else { const pi = out[s] * 3; rgba[d] = pal[pi]; rgba[d+1] = pal[pi+1]; rgba[d+2] = pal[pi+2];
           rgba[d+3] = trns && out[s] < trns.length ? trns[out[s]] : 255; }
  }
  return { w, h, rgba };
}

/* ---------- PNG writer ---------- */
let TBL = null;
function crc32(buf) {
  if (!TBL) { TBL = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const x of buf) c = TBL[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(w, h, rgba, file) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

/* ---------- crop the mark, mount it on a rounded white plate ---------- */
const [src, dst, sizeArg, cutArg] = process.argv.slice(2);
const N = Number(sizeArg || 1024);
const { w, h, rgba } = decode(src);

// The logo sits on white with the wordmark underneath; an app icon must not carry text
// that turns to mush at 32px, so only the graphic above this line is used.
const wordmarkTop = Math.round(h * (cutArg ? Number(cutArg) : 0.66));
const isInk = (d) => rgba[d + 3] > 40 &&
  (255 - rgba[d]) + (255 - rgba[d + 1]) + (255 - rgba[d + 2]) > 24;

let minX = w, maxX = -1, minY = h, maxY = -1;
for (let y = 0; y < wordmarkTop; y++) {
  for (let x = 0; x < w; x++) {
    if (!isInk((y * w + x) * 4)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
if (maxX < 0) throw new Error("no artwork found above the wordmark");

// Plate geometry: the mark occupies ~72% of the icon, which is the usual optical weight.
const markSide = Math.max(maxX - minX + 1, maxY - minY + 1);
const inner = Math.round(N * 0.72);
const scale = markSide / inner;
const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
const x0 = cx - (N / 2) * scale, y0 = cy - (N / 2) * scale;

const R = N * 0.2237; // squircle-ish corner, matching the platform icon grid
function plateAlpha(x, y) {
  // distance to a rounded rect, sampled 2x2 for a smooth edge
  let hits = 0;
  for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const px = x + ox - N / 2, py = y + oy - N / 2;
    const qx = Math.abs(px) - (N / 2 - R), qy = Math.abs(py) - (N / 2 - R);
    const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - R;
    if (d < 0) hits++;
  }
  return hits / 4;
}

const out = Buffer.alloc(N * N * 4);
for (let ty = 0; ty < N; ty++) {
  for (let tx = 0; tx < N; tx++) {
    // box-filter the source region behind this pixel
    const sx0 = Math.floor(x0 + tx * scale), sx1 = Math.floor(x0 + (tx + 1) * scale);
    const sy0 = Math.floor(y0 + ty * scale), sy1 = Math.floor(y0 + (ty + 1) * scale);
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = sy0; sy <= sy1; sy++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        n++;
        // Outside the source, or down in the wordmark: plain plate, no text.
        if (sx < 0 || sy < 0 || sx >= w || sy >= h || sy >= wordmarkTop) {
          r += 255; g += 255; b += 255; continue;
        }
        const d = (sy * w + sx) * 4, a = rgba[d + 3] / 255;
        // composite over white, matching the artwork's own background
        r += rgba[d] * a + 255 * (1 - a);
        g += rgba[d + 1] * a + 255 * (1 - a);
        b += rgba[d + 2] * a + 255 * (1 - a);
      }
    }
    // a whisper of vertical shading so the plate is not a dead flat rectangle
    const tint = 1 - (ty / N) * 0.045;
    const d = (ty * N + tx) * 4;
    out[d] = Math.min(255, (r / n) * tint);
    out[d + 1] = Math.min(255, (g / n) * tint);
    out[d + 2] = Math.min(255, (b / n) * tint);
    out[d + 3] = Math.round(plateAlpha(tx, ty) * 255);
  }
}
encode(N, N, out, dst);
console.log(`${src} ${w}x${h} -> mark ${minX},${minY}-${maxX},${maxY} -> ${dst} ${N}x${N}`);
