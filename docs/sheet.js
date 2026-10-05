// Interactive preview of a US Letter sheet, in printer dots. Holds one or more designs:
// tap one to select it, drag to move it, pinch to resize it.
import { DPI, WIDTH_DOTS } from "./protocol.js?v=2.1";

// Printable tissue of the user's stencil sheets: 214 × 259 mm (the rest of the 8.5 × 11 in
// sheet is the glued strip at the top).
const mm = v => Math.round(v / 25.4 * DPI);
export const SHEET_W = mm(214);                           // 1710
export const SHEET_H = mm(259);                           // 2070
export const PRINT_X0 = Math.round((SHEET_W - WIDTH_DOTS) / 2);   // print head is centred
const MIN_SIZE = Math.round(0.25 * DPI);
const SNAP = 12;                                          // dots
const GAP = Math.round(0.1 * DPI);                        // between a new design and the ones above it
const HIT_PX = 14;                                        // finger tolerance for touching a line, screen px

/**
 * A design on the sheet.
 * @typedef {{id: string, design: object, aspect: number, x: number, y: number, w: number, h: number,
 *            bitmap: HTMLCanvasElement|null}} Item
 */

export class SheetView extends EventTarget {
  /** @type {Item[]} drawn in this order; the selected one is drawn last, on top */
  items = [];
  /** @type {Item|null} */
  selected = null;
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

  /** The part of the sheet the head can still print on: its width, from the cursor down. */
  get printArea() {
    return { x: PRINT_X0, y: this.cursor, w: WIDTH_DOTS, h: Math.max(0, this.bottom - this.cursor) };
  }

  /** The part of an item that will print (the rest hangs outside the print area), or null. */
  visibleOf(it) {
    const a = this.printArea;
    if (!it) return null;
    const x = Math.max(it.x, a.x), y = Math.max(it.y, a.y);
    const w = Math.min(it.x + it.w, a.x + a.w) - x, h = Math.min(it.y + it.h, a.y + a.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  /** True when only part of the item will print. */
  croppedOf(it) {
    const v = this.visibleOf(it);
    return !!v && (v.w < it.w || v.h < it.h);
  }

  /** Something can be printed: there's room on the sheet and at least one design reaches it. */
  get fits() {
    return this.printArea.h >= MIN_SIZE && this.items.some(it => this.visibleOf(it));
  }

  /**
   * Add a design: centred, below any designs already waiting on the sheet when there's room,
   * at `widthIn` (shrunk to fit the space left). Selects it.
   */
  add(design, widthIn = 3, id = crypto.randomUUID?.() ?? String(Math.random())) {
    const aspect = design.height / design.width;
    const below = Math.max(this.cursor, ...this.items.map(it => it.y + it.h + GAP));
    const top = this.bottom - below >= MIN_SIZE * 2 ? below : this.cursor;
    const free = this.bottom - top;
    let w = Math.min(WIDTH_DOTS, Math.round(widthIn * DPI));
    if (w * aspect > free) w = Math.max(MIN_SIZE, Math.floor(free / aspect));
    const h = Math.round(w * aspect);
    const it = { id, design, aspect, w, h, x: PRINT_X0 + Math.round((WIDTH_DOTS - w) / 2), y: top, bitmap: null };
    this.items.push(it);
    this.#clamp(it, true);
    this.select(it);
    this.#changed(true);
    return it;
  }

  /** Swap an item's design for another (e.g. a cropped version), keeping its id. */
  replace(it, design, box) {
    Object.assign(it, { design, aspect: design.height / design.width, bitmap: null }, box);
    this.#clamp(it, true);
    this.#changed(true);
  }

  remove(it) {
    this.items = this.items.filter(x => x !== it);
    if (this.selected === it) this.select(this.items.at(-1) ?? null);
    this.#changed(true);
  }

  clear() {
    this.items = [];
    this.select(null);
    this.#changed(true);
  }

  select(it) {
    if (this.selected === it) return;
    this.selected = it;
    this.dispatchEvent(new Event("select"));
    this.draw();
  }

  /** Set the selected design's width in dots, keeping it centred on the same point. */
  setWidth(w) {
    const it = this.selected;
    if (!it) return;
    this.#resize(it, w, it.x + it.w / 2, it.y + it.h / 2);
    this.#changed(true);
  }

  /** Scale the selected design by a factor (e.g. 1.1 for +10%). */
  scale(f) { if (this.selected) this.setWidth(this.selected.w * f); }

  /** Move every design by dy (after a print, so the same layout can be printed again below). */
  shiftAll(dy) {
    for (const it of this.items) { it.y += dy; this.#clamp(it); }
    this.#changed(true);
  }

  /** Re-apply the limits after the print area changed (a print, or the sheet reinserted). */
  refit() {
    for (const it of this.items) this.#clamp(it);
    this.#changed(true);
  }

  #resize(it, w, cx, cy) {
    const wasInside = !this.croppedOf(it);
    w = Math.max(MIN_SIZE, Math.min(WIDTH_DOTS, Math.round(w)));
    it.w = w; it.h = Math.round(w * it.aspect);
    it.x = Math.round(cx - it.w / 2); it.y = Math.round(cy - it.h / 2);
    // Resizing a design that was fully inside keeps it inside; only dragging hangs it off an edge.
    this.#clamp(it, wasInside);
  }

  #clamp(it, inside = false) {
    const a = this.printArea;
    if (inside) {
      if (it.w <= a.w) it.x = Math.max(a.x, Math.min(a.x + a.w - it.w, it.x));
      if (it.h <= a.h) it.y = Math.max(a.y, Math.min(a.y + a.h - it.h, it.y));
    }
    // A design may hang off the print area (only the part inside prints) but always keeps at
    // least MIN_SIZE inside it, so it can't be lost off the edge.
    const keep = (pos, size, a0, aSize) =>
      Math.max(a0 + Math.min(MIN_SIZE, aSize) - size, Math.min(a0 + aSize - Math.min(MIN_SIZE, aSize), pos));
    it.x = keep(it.x, it.w, a.x, a.w);
    it.y = keep(it.y, it.h, a.y, Math.max(a.h, MIN_SIZE));
    if (it === this.selected) {
      const centred = PRINT_X0 + Math.round((WIDTH_DOTS - it.w) / 2);
      this.snapped = Math.abs(it.x - centred) <= SNAP;
      if (this.snapped) it.x = centred;
    }
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

  /**
   * Which design a touch at `pt` means. A line under the finger wins, so a small piece tucked
   * into the empty corner of a bigger design's box can still be picked; failing that, the
   * smallest box containing the point.
   */
  #hit(pt) {
    const r = HIT_PX / this.#view.s;
    const order = [...this.items.filter(it => it !== this.selected), ...(this.selected ? [this.selected] : [])].reverse();
    for (const it of order) {
      if (!it.bitmap || pt.x < it.x - r || pt.x > it.x + it.w + r || pt.y < it.y - r || pt.y > it.y + it.h + r) continue;
      const k = it.bitmap.width / it.w;
      const bx = Math.round((pt.x - it.x - r) * k), by = Math.round((pt.y - it.y - r) * k);
      const n = Math.max(1, Math.round(2 * r * k));
      const sx = Math.max(0, bx), sy = Math.max(0, by);
      const sw = Math.min(it.bitmap.width, bx + n) - sx, sh = Math.min(it.bitmap.height, by + n) - sy;
      if (sw <= 0 || sh <= 0) continue;
      const d = it.bitmap.getContext("2d").getImageData(sx, sy, sw, sh).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) return it;
    }
    const inside = this.items.filter(it => pt.x >= it.x && pt.x <= it.x + it.w && pt.y >= it.y && pt.y <= it.y + it.h);
    return inside.sort((a, b) => a.w * a.h - b.w * b.h)[0] ?? null;
  }

