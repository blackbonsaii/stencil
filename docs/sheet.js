// Interactive preview of a US Letter sheet, in printer dots. Pinch to resize, drag to move.
import { DPI, WIDTH_DOTS } from "./protocol.js?v=1.7";

// Printable tissue of the user's stencil sheets: 214 × 259 mm (the rest of the 8.5 × 11 in
// sheet is the glued strip at the top).
const mm = v => Math.round(v / 25.4 * DPI);
export const SHEET_W = mm(214);                           // 1710
export const SHEET_H = mm(259);                           // 2070
export const PRINT_X0 = Math.round((SHEET_W - WIDTH_DOTS) / 2);   // print head is centred
const MIN_SIZE = Math.round(0.25 * DPI);
const SNAP = 12;                                          // dots

export class SheetView extends EventTarget {
  placement = null;     // {x, y, w, h} in sheet dots
  aspect = 1;           // h / w of the design
  bitmap = null;        // canvas of dots that will print
  cursor = 0;           // where the next print's first row lands, in sheet dots
  topMargin = Math.round(0.25 * DPI);  // a fresh sheet feeds this far before the head can reach it (calibrated)
  bottom = SHEET_H;     // the printer prints right to the end of the sheet
  ghosts = [];          // [{x, y, w, h, thumb}]
  snapped = false;
  #pointers = new Map();
  #gesture = null;
  #thumbs = new Map();
  #view = { s: 1, ox: 0, oy: 0 };

  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointerdown", e => this.#down(e));
    canvas.addEventListener("pointermove", e => this.#move(e));
    for (const t of ["pointerup", "pointercancel"]) canvas.addEventListener(t, e => this.#up(e));
    canvas.addEventListener("wheel", e => this.#wheel(e), { passive: false });
  }

  get fits() {
    const p = this.placement;
    return !!p && p.y >= this.cursor && p.y + p.h <= this.bottom;
  }

  /** Put a new design on the sheet: centred, in the free area, at a sensible size. */
  place(aspect, widthIn = 3) {
    this.aspect = aspect;
    const free = this.bottom - this.cursor;
    let w = Math.min(WIDTH_DOTS, Math.round(widthIn * DPI));
    if (w * aspect > free) w = Math.max(MIN_SIZE, Math.floor(free / aspect));
    this.placement = { x: 0, y: this.cursor, w, h: Math.round(w * aspect) };
    this.placement.x = PRINT_X0 + Math.round((WIDTH_DOTS - w) / 2);
    this.#clamp();
    this.#changed(true);
  }

  /** Set width in dots, keeping the design centred on the same point. */
  setWidth(w) {
    if (!this.placement) return;
    const p = this.placement, cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    this.#resize(w, cx, cy);
    this.#changed(true);
  }

  #resize(w, cx, cy) {
    const p = this.placement;
    w = Math.max(MIN_SIZE, Math.min(WIDTH_DOTS, Math.round(w)));
    p.w = w; p.h = Math.round(w * this.aspect);
    p.x = Math.round(cx - p.w / 2); p.y = Math.round(cy - p.h / 2);
    this.#clamp();
  }

  #clamp() {
    const p = this.placement;
    p.x = Math.max(PRINT_X0, Math.min(PRINT_X0 + WIDTH_DOTS - p.w, p.x));
    p.y = Math.max(this.cursor, Math.min(Math.max(this.cursor, this.bottom - p.h), p.y));
    const centred = PRINT_X0 + Math.round((WIDTH_DOTS - p.w) / 2);
    this.snapped = Math.abs(p.x - centred) <= SNAP;
    if (this.snapped) p.x = centred;
  }

