// Image → printer dots. Pure functions over plain arrays so they can be tested in Node.
import { WIDTH_BYTES, WIDTH_DOTS } from "./protocol.js?v=1.8";

/**
 * RGBA pixels → grayscale (0 black … 255 white), transparency treated as white paper.
 * @param {Uint8ClampedArray} rgba
 */
export function toGray(rgba) {
  const n = rgba.length / 4, g = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    g[i] = Math.round(lum * a + 255 * (1 - a));
  }
  return g;
}

/**
 * Bounding box of pixels darker than `threshold`, so empty margins around a
 * camera-roll image don't count toward its printed size. Null if the image is blank.
 */
export function inkBounds(gray, w, h, threshold) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[row + x] < threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Pack an already-scaled grayscale design into full-width printer rows.
 *
 * @param {Uint8Array} gray   design pixels at print resolution (w × h)
 * @param {number} w
 * @param {number} h
 * @param {object} o
 * @param {number} o.x        left edge of the design in dots (may be negative or overhang; clipped)
 * @param {number} o.lead     blank rows to send before the design (positions it down the sheet)
 * @param {number} o.threshold  gray below this prints black
 * @param {boolean} o.mirror  flip the design horizontally
 * @param {boolean} o.flipSheet  the TP88 lays dots right-to-left as seen from the printed side,
 *                               so the whole row is reversed to match the on-screen preview
 * @returns {{rows: Uint8Array, height: number}}
 */
export function packRows(gray, w, h, { x = 0, lead = 0, threshold = 128, mirror = false, flipSheet = true }) {
  // Drop trailing blank rows so short designs don't feed extra paper.
  let last = h - 1;
  outer: for (; last >= 0; last--) {
    for (let i = last * w, e = i + w; i < e; i++) if (gray[i] < threshold) break outer;
  }
  const designRows = last + 1;
  const height = designRows === 0 ? 0 : lead + designRows;
  const rows = new Uint8Array(height * WIDTH_BYTES);
  const from = Math.max(0, -x), to = Math.min(w, WIDTH_DOTS - x);
  for (let y = 0; y < designRows; y++) {
    const src = y * w, dst = (lead + y) * WIDTH_BYTES;
    for (let sx = from; sx < to; sx++) {
      const v = gray[src + (mirror ? w - 1 - sx : sx)];
      if (v < threshold) {
        const dx = flipSheet ? WIDTH_DOTS - 1 - (x + sx) : x + sx;
        rows[dst + (dx >> 3)] |= 0x80 >> (dx & 7);
      }
    }
  }
  return { rows, height };
}