  #down(e) {
    if (!this.items.length) return;
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this.#toSheet(e);
    if (!this.#pointers.size) {
      // First finger picks the design; touching empty paper keeps the current one, so with a
      // single design you can drag from anywhere.
      const hit = this.#hit(pt);
      if (hit) this.select(hit);
    }
    this.#pointers.set(e.pointerId, pt);
    this.#startGesture();
  }

  #startGesture() {
    const it = this.selected;
    if (!it) return;
    const pts = [...this.#pointers.values()], p = { x: it.x, y: it.y, w: it.w, h: it.h };
    if (pts.length === 1) this.#gesture = { type: "drag", start: pts[0], p };
    else if (pts.length >= 2) {
      const [a, b] = pts;
      this.#gesture = { type: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
                        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, p };
    }
  }

  #move(e) {
    if (!this.#pointers.has(e.pointerId) || !this.#gesture || !this.selected) return;
    this.#pointers.set(e.pointerId, this.#toSheet(e));
    const g = this.#gesture, pts = [...this.#pointers.values()], it = this.selected;
    if (g.type === "drag") {
      it.x = Math.round(g.p.x + pts[0].x - g.start.x);
      it.y = Math.round(g.p.y + pts[0].y - g.start.y);
      this.#clamp(it);
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const scale = Math.hypot(a.x - b.x, a.y - b.y) / g.dist;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.#resize(it, g.p.w * scale,
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
    const it = this.selected;
    if (!it) return;
    e.preventDefault();
    this.#resize(it, it.w * Math.exp(-e.deltaY * 0.002), it.x + it.w / 2, it.y + it.h / 2);
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

    // centre guide while dragging the selected design onto the centre line
    if (this.selected && this.snapped && this.#gesture) {
      ctx.strokeStyle = "rgba(230,60,140,.8)";
      ctx.lineWidth = px;
      ctx.beginPath(); ctx.moveTo(SHEET_W / 2, 0); ctx.lineTo(SHEET_W / 2, SHEET_H); ctx.stroke();
    }

    // the designs (only black is drawn, so overlapping boxes never hide each other's lines)
    const accent = col("--accent") || "#0a84ff";
    const order = [...this.items.filter(it => it !== this.selected), ...(this.selected ? [this.selected] : [])];
    for (const it of order) {
      const vis = this.visibleOf(it), cropped = this.croppedOf(it), sel = it === this.selected;
      if (it.bitmap) {
        ctx.imageSmoothingEnabled = true;
        // Faint everywhere, then full strength only where it will actually print.
        ctx.globalAlpha = cropped || !vis ? 0.18 : 1;
        ctx.drawImage(it.bitmap, it.x, it.y, it.w, it.h);
        ctx.globalAlpha = 1;
        if (cropped) {
          ctx.save();
          ctx.beginPath(); ctx.rect(vis.x, vis.y, vis.w, vis.h); ctx.clip();
          ctx.drawImage(it.bitmap, it.x, it.y, it.w, it.h);
          ctx.restore();
        }
      }
      if (cropped) {
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.strokeStyle = "rgba(120,120,120,.8)";
        ctx.lineWidth = (sel ? 2 : 1) * px;
        ctx.strokeRect(it.x, it.y, it.w, it.h);
        ctx.setLineDash([]);
      }
      const box = vis ?? it;
      ctx.strokeStyle = !vis ? "#e5352b" : sel ? accent : "rgba(120,130,150,.7)";
      ctx.lineWidth = (sel ? 2 : 1) * px;
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }
    ctx.restore();
  }
}

export const fmtIn = dots => `${(dots / DPI).toFixed(2)}″`;
