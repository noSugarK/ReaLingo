// Animate the banner: a specular sweep travelling across the lockup, on a slow loop.
//
//   node tools/make-anim.mjs brand/banner.png brand/banner-animated.png
//
// Output is APNG, not GIF. GIF would quantise the gradient wordmark to 256 colours (visible
// banding) and only carries 1-bit transparency, which leaves white fringes on GitHub's dark
// theme. APNG keeps full colour and alpha, every current browser plays it, the extension is
// still .png so Markdown treats it as a normal image — and anything that cannot animate it
// shows frame one, which is the static logo.
import fs from "node:fs";
import { decode, chunk, rawIdat, ihdr, SIGNATURE } from "./png.mjs";

const [src, dst] = process.argv.slice(2);
const { w, h, rgba } = decode(src);

const SWEEP_FRAMES = 10;
const FRAME_MS = 70;
const HOLD_MS = 2600; // the still pause between sweeps — one frame, not dozens
const BAND = w * 0.11; // half-width of the highlight
// Kept low on purpose: the sweep lifts colours toward white, and on a light page a
// strong lift washes the thin letterforms out entirely — it read as the logo blanking.
const STRENGTH = 0.22;
const SKEW = 0.2; // diagonal, so it reads as a light source rather than a wiper

const span = w + h * SKEW + BAND * 2;

/** The lockup with the highlight at normalised sweep position `t` (0..1). */
function sweep(t) {
  const out = Buffer.from(rgba);
  const head = -BAND + t * span;
  // Fade the highlight in and out so it does not pop at either edge.
  const envelope = Math.sin(Math.PI * t);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((y * w + x) << 2) + 3;
      if (!out[a]) continue; // never light up transparent background
      const dist = (x + y * SKEW - head) / BAND;
      if (dist < -1 || dist > 1) continue;
      const k = STRENGTH * Math.cos((dist * Math.PI) / 2) ** 2 * envelope;
      for (let c = 0; c < 3; c++) {
        const p = a - 3 + c;
        out[p] = Math.min(255, Math.round(out[p] + (255 - out[p]) * k));
      }
    }
  }
  return out;
}

/**
 * Changed region between two full frames, ignoring differences of a single code value.
 * The soft-alpha edges leave a wide skirt of ±1 noise that is invisible but would otherwise
 * push every frame's rectangle out to the full canvas.
 */
const NOISE = 1;

function dirty(prev, next) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;
      let moved = false;
      for (let c = 0; c < 4; c++) {
        if (Math.abs(prev[i + c] - next[i + c]) > NOISE) { moved = true; break; }
      }
      if (!moved) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(buf, r) {
  const out = Buffer.alloc(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) {
    buf.copy(out, y * r.w * 4, ((r.y + y) * w + r.x) * 4, ((r.y + y) * w + r.x + r.w) * 4);
  }
  return out;
}

function fcTL(seq, r, delayMs) {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(seq, 0);
  b.writeUInt32BE(r.w, 4);
  b.writeUInt32BE(r.h, 8);
  b.writeUInt32BE(r.x, 12);
  b.writeUInt32BE(r.y, 16);
  b.writeUInt16BE(delayMs, 20);
  b.writeUInt16BE(1000, 22); // delay denominator: milliseconds
  b[24] = 0; // dispose: none — each frame paints over the last
  b[25] = 0; // blend: source
  return b;
}

const frames = [];
for (let i = 0; i < SWEEP_FRAMES; i++) {
  frames.push({ rgba: sweep(i / SWEEP_FRAMES), delay: FRAME_MS });
}
// One long frame of the untouched logo closes the loop.
frames.push({ rgba: Buffer.from(rgba), delay: HOLD_MS });

const acTL = Buffer.alloc(8);
acTL.writeUInt32BE(frames.length, 0);
acTL.writeUInt32BE(0, 4); // loop forever

const parts = [SIGNATURE, chunk("IHDR", ihdr(w, h)), null /* acTL, patched below */];
const ACTL_SLOT = 2;
let seq = 0;
let written = 0;

frames.forEach((f, i) => {
  // Frame 0 is also the still image every non-animating viewer sees, so it must be full size.
  const region = i === 0 ? { x: 0, y: 0, w, h } : dirty(frames[i - 1].rgba, f.rgba);
  if (!region) return; // identical to the previous frame
  parts.push(chunk("fcTL", fcTL(seq++, region, f.delay)));
  written++;
  const data = rawIdat(region.w, region.h, crop(f.rgba, region));
  if (i === 0) {
    parts.push(chunk("IDAT", data));
  } else {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq++, 0);
    parts.push(chunk("fdAT", Buffer.concat([head, data])));
  }
});

// acTL must report the number of frames actually written, so fill it in now.
acTL.writeUInt32BE(written, 0);
parts[ACTL_SLOT] = chunk("acTL", acTL);

fs.writeFileSync(dst, Buffer.concat(parts));
const kb = (fs.statSync(dst).size / 1024).toFixed(0);
console.log(`${src} ${w}x${h} -> ${dst}  ${written} frames, ${kb} KB`);