  #changed(final) {
    this.draw();
    this.dispatchEvent(new CustomEvent("change", { detail: { final } }));
  }

  // ---- gestures ---------------------------------------------------------

  #toSheet(e) {
    const r = this.canvas.getBoundingClientRect(), v = this.#view;
    return { x: (e.clientX - r.left - v.ox) / v.s, y: (e.clientY - r.top - v.oy) / v.s };
  }

  #down(e) {
    if (!this.placement) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.#pointers.set(e.pointerId, this.#toSheet(e));
    this.#startGesture();
  }

  #startGesture() {
    const pts = [...this.#pointers.values()], p = { ...this.placement };
    if (pts.length === 1) this.#gesture = { type: "drag", start: pts[0], p };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      this.#gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, p };
    }
  }

  #move(e) {
    if (!this.#pointers.has(e.pointerId) || !this.#gesture) return;
    this.#pointers.set(e.pointerId, this.#toSheet(e));
    const g = this.#gesture, pts = [...this.#pointers.values()], pl = this.placement;
    if (g.type === "drag") {
      pl.x = Math.round(g.p.x + pts[0].x - g.start.x);
      pl.y = Math.round(g.p.y + pts[0].y - g.start.y);
      this.#clamp();
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / g.dist;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.#resize(g.p.w * scale,
        g.p.x + g.p.w / 2 + mid.x - g.mid.x,
        g.p.y + g.p.h / 2 + mid.y - g.mid.y);
    }
    this.#changed(false);
  }

  #up(e) {
    if (!this.#pointers.delete(e.pointerId)) return;
    if (this.#pointers.size) this.#startGesture();
    else { this.#gesture = null; this.#changed(true); }
  }

  #wheel(e) {     // trackpad pinch (ctrl+wheel) or scroll on iPad with a keyboard case
    if (!this.placement) return;
    e.preventDefault();
    const p = this.placement;
    this.#resize(p.w * Math.exp(-e.deltaY * 0.002), p.x + p.w / 2, p.y + p.h / 2);
    clearTimeout(this.#wheelTimer);
    this.#wheelTimer = setTimeout(() => this.#changed(true), 250);
    this.#changed(false);
  }
  #wheelTimer = 0;

  // ---- drawing ----------------------------------------------------------

  #thumb(src) {
    let img = this.#thumbs.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.draw();
      img.src = src;
      this.#thumbs.set(src, img);
    }
    return img.complete ? img : null;
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    if (!cw || !ch) return;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
    }
    const css = getComputedStyle(c);
    const col = n => css.getPropertyValue(n).trim();
    const pad = 28;
    const s = Math.min((cw - pad * 2) / SHEET_W, (ch - pad * 2) / SHEET_H);
    const v = this.#view = { s, ox: (cw - SHEET_W * s) / 2, oy: (ch - SHEET_H * s) / 2 };
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(v.ox, v.oy);
    ctx.scale(s, s);
    const px = 1 / s;   // one screen pixel, in sheet dots

    // paper
    ctx.shadowColor = "rgba(0,0,0,.25)"; ctx.shadowBlur = 12; ctx.shadowOffsetY = 3;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, SHEET_W, SHEET_H);
    ctx.shadowColor = "transparent";

    // inch grid
    ctx.strokeStyle = "rgba(60,80,120,.12)";
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let i = 1; i * DPI < SHEET_H; i++) { ctx.moveTo(0, i * DPI); ctx.lineTo(SHEET_W, i * DPI); }
    for (let i = 1; i * DPI < SHEET_W; i++) { ctx.moveTo(i * DPI, 0); ctx.lineTo(i * DPI, SHEET_H); }
    ctx.stroke();
    ctx.fillStyle = "rgba(60,80,120,.55)";
    ctx.font = `${11 * px}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    for (let i = 1; (i + 0.1) * DPI < SHEET_H; i++) ctx.fillText(`${i}″`, 3 * px, i * DPI + 2 * px);

    // strips the print head can't reach
    ctx.fillStyle = "rgba(120,120,120,.18)";
    ctx.fillRect(0, 0, PRINT_X0, SHEET_H);
    ctx.fillRect(PRINT_X0 + WIDTH_DOTS, 0, SHEET_W - PRINT_X0 - WIDTH_DOTS, SHEET_H);

    // ghosts of earlier prints on this sheet
    this.ghosts.forEach((g, i) => {
      const img = g.thumb && this.#thumb(g.thumb);
      ctx.globalAlpha = 0.28;
      if (img) ctx.drawImage(img, g.x, g.y, g.w, g.h);
      ctx.globalAlpha = 1;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeStyle = col("--ghost") || "#2a7de1";
      ctx.lineWidth = 1.5 * px;
      ctx.strokeRect(g.x, g.y, g.w, g.h);
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.textBaseline = "bottom";
      ctx.fillText(`#${i + 1}  ${fmtIn(g.w)} × ${fmtIn(g.h)}`, g.x, g.y - 2 * px);
    });

    // areas the head can't reach: top of a fresh sheet, below the calibrated end, or already fed past
    ctx.fillStyle = "rgba(90,90,90,.30)";
    ctx.fillRect(0, 0, SHEET_W, this.cursor);
    if (this.bottom < SHEET_H) ctx.fillRect(0, this.bottom, SHEET_W, SHEET_H - this.bottom);
    ctx.strokeStyle = "rgba(200,60,40,.9)";
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath(); ctx.moveTo(0, this.cursor); ctx.lineTo(SHEET_W, this.cursor); ctx.stroke();
    ctx.fillStyle = "rgba(170,40,30,1)";
    ctx.textBaseline = "bottom";
    ctx.fillText(this.cursor > this.topMargin ? "Next print starts here (sheet still in printer)"
                                              : "Printer can't reach above this line",
                 30 * px, this.cursor - 3 * px);

    // the design
    const p = this.placement;
    if (p) {
      if (this.snapped && this.#gesture) {
        ctx.strokeStyle = "rgba(230,60,140,.8)";
        ctx.lineWidth = px;
        ctx.beginPath(); ctx.moveTo(SHEET_W / 2, 0); ctx.lineTo(SHEET_W / 2, SHEET_H); ctx.stroke();
      }
      if (this.bitmap) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.bitmap, p.x, p.y, p.w, p.h);
      }
      ctx.strokeStyle = this.fits ? (col("--accent") || "#0a84ff") : "#e5352b";
      ctx.lineWidth = 2 * px;
      ctx.strokeRect(p.x, p.y, p.w, p.h);
    }
    ctx.restore();
  }
}

export const fmtIn = dots => `${(dots / DPI).toFixed(2)}″`;
