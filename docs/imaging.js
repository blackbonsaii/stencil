// Browser side of the image pipeline: decode, crop to the ink, scale to printer dots.
import { toGray, inkBounds, packRows, mergeRows } from "./raster.js?v=2.1";

const MAX_SOURCE_PX = 4096;     // cap huge camera-roll images to keep phones responsive
const CROP_THRESHOLD = 245;     // anything darker than near-white counts as part of the design

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/**
 * Load an image (file or stored blob) and crop away blank margins.
 * @returns {Promise<{source: HTMLCanvasElement, width: number, height: number, name: string}>}
 */
export async function loadDesign(file, name = file.name || "design") {
  const bmp = await decode(file);
  const s = Math.min(1, MAX_SOURCE_PX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const full = canvas(w, h);
  full.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const trimmed = trimToInk(full, { x: 0, y: 0, w, h });
  if (!trimmed) throw new Error("That image looks blank.");
  return { ...trimmed.design, name };
}

/**
 * Cut `rect` (source pixels) out of a design and trim it to its ink.
 * @returns {{design: object, offset: {x: number, y: number}} | null} offset = where the new
 *          design's top-left sits in the old one; null if the rectangle holds no lines
 */
export function cropDesign(design, rect) {
  const r = {
    x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)),
  };
  r.w = Math.min(design.width, Math.round(rect.x + rect.w)) - r.x;
  r.h = Math.min(design.height, Math.round(rect.y + rect.h)) - r.y;
  if (r.w < 1 || r.h < 1) return null;
  const t = trimToInk(design.source, r);
  return t && { design: { ...t.design, name: design.name }, offset: t.offset };
}

/** Copy the inked part of `rect` onto a white background (transparent PNGs become paper). */
function trimToInk(src, rect) {
  const work = canvas(rect.w, rect.h);
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const b = inkBounds(toGray(ctx.getImageData(0, 0, rect.w, rect.h).data), rect.w, rect.h, CROP_THRESHOLD);
  if (!b) return null;
  const source = canvas(b.w, b.h);
  const sctx = source.getContext("2d");
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, b.w, b.h);
  sctx.drawImage(work, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return { design: { source, width: b.w, height: b.h }, offset: { x: rect.x + b.x, y: rect.y + b.y } };
}

/** PNG of the design for the recent-designs list, no bigger than a full-width print needs. */
export function designBlob(design, maxPx = 2400) {
  const s = Math.min(1, maxPx / Math.max(design.width, design.height));
  const c = canvas(Math.max(1, Math.round(design.width * s)), Math.max(1, Math.round(design.height * s)));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(design.source, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("Couldn't save the design")), "image/png"));
}

/** Small picture of a design for the recent-designs list. */
export function designThumb(design, maxPx = 160) {
  const s = Math.min(1, maxPx / Math.max(design.width, design.height));
  const c = canvas(Math.max(1, Math.round(design.width * s)), Math.max(1, Math.round(design.height * s)));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(design.source, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Scale the design to exactly w × h printer dots and return grayscale pixels. */
export function grayAtSize(design, w, h) {
  const c = canvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(design.source, 0, 0, w, h);
  return toGray(ctx.getImageData(0, 0, w, h).data);
}

/** Black-on-transparent canvas showing exactly which dots will print (mirror applied). */
export function previewBitmap(gray, w, h, threshold, mirror) {
  const c = canvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + (mirror ? w - 1 - x : x)] < threshold) d[(y * w + x) * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Small thumbnail (data URL) of the printed bitmap, kept as the ghost on the sheet.
 * `crop` (bitmap pixels) limits it to the part that printed.
 */
export function ghostThumb(bitmap, crop = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, maxPx = 300) {
  const s = Math.min(1, maxPx / Math.max(crop.w, crop.h));
  const c = canvas(Math.max(1, Math.round(crop.w * s)), Math.max(1, Math.round(crop.h * s)));
  c.getContext("2d").drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/**
 * Calibration page: a line every ¼ inch, numbered every ½ inch by distance from the first printed
 * row, plus centre and edge marks. Measuring it tells us where printing starts and stops on a sheet.
 */
export function calibrationGray(w, h, dpi) {
  const c = canvas(w, h), ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  for (let q = 0; q * dpi / 4 < h; q++) {
    const y = Math.round(q * dpi / 4), major = q % 2 === 0;
    ctx.fillRect(0, y, w, major ? 3 : 1);
    if (major) {
      ctx.font = `bold ${Math.round(dpi * 0.16)}px sans-serif`;
      const label = (q / 4).toFixed(1).replace(/\.0$/, "");
      for (const x of [Math.round(dpi * 0.3), w / 2 - dpi * 0.15, w - dpi * 0.7]) ctx.fillText(label, x, y + 6);
    }
  }
  ctx.fillRect(Math.round(w / 2) - 1, 0, 3, h);          // centre line
  ctx.fillRect(0, 0, 4, h); ctx.fillRect(w - 4, 0, 4, h); // edges of the print head
  ctx.font = `bold ${Math.round(dpi * 0.13)}px sans-serif`;
  ctx.fillText("CALIBRATION · measure: top edge of sheet → 0 line, and the last number printed", dpi * 0.9, Math.round(dpi * 0.32));
  return toGray(ctx.getImageData(0, 0, w, h).data);
}

/** A 4 × 4 in square with a tick every inch, for checking that prints come out true to size. */
export function sizeCheckDesign(dpi) {
  const s = 4 * dpi, c = canvas(s, s), ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = "#000";
  const t = 4;                                            // outline thickness in dots
  ctx.fillRect(0, 0, s, t); ctx.fillRect(0, s - t, s, t);
  ctx.fillRect(0, 0, t, s); ctx.fillRect(s - t, 0, t, s);
  for (let i = 1; i < 4; i++) {
    const p = Math.round(i * dpi) - 1;
    ctx.fillRect(p, 0, 3, dpi * 0.25); ctx.fillRect(p, s - dpi * 0.25, 3, dpi * 0.25);
    ctx.fillRect(0, p, dpi * 0.25, 3); ctx.fillRect(s - dpi * 0.25, p, dpi * 0.25, 3);
  }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(dpi * 0.3)}px sans-serif`;
  ctx.fillText("4 in × 4 in", s / 2, s / 2 - dpi * 0.25);
  ctx.font = `${Math.round(dpi * 0.16)}px sans-serif`;
  ctx.fillText("measure outside edge to outside edge", s / 2, s / 2 + dpi * 0.2);
  ctx.fillText("↑ top", s / 2, dpi * 0.45);
  return { source: c, width: s, height: s, name: "size check" };
}

export { packRows, mergeRows };
