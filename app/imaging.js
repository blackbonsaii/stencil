// Browser side of the image pipeline: decode, crop to the ink, scale to printer dots.
import { toGray, inkBounds, packRows } from "./raster.js";

const MAX_SOURCE_PX = 4096;     // cap huge camera-roll images to keep phones responsive
const CROP_THRESHOLD = 245;     // anything darker than near-white counts as part of the design

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

/**
 * Load an image file and crop away blank margins.
 * @returns {Promise<{source: HTMLCanvasElement, width: number, height: number, name: string}>}
 */
export async function loadDesign(file) {
  const bmp = await decode(file);
  const s = Math.min(1, MAX_SOURCE_PX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const full = canvas(w, h);
  const ctx = full.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const gray = toGray(ctx.getImageData(0, 0, w, h).data);
  const b = inkBounds(gray, w, h, CROP_THRESHOLD);
  if (!b) throw new Error("That image looks blank.");
  // Cropped copy on a white background (transparent PNGs from Procreate become white paper).
  const source = canvas(b.w, b.h);
  const sctx = source.getContext("2d");
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, b.w, b.h);
  sctx.drawImage(full, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return { source, width: b.w, height: b.h, name: file.name || "design" };
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

/** Small thumbnail (data URL) of the printed bitmap, kept as the ghost on the sheet. */
export function ghostThumb(bitmap, maxPx = 300) {
  const s = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const c = canvas(Math.max(1, Math.round(bitmap.width * s)), Math.max(1, Math.round(bitmap.height * s)));
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

export { packRows };
