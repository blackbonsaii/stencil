// Image → printer dots. Pure functions over plain arrays so they can be tested in Node.
import { WIDTH_BYTES, WIDTH_DOTS } from "./protocol.js?v=2.0";

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
 * @param {number} o.lead     blank rows to send before the design (positions it down the sheet);
 *                            negative cuts that many rows off the top of the design
 * @param {number} o.maxRows  stop after this many rows (the end of the sheet); design rows past it are cut
 * @param {number} o.threshold  gray below this prints black
 * @param {boolean} o.mirror  flip the design horizontally
 * @param {boolean} o.flipSheet  the TP88 lays dots right-to-left as seen from the printed side,
 *                               so the whole row is reversed to match the on-screen preview
 * @returns {{rows: Uint8Array, height: number}}
 */
export function packRows(gray, w, h, { x = 0, lead = 0, maxRows = Infinity, threshold = 128,
                                       mirror = false, flipSheet = true }) {
  const from = Math.max(0, -x), to = Math.min(w, WIDTH_DOTS - x);       // columns the head reaches
  const first = Math.max(0, -lead);                                      // rows cut off the top
  const end = Math.min(h, Math.max(first, maxRows - lead));             // rows cut off the bottom
  // Drop trailing rows with nothing to print (within the columns that print) so short designs
  // don't feed extra paper.
  const inked = y => {
    for (let sx = from; sx < to; sx++) if (gray[y * w + (mirror ? w - 1 - sx : sx)] < threshold) return true;
    return false;
  };
  let last = end - 1;
  while (last >= first && !inked(last)) last--;
  if (last < first) return { rows: new Uint8Array(0), height: 0 };
  const top = Math.max(0, lead);
  const height = top + last + 1 - first;
  const rows = new Uint8Array(height * WIDTH_BYTES);
  for (let y = first; y <= last; y++) {
    const src = y * w, dst = (top + y - first) * WIDTH_BYTES;
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
