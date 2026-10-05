// Checks the browser code produces byte-identical jobs to the Python driver that printed correctly.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJob, parseStatus, WIDTH_BYTES } from "../docs/protocol.js";
import { packRows, toGray, inkBounds, mergeRows } from "../docs/raster.js";

const dir = new URL(".", import.meta.url);
const gray = new Uint8Array(readFileSync(new URL("fixture.gray", dir)));
const expected = new Uint8Array(readFileSync(new URL("fixture.job", dir)));

test("job bytes match the Python driver", () => {
  const { rows, height } = packRows(gray, 1664, 600, { threshold: 128 });
  assert.equal(height, 600);
  assert.deepEqual(buildJob(rows, height, 5), expected);
});

test("lead rows are blank and shift the design down", () => {
  const { rows, height } = packRows(gray, 1664, 600, { lead: 10, threshold: 128 });
  assert.equal(height, 610);
  assert.ok(rows.subarray(0, 10 * WIDTH_BYTES).every(b => b === 0));
  const base = packRows(gray, 1664, 600, { threshold: 128 }).rows;
  assert.deepEqual(rows.subarray(10 * WIDTH_BYTES), base);
});

test("trailing blank rows are trimmed", () => {
  const g = new Uint8Array(16 * 20).fill(255);
  g[3 * 16 + 5] = 0;
  const { height } = packRows(g, 16, 20, { x: 0, threshold: 128 });
  assert.equal(height, 4);
});

test("blank design produces nothing", () => {
  assert.equal(packRows(new Uint8Array(64).fill(255), 8, 8, {}).height, 0);
});

test("x offset, mirror and clipping", () => {
  const g = new Uint8Array(8).fill(255); g[0] = 0;             // 8x1, leftmost dot black
  let r = packRows(g, 8, 1, { x: 9, flipSheet: false }).rows;                    // dot at 9
  assert.equal(r[1], 0x40);
  r = packRows(g, 8, 1, { x: 9, mirror: true, flipSheet: false }).rows;          // dot at 16
  assert.equal(r[2], 0x80);
  r = packRows(g, 8, 1, { x: 1660, flipSheet: false }).rows;                     // overhang right: dot 1660 kept
  assert.equal(r[207], 0x08);
  r = packRows(g, 8, 1, { x: -3, mirror: true, flipSheet: false }).rows;         // overhang left, mirrored dot at 4
  assert.equal(r[0], 0x08);
});

test("design hanging off the top, bottom or side prints only the part inside", () => {
  // 2 wide x 6 tall, one black dot per row in column 0, plus column 1 black on row 5 only
  const g = new Uint8Array(12).fill(255);
  for (let y = 0; y < 6; y++) g[y * 2] = 0;
  g[11] = 0;
  const opts = { flipSheet: false };
  let p = packRows(g, 2, 6, { ...opts, lead: -2 });             // top 2 rows above the cursor: cut
  assert.equal(p.height, 4);
  p = packRows(g, 2, 6, { ...opts, lead: 3, maxRows: 5 });      // only 2 design rows before the sheet ends
  assert.equal(p.height, 5);
  p = packRows(g, 2, 6, { ...opts, lead: -2, maxRows: 3 });     // both at once
  assert.equal(p.height, 3);
  // Column 0 off the left edge: only column 1 prints, so rows 0-4 are blank and are trimmed away
  // from the end, but not from the start (they position row 5).
  p = packRows(g, 2, 6, { ...opts, x: -1 });
  assert.equal(p.height, 6);
  assert.equal(p.rows[5 * 208], 0x80);
  // Only row 5's dot is in column 1; with row 5 below the sheet end there's nothing left to print.
  assert.equal(packRows(g, 2, 6, { ...opts, x: -1, maxRows: 5 }).height, 0);
  assert.equal(packRows(g, 2, 6, { ...opts, lead: -6 }).height, 0);
});

test("sheet flip puts the leftmost on-screen dot at the far end of the row", () => {
  const g = new Uint8Array(8).fill(255); g[0] = 0;
  const r = packRows(g, 8, 1, { x: 0 }).rows;
  assert.equal(r[207], 0x01);
  assert.equal(r.subarray(0, 207).every(b => b === 0), true);
});

test("transparency becomes white; ink bounds", () => {
  const rgba = new Uint8ClampedArray([0,0,0,0,  0,0,0,255,  255,255,255,255,  0,0,0,255]);
  assert.deepEqual(Array.from(toGray(rgba)), [255, 0, 255, 0]);
  assert.deepEqual(inkBounds(toGray(rgba), 2, 2, 128), { x: 1, y: 0, w: 1, h: 2 });
  assert.equal(inkBounds(new Uint8Array(4).fill(255), 2, 2, 128), null);
});

test("status parsing", () => {
  assert.deepEqual(parseStatus([0x1a, 0x06, 0x89]), { paper: true });
  assert.deepEqual(parseStatus([0x1a, 0x06, 0x88]), { paper: false });
  assert.deepEqual(parseStatus([0x1a, 0x04, 0x64]), { battery: 100 });
  assert.equal(parseStatus([0x01, 0x01]), null);
});

test("several designs merge into one print; white never covers black", () => {
  const a = new Uint8Array(4).fill(255); a[0] = 0;            // 4x1, dot at 0
  const b = new Uint8Array(8).fill(255); b[7] = 0;            // 4x2, dot at (3,1); row 0 white
  const pa = packRows(a, 4, 1, { x: 0, lead: 1, flipSheet: false });
  const pb = packRows(b, 4, 2, { x: 0, lead: 0, flipSheet: false });   // overlaps a's row
  const m = mergeRows([pa, pb]);
  assert.equal(m.height, 2);
  assert.equal(m.rows[208], 0x80 | 0x10);                     // both dots on row 1
  assert.equal(mergeRows([]).height, 0);
});
