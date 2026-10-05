// Full-screen crop: drag out a box around the part of the design to keep, adjust it by its
// corners or move it, then Crop. Works in the design's own pixels.
const HANDLE_PX = 30;     // how close to a corner counts as grabbing it, screen px
const MIN_PX = 12;        // smallest box, screen px

/**
 * @param {HTMLDialogElement} dlg   dialog containing canvas.crop-canvas and buttons with
 *                                  value="cancel" | "reset" | "crop"
 * @param {{source: CanvasImageSource, width: number, height: number}} design
 * @param {boolean} mirror  show it flipped, as it appears on the sheet
 * @returns {Promise<{x: number, y: number, w: number, h: number} | null>} source pixels, or null
 */
export function openCrop(dlg, design, mirror) {
  const cv = dlg.querySelector(".crop-canvas"), ctx = cv.getContext("2d");
  let view = { s: 1, ox: 0, oy: 0 };
  let box = null;               // display px, relative to the canvas
  let grab = null;

  const layout = () => {
    const dpr = window.devicePixelRatio || 1, cw = cv.clientWidth, ch = cv.clientHeight;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 16, s = Math.min((cw - pad * 2) / design.width, (ch - pad * 2) / design.height);
    view = { s, ox: (cw - design.width * s) / 2, oy: (ch - design.height * s) / 2 };
  };
  const img = { x: () => view.ox, y: () => view.oy, w: () => design.width * view.s, h: () => design.height * view.s };
  const clampBox = b => {
    const x0 = Math.max(img.x(), Math.min(b.x, b.x + b.w)), y0 = Math.max(img.y(), Math.min(b.y, b.y + b.h));
    const x1 = Math.min(img.x() + img.w(), Math.max(b.x, b.x + b.w)), y1 = Math.min(img.y() + img.h(), Math.max(b.y, b.y + b.h));
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  };

  const draw = () => {
    const cw = cv.clientWidth, ch = cv.clientHeight;
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    if (mirror) { ctx.translate(cw, 0); ctx.scale(-1, 1); }
    ctx.fillStyle = "#fff";
    const ix = mirror ? cw - img.x() - img.w() : img.x();
    ctx.fillRect(ix, img.y(), img.w(), img.h());
    ctx.drawImage(design.source, ix, img.y(), img.w(), img.h());
    ctx.restore();
    if (!box) return;
    // dim everything outside the box
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(box.x, box.y + box.h, box.w, -box.h);     // reverse winding cuts the hole
    ctx.fill("evenodd");
    ctx.strokeStyle = "#0a84ff"; ctx.lineWidth = 2;
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = "#0a84ff";
    for (const [x, y] of corners(box)) { ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); }
  };
  const corners = b => [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]];

  const at = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = e => {
    cv.setPointerCapture(e.pointerId);
    const p = at(e);
    const ci = box ? corners(box).findIndex(([x, y]) => Math.hypot(x - p.x, y - p.y) < HANDLE_PX) : -1;
    if (ci >= 0) {
      // drag this corner: the opposite one stays put
      const [ox, oy] = corners(box)[3 - ci];
      grab = { type: "draw", ox, oy };
    } else if (box && p.x > box.x && p.x < box.x + box.w && p.y > box.y && p.y < box.y + box.h) {
      grab = { type: "move", start: p, b: { ...box } };
    } else {
      grab = { type: "draw", ox: p.x, oy: p.y };
    }
  };
  const move = e => {
    if (!grab) return;
    const p = at(e);
    if (grab.type === "draw") box = clampBox({ x: grab.ox, y: grab.oy, w: p.x - grab.ox, h: p.y - grab.oy });
    else {
      const b = grab.b;
      box = {
        ...b,
        x: Math.max(img.x(), Math.min(img.x() + img.w() - b.w, b.x + p.x - grab.start.x)),
        y: Math.max(img.y(), Math.min(img.y() + img.h() - b.h, b.y + p.y - grab.start.y)),
      };
    }
    draw();
  };
  const up = () => { grab = null; if (box && (box.w < MIN_PX || box.h < MIN_PX)) box = null; update(); draw(); };
  const update = () => { dlg.querySelector('[value="crop"]').disabled = !box; };

  return new Promise(resolve => {
    const onResize = () => {
      // keep the box over the same part of the design
      const src = box && toSource(box);
      layout();
      if (src) box = fromSource(src);
      draw();
    };
    const toSource = b => {
      let x = (b.x - view.ox) / view.s;
      const y = (b.y - view.oy) / view.s, w = b.w / view.s, h = b.h / view.s;
      if (mirror) x = design.width - x - w;
      return { x, y, w, h };
    };
    const fromSource = r => {
      const x = mirror ? design.width - r.x - r.w : r.x;
      return { x: view.ox + x * view.s, y: view.oy + r.y * view.s, w: r.w * view.s, h: r.h * view.s };
    };
    const onClick = e => {
      const v = e.target.closest("button")?.value;
      if (v === "reset") { e.preventDefault(); box = null; update(); draw(); }
    };
    const ro = new ResizeObserver(onResize);
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    dlg.addEventListener("click", onClick);
    dlg.addEventListener("close", () => {
      ro.disconnect();
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      dlg.removeEventListener("click", onClick);
      resolve(dlg.returnValue === "crop" && box ? toSource(box) : null);
    }, { once: true });
    dlg.returnValue = "cancel";
    update();
    dlg.showModal();
    ro.observe(cv);
    layout(); draw();
  });
}
