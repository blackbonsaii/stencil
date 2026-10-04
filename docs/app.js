import { buildJob, DPI, FEED_LINES, INTER_JOB_GAP_DOTS } from "./protocol.js";
import { Printer } from "./printer.js";
import { loadDesign, grayAtSize, previewBitmap, ghostThumb, packRows } from "./imaging.js";
const VERSION = "1.2";
import { SheetView, PRINT_X0, SHEET_H, fmtIn } from "./sheet.js";

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const settings = Object.assign({ threshold: 160, density: 4, mirror: false }, store.get("settings", {}));
const printer = new Printer();
const sheet = new SheetView($("sheet"));
const saved = store.get("sheet", { cursor: 0, ghosts: [] });
sheet.cursor = saved.cursor;
sheet.ghosts = saved.ghosts;

let design = null;      // {source, width, height, name}
let gray = null;        // design at current print size
let grayKey = "";

// ---- settings ---------------------------------------------------------------

$("thr").value = settings.threshold;
$("dens").value = settings.density;
$("mirror").checked = settings.mirror;
const showSettings = () => {
  $("thr-out").textContent = settings.threshold < 110 ? "thin" : settings.threshold > 190 ? "bold" : "normal";
  $("dens-out").textContent = `${settings.density} / 8`;
};
showSettings();

$("thr").addEventListener("input", e => { settings.threshold = +e.target.value; saveSettings(); refreshPreview(); });
$("dens").addEventListener("input", e => { settings.density = +e.target.value; saveSettings(); });
$("mirror").addEventListener("change", e => { settings.mirror = e.target.checked; saveSettings(); refreshPreview(); });
function saveSettings() { store.set("settings", settings); showSettings(); }

// ---- design -----------------------------------------------------------------

$("file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  say("Loading…");
  try {
    design = await loadDesign(file);
    gray = null; grayKey = "";
    sheet.bitmap = null;
    sheet.place(design.height / design.width);
    $("file-label").textContent = "Change design";
    $("empty-hint").hidden = true;
    $("size-group").hidden = false;
    say("");
  } catch (err) {
    say(err.message || "Couldn't open that image.", true);
  }
});

function refreshPreview() {
  const p = sheet.placement;
  if (!design || !p) return;
  const key = `${p.w}x${p.h}`;
  if (key !== grayKey) { gray = grayAtSize(design, p.w, p.h); grayKey = key; }
  sheet.bitmap = previewBitmap(gray, p.w, p.h, settings.threshold, settings.mirror);
  sheet.draw();
}

sheet.addEventListener("change", e => {
  if (e.detail.final) refreshPreview();
  showSize();
  updatePrintButton();
});

function showSize() {
  const p = sheet.placement;
  if (!p) return;
  if (document.activeElement !== $("w-in")) $("w-in").value = (p.w / DPI).toFixed(2);
  if (document.activeElement !== $("h-in")) $("h-in").value = (p.h / DPI).toFixed(2);
  const cm = d => (d / DPI * 2.54).toFixed(1);
  const note = $("size-note");
  if (sheet.fits) {
    note.textContent = `${cm(p.w)} × ${cm(p.h)} cm · pinch the sheet to resize, drag to move`;
    note.classList.remove("bad");
  } else {
    note.textContent = `Doesn't fit in the space left on this sheet (${fmtIn(SHEET_H - sheet.cursor)} tall). Make it smaller or start a new sheet.`;
    note.classList.add("bad");
  }
}

for (const [id, axis] of [["w-in", "w"], ["h-in", "h"]]) {
  $(id).addEventListener("change", e => {
    const v = parseFloat(e.target.value);
    if (!(v > 0) || !sheet.placement) return showSize();
    const dots = v * DPI;
    sheet.setWidth(axis === "w" ? dots : dots / sheet.aspect);
    e.target.blur();
  });
}

// ---- sheet state --------------------------------------------------------------

