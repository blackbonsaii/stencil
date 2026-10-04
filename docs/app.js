import { buildJob, DPI, FEED_LINES, INTER_JOB_GAP_DOTS, WIDTH_DOTS } from "./protocol.js?v=1.6";
import { Printer } from "./printer.js?v=1.6";
import { loadDesign, grayAtSize, previewBitmap, ghostThumb, packRows, calibrationGray, sizeCheckDesign } from "./imaging.js?v=1.6";
const VERSION = "1.6";
import { SheetView, PRINT_X0, SHEET_H, fmtIn } from "./sheet.js?v=1.6";

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const settings = Object.assign({ threshold: 160, density: 4, mirror: false, topMarginIn: 0.25 },
                               store.get("settings", {}));
const printer = new Printer();
const sheet = new SheetView($("sheet"));
applyCalibration();
const saved = store.get("sheet", { cursor: 0, ghosts: [] });
sheet.cursor = Math.max(sheet.topMargin, saved.cursor);
sheet.ghosts = saved.ghosts;

function applyCalibration() {
  sheet.topMargin = Math.round(settings.topMarginIn * DPI);
  sheet.bottom = SHEET_H;
}
const freshCursor = () => sheet.topMargin;

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

function useDesign(d, widthIn) {
  design = d;
  gray = null; grayKey = "";
  sheet.bitmap = null;
  sheet.place(design.height / design.width, widthIn);
  $("file-label").textContent = "Change design";
  $("empty-hint").hidden = true;
  $("size-group").hidden = false;
}

$("size-check").addEventListener("click", () => {
  useDesign(sizeCheckDesign(DPI), 4);
  say("4 × 4 in size check placed. Print it, then measure the square's height and width.");
});

$("file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  say("Loading…");
  try {
    useDesign(await loadDesign(file));
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
    note.textContent = `Doesn't fit in the space left on this sheet (${fmtIn(sheet.bottom - sheet.cursor)} tall). Make it smaller or start a new sheet.`;
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
      (sheet.cursor > sheet.topMargin ? ` · ${fmtIn(sheet.bottom - sheet.cursor)} left below the last one` : " · sheet back at the top");
  if (sheet.placement) sheet.place(sheet.aspect, sheet.placement.w / DPI);
  else sheet.draw();
  showSize();
  updatePrintButton();
}

$("new-sheet").addEventListener("click", () => { sheet.ghosts = []; sheet.cursor = freshCursor(); saveSheet(); });
$("reinserted").addEventListener("click", () => { sheet.cursor = freshCursor(); saveSheet(); });
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
    if (s.coverClosed === false) bits.push("check cover");
    else if (s.paper === false) bits.push("no paper?");
    $("connect-label").textContent = bits.join(" · ");
  }
  updatePrintButton();
}
printer.addEventListener("connection", showPrinter);

// Diagnostics log, so a failure on the phone can be copied and shared.
const logLines = [];
printer.addEventListener("log", e => {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  logLines.push(`${time}  ${e.detail}`);
  if (logLines.length > 300) logLines.shift();
  $("log").textContent = logLines.join("\n");
});
$("copy-log").addEventListener("click", async () => {
  const text = `Stencil v${VERSION} · ${navigator.userAgent}\n${logLines.join("\n")}`;
  try { await navigator.clipboard.writeText(text); $("copy-log").textContent = "Copied"; }
  catch {
    const r = document.createRange(); r.selectNodeContents($("log"));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    $("copy-log").textContent = "Selected, tap Copy";
  }
  setTimeout(() => { $("copy-log").textContent = "Copy log"; }, 2500);
});
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
    if (where === "done") { sheet.ghosts = []; sheet.cursor = freshCursor(); }
    else {
      sheet.ghosts.push(ghost);
      sheet.cursor = where === "top" ? freshCursor() : Math.min(sheet.bottom, endCursor);
    }
    saveSheet();
  }, { once: true });
  dlg.returnValue = "in";
  dlg.showModal();
}

// ---- calibration ------------------------------------------------------------------

$("cal-top").value = settings.topMarginIn.toFixed(2);
for (const id of ["cal-top"]) {
  $(id).addEventListener("change", () => {
    const top = parseFloat($("cal-top").value);
    if (top >= 0 && top < 4) settings.topMarginIn = top;
    store.set("settings", settings);
    applyCalibration();
    sheet.cursor = Math.max(sheet.cursor, freshCursor());
    saveSheet();
    say("Calibration saved.");
  });
}

$("cal-print").addEventListener("click", async () => {
  try {
    if (!printer.connected) await printer.connect(step => { if (step) $("connect-label").textContent = step; });
    const rows = SHEET_H;   // a full sheet's worth, so it shows where printing stops
    const { rows: data, height } = packRows(calibrationGray(WIDTH_DOTS, rows, DPI), WIDTH_DOTS, rows,
                                            { threshold: 128 });
    $("progress").hidden = false;
    say("Printing calibration page…");
    await printer.print(buildJob(data, height, settings.density), f => { $("progress").value = f; });
    say("Now measure from the top edge of the sheet to the 0 line, and note the last line number that printed.");
    sheet.ghosts = []; sheet.cursor = freshCursor(); saveSheet();
  } catch (err) {
    if (err.name !== "NotFoundError") say(err.message || String(err), true);
  } finally {
    $("progress").hidden = true;
  }
});

function say(text, bad = false) {
  $("message").textContent = text;
  $("message").classList.toggle("bad", bad);
}

$("version").textContent = `Stencil v${VERSION}`;

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js?v=1.6").catch(() => {});
}
