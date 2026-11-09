import fs from "node:fs";
import zlib from "node:zlib";

// Just enough PNG for the icon/banner tools — no dependency, no build step.

/* ---------- minimal PNG reader (8-bit, non-interlaced, RGB/RGBA/gray) ---------- */
export function decode(file) {
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
export function crc32(buf) {
  if (!TBL) { TBL = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (const x of buf) c = TBL[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Zlib-compress raw RGBA scanlines with the PNG filter byte. */
export function rawIdat(w, h, rgba) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return zlib.deflateSync(raw, { level: 9 });
}

export function ihdr(w, h) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4);
  b[8] = 8; b[9] = 6;
  return b;
}

export const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function encode(w, h, rgba, file) {
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
