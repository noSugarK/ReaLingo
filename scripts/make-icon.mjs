import { decode, encode } from "./png.mjs";

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
