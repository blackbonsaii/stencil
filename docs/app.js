import { buildJob, DPI, FEED_LINES, INTER_JOB_GAP_DOTS, WIDTH_DOTS } from "./protocol.js?v=2.1";
import { Printer } from "./printer.js?v=2.1";
import { loadDesign, cropDesign, designBlob, designThumb, grayAtSize, previewBitmap, ghostThumb, packRows, mergeRows,
         calibrationGray, sizeCheckDesign } from "./imaging.js?v=2.1";
import { listRecent, getRecent, touchRecent, removeRecent } from "./library.js?v=2.1";
import { openCrop } from "./crop.js?v=2.1";
const VERSION = "2.1";
import { SheetView, PRINT_X0, SHEET_H, fmtIn } from "./sheet.js?v=2.1";

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


// ---- settings ---------------------------------------------------------------

$("thr").value = settings.threshold;
$("dens").value = settings.density;
$("mirror").checked = settings.mirror;
const showSettings = () => {
  $("thr-out").textContent = settings.threshold < 110 ? "thin" : settings.threshold > 190 ? "bold" : "normal";
  $("dens-out").textContent = `${settings.density} / 8`;
};
showSettings();

$("thr").addEventListener("input", e => { settings.threshold = +e.target.value; saveSettings(); refreshPreviews(); });
$("dens").addEventListener("input", e => { settings.density = +e.target.value; saveSettings(); });
$("mirror").addEventListener("change", e => { settings.mirror = e.target.checked; saveSettings(); refreshPreviews(); });
function saveSettings() { store.set("settings", settings); showSettings(); }

// ---- designs on the sheet ------------------------------------------------------

/** Put a design on the sheet. `recentId` links it to its entry in the recent list. */
function addDesign(design, widthIn, { recentId, keep = true } = {}) {
  const it = sheet.add(design, widthIn, recentId);
  it.keep = keep;               // false for test patterns, which don't go in the recent list
  $("empty-hint").hidden = true;
  return it;
}

$("size-check").addEventListener("click", () => {
  addDesign(sizeCheckDesign(DPI), 4, { keep: false });
  say("4 × 4 in size check placed. Print it, then measure the square's height and width.");
});

$("file").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  say("Loading…");
  try {
    addDesign(await loadDesign(file));
    say("");
  } catch (err) {
    say(err.message || "Couldn't open that image.", true);
  }
});

/** Each design's preview: exactly the dots that will print, at its current size. */
function refreshPreview(it) {
  const key = `${it.w}x${it.h}`;
  if (key !== it.grayKey) { it.gray = grayAtSize(it.design, it.w, it.h); it.grayKey = key; }
  it.bitmap = previewBitmap(it.gray, it.w, it.h, settings.threshold, settings.mirror);
}
function refreshPreviews() {
  for (const it of sheet.items) refreshPreview(it);
  sheet.draw();
}

sheet.addEventListener("change", e => {
  if (e.detail.final) refreshPreviews();
  showSize();
  updatePrintButton();
});
sheet.addEventListener("select", showSize);

function showSize() {
  const it = sheet.selected, n = sheet.items.length;
  $("size-group").hidden = !it;
  $("empty-hint").hidden = n > 0;
  if (!it) return;
  $("sel-name").textContent = n > 1 ? `${n} designs on the sheet · tap one to select it` : "";
  $("sel-name").hidden = n < 2;
  if (document.activeElement !== $("w-in")) $("w-in").value = (it.w / DPI).toFixed(2);
  if (document.activeElement !== $("h-in")) $("h-in").value = (it.h / DPI).toFixed(2);
  const cm = d => (d / DPI * 2.54).toFixed(1);
  const note = $("size-note");
  const v = sheet.visibleOf(it);
  if (sheet.printArea.h < DPI / 4) {
    note.textContent = `No room left on this sheet (${fmtIn(sheet.bottom - sheet.cursor)} below the last print). Put it back in at the top or use a new sheet.`;
    note.classList.add("bad");
  } else if (sheet.croppedOf(it)) {
    note.textContent = `Only the bright part prints: ${fmtIn(v.w)} × ${fmtIn(v.h)}. The faded part is outside the printable area.`;
    note.classList.remove("bad");
  } else {
    note.textContent = `${cm(it.w)} × ${cm(it.h)} cm · pinch the sheet to resize, drag to move`;
    note.classList.remove("bad");
  }
}