function saveSheet() {
  store.set("sheet", { cursor: sheet.cursor, ghosts: sheet.ghosts });
  const n = sheet.ghosts.length;
  $("sheet-note").textContent = n === 0 ? "Fresh sheet"
    : `${n} print${n > 1 ? "s" : ""} on this sheet` +
      (sheet.cursor > 0 ? ` · ${fmtIn(SHEET_H - sheet.cursor)} left below the last one` : " · sheet back at the top");
  if (sheet.placement) sheet.place(sheet.aspect, sheet.placement.w / DPI);
  else sheet.draw();
  showSize();
  updatePrintButton();
}

$("new-sheet").addEventListener("click", () => { sheet.ghosts = []; sheet.cursor = 0; saveSheet(); });
$("reinserted").addEventListener("click", () => { sheet.cursor = 0; saveSheet(); });
saveSheet();

// ---- printer --------------------------------------------------------------------

$("connect").addEventListener("click", async () => {
  if (printer.connected) return printer.refreshStatus().catch(() => {});
  try {
    say("");
    await printer.connect(step => { if (step) $("connect-label").textContent = step; });
  } catch (err) {
    if (err.name !== "NotFoundError") say(err.message || String(err), true);   // NotFound = user cancelled
    showPrinter();
  }
});

function showPrinter() {
  const chip = $("connect"), s = printer.status;
  chip.classList.toggle("on", printer.connected && s.paper !== false && s.coverClosed !== false);
  chip.classList.toggle("warn", printer.connected && (s.paper === false || s.coverClosed === false));
  if (!printer.connected) $("connect-label").textContent = printer.device ? "Reconnect printer" : "Connect printer";
  else {
    const bits = ["TP88"];
    if (s.battery != null) bits.push(`${s.battery}%`);
    if (s.coverClosed === false) bits.push("cover open");
    else if (s.paper === false) bits.push("no paper?");
    $("connect-label").textContent = bits.join(" · ");
  }
  updatePrintButton();
}
printer.addEventListener("connection", showPrinter);
printer.addEventListener("status", showPrinter);

function updatePrintButton() {
  $("print").disabled = !design || !sheet.fits || printer.busy;
  $("print").textContent = printer.connected ? "Print" : "Connect & print";
}

$("print").addEventListener("click", async () => {
  const p = sheet.placement;
  if (!design || !p || !sheet.fits) return;
  try {
    if (!printer.connected) await printer.connect(step => { if (step) $("connect-label").textContent = step; });
    refreshPreview();
    const { rows, height } = packRows(gray, p.w, p.h, {
      x: p.x - PRINT_X0,
      lead: p.y - sheet.cursor,
      threshold: settings.threshold,
      mirror: settings.mirror,
    });
    if (!height) return say("Nothing to print. Try a bolder line thickness.", true);
    const job = buildJob(rows, height, settings.density);
    const ghost = { x: p.x, y: p.y, w: p.w, h: p.h, thumb: ghostThumb(sheet.bitmap) };
    const endCursor = sheet.cursor + height + FEED_LINES + INTER_JOB_GAP_DOTS;

    $("progress").hidden = false;
    $("progress").value = 0;
    updatePrintButton();
    say("Printing…");
    await printer.print(job, f => { $("progress").value = f; });
    say("");
    afterPrint(ghost, endCursor);
  } catch (err) {
    if (err.name !== "NotFoundError") say(err.message || String(err), true);
  } finally {
    $("progress").hidden = true;
    updatePrintButton();
  }
});

function afterPrint(ghost, endCursor) {
  const dlg = $("after-print");
  dlg.addEventListener("close", () => {
    const where = dlg.returnValue;
    if (where === "done") { sheet.ghosts = []; sheet.cursor = 0; }
    else {
      sheet.ghosts.push(ghost);
      sheet.cursor = where === "top" ? 0 : Math.min(SHEET_H, endCursor);
    }
    saveSheet();
  }, { once: true });
  dlg.returnValue = "in";
  dlg.showModal();
}

function say(text, bad = false) {
  $("message").textContent = text;
  $("message").classList.toggle("bad", bad);
}

$("version").textContent = `Stencil v${VERSION}`;

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
