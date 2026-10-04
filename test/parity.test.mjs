// Checks the browser code produces byte-identical jobs to the Python driver that printed correctly.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJob, parseStatus, WIDTH_BYTES } from "../app/protocol.js";
import { packRows, toGray, inkBounds } from "../app/raster.js";

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
  let r = packRows(g, 8, 1, { x: 9 }).rows;                    // dot at 9
  assert.equal(r[1], 0x40);
  r = packRows(g, 8, 1, { x: 9, mirror: true }).rows;          // dot at 16
  assert.equal(r[2], 0x80);
  r = packRows(g, 8, 1, { x: 1660 }).rows;                     // overhang right: dot 1660 kept
  assert.equal(r[207], 0x08);
  r = packRows(g, 8, 1, { x: -3, mirror: true }).rows;         // overhang left, mirrored dot at 4
  assert.equal(r[0], 0x08);
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
