// Re-lay the stacked logo (graphic above, wordmark below) into a horizontal lockup:
// graphic on the left, wordmark on the right, on a transparent background so it sits
// equally well on GitHub's light and dark themes.
//
//   node tools/make-banner.mjs brand/ReaLingo.png brand/banner.png [height]
import { decode, encode } from "./png.mjs";

const [src, dst, heightArg] = process.argv.slice(2);
const H = Number(heightArg || 240);

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
const W = markW + gapX + wordW;

const out = Buffer.alloc(W * H * 4);

/**
 * Which pixels are background, by connectivity rather than by colour.
 *
 * Keying on "white == transparent" also erases the white A and 文 inside the speech
 * bubbles, which then read as black holes on a dark page. Flood-filling from the border
 * instead keeps enclosed white as content, because it is not reachable from outside.
 */
function backgroundMask() {
  const bg = new Uint8Array(w * h);
  const near = (i) => {
    const d = i * 4;
    if (rgba[d + 3] < 40) return true;
    return rgba[d] + rgba[d + 1] + rgba[d + 2] >= 735; // avg >= 245
  };
  const stack = [];
  for (let x = 0; x < w; x++) {
    stack.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w, y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    if (bg[i] || !near(i)) continue;
    bg[i] = 1;
    const x = i % w, y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return bg;
}

const BG = backgroundMask();

/**
 * Draw a source region into a destination box. The mask is hard-edged at full resolution;
 * box-filtering it down to the banner size is what turns it back into clean antialiasing,
 * so colours are accumulated premultiplied to avoid dark fringes.
 */
function blit(region, dx, dy, dw, dh) {
  const sx = region.w / dw;
  const sy = region.h / dh;
  for (let ty = 0; ty < dh; ty++) {
    for (let tx = 0; tx < dw; tx++) {
      const x0 = region.x + tx * sx;
      const y0 = region.y + ty * sy;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = Math.floor(y0); yy < Math.max(Math.floor(y0) + 1, y0 + sy); yy++) {
        for (let xx = Math.floor(x0); xx < Math.max(Math.floor(x0) + 1, x0 + sx); xx++) {
          n++;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i = yy * w + xx;
          if (BG[i]) continue;
          const d = i * 4;
          r += rgba[d];
          g += rgba[d + 1];
          b += rgba[d + 2];
          a += 1;
        }
      }
      if (!a) continue;
      const d = ((dy + ty) * W + dx + tx) * 4;
      out[d] = Math.round(r / a);
      out[d + 1] = Math.round(g / a);
      out[d + 2] = Math.round(b / a);
      out[d + 3] = Math.round((a / n) * 255);
    }
  }
}

blit(mark, 0, 0, markW, markH);
blit(word, markW + gapX, Math.round((H - wordH) / 2), wordW, wordH);

encode(W, H, out, dst);
console.log(
  `${src} ${w}x${h}\n` +
    `  graphic  ${mark.x},${mark.y} ${mark.w}x${mark.h}\n` +
    `  wordmark ${word.x},${word.y} ${word.w}x${word.h}\n` +
    `  -> ${dst} ${W}x${H}`
);
