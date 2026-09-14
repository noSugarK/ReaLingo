// Re-lay the stacked logo (graphic above, wordmark below) into a horizontal lockup:
// graphic on the left, wordmark on the right, on a transparent background so it sits
// equally well on GitHub's light and dark themes.
//
//   node tools/make-banner.mjs brand/ReaLingo.png brand/banner.png [height]
//
// Pass `--mark` to emit only the graphic, square and transparent — that is the in-app
// titlebar logo. The white-plate version `make-icon.mjs` produces is for OS icon grids,
// where a plate is expected; inside the app it reads as a white card stuck on the header.
import { decode, encode } from "./png.mjs";

const [src, dst, heightArg] = process.argv.slice(2);
const H = Number(heightArg || 240);
const markOnly = process.argv.includes("--mark");

const { w, h, rgba } = decode(src);
const at = (x, y) => (y * w + x) * 4;

/** The art is drawn on white; anything visibly off-white is ink. */
function isInk(x, y) {
  const d = at(x, y);
  if (rgba[d + 3] < 40) return false;
  return 765 - (rgba[d] + rgba[d + 1] + rgba[d + 2]) > 24;
}

function rowHasInk(y) {
  for (let x = 0; x < w; x++) if (isInk(x, y)) return true;
  return false;
}

// Split the logo at the widest all-white band: above it the graphic, below it the wordmark.
const inkRows = [];
for (let y = 0; y < h; y++) inkRows.push(rowHasInk(y));
const first = inkRows.indexOf(true);
const last = inkRows.lastIndexOf(true);

let gap = null;
for (let y = first, run = null; y <= last; y++) {
  if (!inkRows[y]) {
    run ??= y;
  } else if (run !== null) {
    if (!gap || y - run > gap.end - gap.start) gap = { start: run, end: y };
    run = null;
  }
}
if (!gap) throw new Error("no blank band between the graphic and the wordmark");

function bbox(y0, y1) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      if (!isInk(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("empty region");
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const mark = bbox(first, gap.start);
const word = bbox(gap.end, last + 1);

// Layout: the graphic fills the height, the wordmark is set to ~46% of it so the cap height
// reads as a peer rather than shouting over the mark.
const markH = H;
const markW = Math.round((mark.w / mark.h) * markH);
const wordH = Math.round(H * 0.46);
const wordW = Math.round((word.w / word.h) * wordH);
const gapX = Math.round(H * 0.2);
const W = markOnly ? markW : markW + gapX + wordW;

const out = Buffer.alloc(W * H * 4);

/**
 * Below this average brightness a pixel is solid artwork. A brightness histogram of the
 * source logo shows 17% of pixels at 90–149, a near-empty band from 150–239, then 82% at
 * 240+ — solid art, antialiased rim, white background. The split is unambiguous.
 */
const SOLID = 150;

/**
 * Separate the logo from its white background.
 *
 * `keyEverything` picks how enclosed white is read, because the two halves of this logo
 * disagree and no single rule gets both right:
 *
 *   - **Graphic** (`false`): the white A and 文 sit *inside* the bubbles and are content.
 *     Only white reachable from the border is background, so connectivity decides.
 *   - **Wordmark** (`true`): the holes in R, e, a, o are background that happens to be
 *     enclosed. Connectivity would keep them opaque white — white blobs inside the letters
 *     on a dark page — so here every white pixel is keyed out regardless of reachability.
 *
 * Either way the background-side pixels get a *gradual* alpha from un-matting, not a yes/no
 * mask: a binary mask leaves the antialiased rim opaque and near-white, which shows up as a
 * pale halo around everything on a dark background.
 */
function matte(keyEverything) {
  const alpha = new Float32Array(w * h).fill(1);
  const color = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const d = i * 4;
    color[i * 3] = rgba[d];
    color[i * 3 + 1] = rgba[d + 1];
    color[i * 3 + 2] = rgba[d + 2];
  }

  // Flood from the border through background *and* the transition rim, stopping at solid art.
  const reach = new Uint8Array(w * h);
  if (keyEverything) {
    reach.fill(1);
  } else {
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop();
    if (reach[i]) continue;
    const d = i * 4;
    if (rgba[d + 3] >= 40 && (rgba[d] + rgba[d + 1] + rgba[d + 2]) / 3 < SOLID) continue;
    reach[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  }

  // The art was composited over white: c = a*C + (1-a)*255, so a = 1 - min(r,g,b)/255
  // recovers both the coverage and the original colour.
  for (let i = 0; i < w * h; i++) {
    if (!reach[i]) continue; // enclosed content keeps full opacity
    const d = i * 4;
    if (rgba[d + 3] < 40) {
      alpha[i] = 0;
      continue;
    }
    const a = 1 - Math.min(rgba[d], rgba[d + 1], rgba[d + 2]) / 255;
    alpha[i] = a;
    if (a > 0.004) {
      for (let c = 0; c < 3; c++) {
        color[i * 3 + c] = Math.max(0, Math.min(255, Math.round((rgba[d + c] - 255 * (1 - a)) / a)));
      }
    }
  }
  return { alpha, color };
}

const GRAPHIC = matte(false);
const WORDMARK = matte(true);

/** Draw a source region into a destination box, box-filtering in premultiplied space. */
function blit(region, dx, dy, dw, dh, { alpha: A, color: C }) {
  const sx = region.w / dw;
  const sy = region.h / dh;
  for (let ty = 0; ty < dh; ty++) {
    for (let tx = 0; tx < dw; tx++) {
      const x0 = region.x + tx * sx;
      const y0 = region.y + ty * sy;
      let r = 0, g = 0, b = 0, aSum = 0, n = 0;
      for (let yy = Math.floor(y0); yy < Math.max(Math.floor(y0) + 1, y0 + sy); yy++) {
        for (let xx = Math.floor(x0); xx < Math.max(Math.floor(x0) + 1, x0 + sx); xx++) {
          n++;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i = yy * w + xx;
          const a = A[i];
          if (a <= 0) continue;
          r += C[i * 3] * a;
          g += C[i * 3 + 1] * a;
          b += C[i * 3 + 2] * a;
          aSum += a;
        }
      }
      if (aSum < 1e-4) continue;
      const d = ((dy + ty) * W + dx + tx) * 4;
      out[d] = Math.round(r / aSum);
      out[d + 1] = Math.round(g / aSum);
      out[d + 2] = Math.round(b / aSum);
      out[d + 3] = Math.round((aSum / n) * 255);
    }
  }
}

blit(mark, 0, 0, markW, markH, GRAPHIC);
if (!markOnly) blit(word, markW + gapX, Math.round((H - wordH) / 2), wordW, wordH, WORDMARK);

encode(W, H, out, dst);
console.log(
  `${src} ${w}x${h}\n` +
    `  graphic  ${mark.x},${mark.y} ${mark.w}x${mark.h}\n` +
    `  wordmark ${word.x},${word.y} ${word.w}x${word.h}\n` +
    `  -> ${dst} ${W}x${H}`
);