for (const [id, axis] of [["w-in", "w"], ["h-in", "h"]]) {
  $(id).addEventListener("change", e => {
    const v = parseFloat(e.target.value), it = sheet.selected;
    if (!(v > 0) || !it) return showSize();
    const dots = v * DPI;
    sheet.setWidth(axis === "w" ? dots : dots / it.aspect);
    e.target.blur();
  });
}
$("smaller").addEventListener("click", () => sheet.scale(1 / 1.1));
$("bigger").addEventListener("click", () => sheet.scale(1.1));
$("remove").addEventListener("click", () => { if (sheet.selected) sheet.remove(sheet.selected); });

$("crop").addEventListener("click", async () => {
  const it = sheet.selected;
  if (!it) return;
  const rect = await openCrop($("crop-dialog"), it.design, settings.mirror);
  if (!rect) return;
  const cut = cropDesign(it.design, rect);
  if (!cut) return say("There are no lines inside that box.", true);
  // Keep the cropped part exactly where it was on the sheet, at the same scale.
  const k = it.w / it.design.width, d = cut.design;
  const ox = settings.mirror ? it.design.width - cut.offset.x - d.width : cut.offset.x;
  it.id = crypto.randomUUID?.() ?? String(Math.random());   // a new design for the recent list
  it.grayKey = "";
  sheet.replace(it, d, { x: Math.round(it.x + ox * k), y: Math.round(it.y + cut.offset.y * k),
                         w: Math.round(d.width * k), h: Math.round(d.height * k) });
  say("");
});

// ---- recent designs ---------------------------------------------------------------

let recentEditing = false;
async function showRecent() {
  let list = [];
  try { list = await listRecent(); } catch (err) { printer.log(`recent designs unavailable: ${err.message || err}`); }
  $("recent-group").hidden = list.length === 0;
  if (!list.length) recentEditing = false;
  $("recent-edit").textContent = recentEditing ? "Done" : "Edit";
  const box = $("recent");
  box.replaceChildren(...list.map(r => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "recent-item" + (recentEditing ? " editing" : "");
    b.title = r.name;
    b.dataset.id = r.id;
    const img = document.createElement("img");
    img.src = r.thumb; img.alt = r.name;
    const cap = document.createElement("span");
    cap.textContent = `${r.widthIn.toFixed(1)}″ wide`;
    b.append(img, cap);
    if (recentEditing) {
      const x = document.createElement("span");
      x.className = "recent-x"; x.textContent = "×"; x.setAttribute("aria-label", "Remove");
      b.append(x);
    }
    return b;
  }));
}
$("recent").addEventListener("click", async e => {
  const b = e.target.closest(".recent-item");
  if (!b) return;
  const id = b.dataset.id;
  try {
    if (recentEditing) { await removeRecent(id); return showRecent(); }
    say("Loading…");
    const r = await getRecent(id);
    if (!r) return showRecent();
    addDesign(await loadDesign(r.blob, r.name), r.widthIn, { recentId: r.id });
    say("");
  } catch (err) {
    say(err.message || "Couldn't open that design.", true);
  }
});
$("recent-edit").addEventListener("click", () => { recentEditing = !recentEditing; showRecent(); });
showRecent();

/** Remember printed designs and the size they were printed at. */
async function rememberPrinted(items) {
  for (const it of items) {
    if (!it.keep) continue;
    try {
      await touchRecent({ id: it.id, name: it.design.name || "design", widthIn: it.w / DPI,
                          thumb: designThumb(it.design), makeBlob: () => designBlob(it.design) });
    } catch (err) {
      printer.log(`couldn't save to recent designs: ${err.message || err}`);
    }
  }
  showRecent();
}

// ---- sheet state --------------------------------------------------------------

function saveSheet() {
  store.set("sheet", { cursor: sheet.cursor, ghosts: sheet.ghosts });
  const n = sheet.ghosts.length;
  $("sheet-note").textContent = n === 0 ? "Fresh sheet"
    : `${n} print${n > 1 ? "s" : ""} on this sheet` +
      (sheet.cursor > sheet.topMargin ? ` · ${fmtIn(sheet.bottom - sheet.cursor)} left below the last one` : " · sheet back at the top");
  sheet.refit();
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
  $("print").disabled = !sheet.fits || printer.busy;
  $("print").textContent = printer.connected ? "Print" : "Connect & print";
  if (sheet.items.length > 1) $("print").textContent += ` ${sheet.items.length} designs`;
}

$("print").addEventListener("click", async () => {
  if (!sheet.fits) return;
  try {
    if (!printer.connected) await printer.connect(step => { if (step) $("connect-label").textContent = step; });
    const opts = { lead: 0, maxRows: sheet.bottom - sheet.cursor, threshold: settings.threshold, mirror: settings.mirror };
    const printed = [];
    const parts = sheet.items.map(it => {
      refreshPreview(it);
      const part = packRows(it.gray, it.w, it.h, { ...opts, x: it.x - PRINT_X0, lead: it.y - sheet.cursor });
      if (part.height) printed.push(it);
      return part;
    });
    // One job for every design: overlapping boxes just add their lines together.
    const { rows, height } = mergeRows(parts);
    if (!height) return say(sheet.items.some(it => sheet.croppedOf(it))
      ? "Nothing to print in the bright part. Move the design so its lines are inside the printable area."
      : "Nothing to print. Try a bolder line thickness.", true);
    const job = buildJob(rows, height, settings.density);
    const ghosts = printed.map(it => {
      const v = sheet.visibleOf(it);   // only this part prints when a design hangs off the print area
      return { ...v, thumb: ghostThumb(it.bitmap, { x: v.x - it.x, y: v.y - it.y, w: v.w, h: v.h }) };
    });
    const endCursor = sheet.cursor + height + FEED_LINES + INTER_JOB_GAP_DOTS;

    $("progress").hidden = false;
    $("progress").value = 0;
    updatePrintButton();
    say("Printing…");
    await printer.print(job, f => { $("progress").value = f; });
    // The sheet stays where the print stopped; the paper sensor resets this when it's taken out.
    sheet.ghosts.push(...ghosts);
    sheet.cursor = Math.min(sheet.bottom, endCursor);
    // Keep the designs, moved below what just printed, so the same layout can be resized and
    // printed again straight away.
    const top = Math.min(...sheet.items.map(it => it.y));
    if (top < sheet.cursor) sheet.shiftAll(sheet.cursor - top);
    saveSheet();
    say("Printed. The next print goes below this one, or take the sheet out and back in to start at the top.");
    rememberPrinted(printed);
  } catch (err) {
    if (err.name !== "NotFoundError") say(err.message || String(err), true);
  } finally {
    $("progress").hidden = true;
    updatePrintButton();
  }
});

/**
 * Ask what happened to the sheet. With `canBeIn` false (the sensor just saw a sheet go in) the
 * only question is whether it's the same sheet, so its earlier outlines should stay.
 */
function askSheet({ title, text, canBeIn }) {
  const dlg = $("sheet-ask");
  if (dlg.open) dlg.close("cancel");
  $("sheet-ask-title").textContent = title;
  $("sheet-ask-text").textContent = text;
  $("sheet-ask-in").hidden = !canBeIn;
  dlg.addEventListener("close", () => {
    const where = dlg.returnValue;
    if (where === "done") { sheet.ghosts = []; sheet.cursor = freshCursor(); }
    else if (where === "top") sheet.cursor = freshCursor();
    else if (where === "in" || where === "cancel") return;
    saveSheet();
  }, { once: true });
  dlg.returnValue = canBeIn ? "in" : "top";
  dlg.showModal();
}

// The paper sensor tells us when a sheet comes out or goes in, so the app always knows where
// the next print starts instead of relying on someone remembering to tap "New sheet".
printer.addEventListener("paper", e => {
  if (!e.detail.loaded) return say("Sheet out. The next one you put in starts at the top.");
  sheet.cursor = freshCursor();
  saveSheet();
  say("");
  if (sheet.ghosts.length) {
    askSheet({ title: "Sheet loaded", text: "Is it the same sheet again? Its earlier prints will show as outlines.", canBeIn: false });
  }
});

// While disconnected the sheet may have been swapped unseen. If the app thinks it's partway down
// a sheet, ask on reconnect (but not after the brief drop iOS does right after pairing).
let linked = false, disconnectedAt = 0;
printer.addEventListener("connection", () => {
  if (printer.connected === linked) return;      // fires more than once per connect
  linked = printer.connected;
  if (!linked) { disconnectedAt = Date.now(); return; }
  const unseen = !disconnectedAt || Date.now() - disconnectedAt > 10000;
  if (unseen && sheet.cursor > freshCursor()) {
    askSheet({ title: "Where's the sheet?", canBeIn: true,
      text: `The last print stopped ${fmtIn(sheet.cursor - freshCursor())} down the sheet. If the sheet hasn't moved, the next print goes below it.` });
  }
});

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
  navigator.serviceWorker.register("sw.js?v=2.1").catch(() => {});
}
