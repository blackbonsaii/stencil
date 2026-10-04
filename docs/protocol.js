// TP88 command bytes. Pure functions, no browser APIs — see ../PROTOCOL.md.

export const DPI = 203;
export const WIDTH_BYTES = 208;            // 1664 dots per line
export const WIDTH_DOTS = WIDTH_BYTES * 8;
export const BAND_LINES = 255;             // max lines per GS v 0 band
export const FEED_LINES = 2;               // feed after a job
export const INTER_JOB_GAP_DOTS = 28;      // measured ~3.5 mm extra advance between jobs

export const QUERY = {
  battery: [0x1f, 0x11, 0x08],
  paper:   [0x1f, 0x11, 0x11],
  firmware:[0x1f, 0x11, 0x07],
  serial:  [0x1f, 0x11, 0x09],
  cover:   [0x1f, 0x11, 0x12],
};

/**
 * Build a full print job.
 * @param {Uint8Array} rows  packed 1-bit rows, WIDTH_BYTES per row, bit 1 = black, MSB = leftmost
 * @param {number} height    number of rows
 * @param {number} density   darkness 1..8
 */
export function buildJob(rows, height, density = 4) {
  if (rows.length !== height * WIDTH_BYTES) throw new Error("row data does not match height");
  density = Math.max(1, Math.min(8, Math.round(density)));
  const bands = Math.ceil(height / BAND_LINES);
  const out = new Uint8Array(2 + 7 + bands * 8 + rows.length + 3);
  let o = 0;
  const put = (...b) => { out.set(b, o); o += b.length; };
  put(0x1b, 0x40);                                   // ESC @
  put(0x1d, 0x28, 0x4b, 0x02, 0x00, 0x31, density);  // darkness
  for (let y = 0; y < height; y += BAND_LINES) {
    const n = Math.min(BAND_LINES, height - y);
    put(0x1d, 0x76, 0x30, 0x00,
        WIDTH_BYTES & 0xff, WIDTH_BYTES >> 8, n & 0xff, n >> 8);
    out.set(rows.subarray(y * WIDTH_BYTES, (y + n) * WIDTH_BYTES), o);
    o += n * WIDTH_BYTES;
  }
  put(0x1b, 0x64, FEED_LINES);
  return out;
}

/** Decode a `1a ..` status notification. Returns null for anything else. */
export function parseStatus(b) {
  if (b[0] !== 0x1a || b.length < 3) return null;
  switch (b[1]) {
    case 0x04: return { battery: b[2] };
    case 0x06: return { paper: (b[2] & 0x01) === 1 };
    case 0x05: return { coverClosed: b[2] === 0x98, coverRaw: b[2] };
    case 0x07: return { firmware: `${b[2]}.${b[3]}.${b[4]}` };
    case 0x08: return { serial: String.fromCharCode(...b.slice(2)) };
    case 0x0f: return { jobDone: true, raw: b[2] };
    default:   return { unknown: Array.from(b) };
  }
}

export const mmToDots = mm => Math.round(mm / 25.4 * DPI);
export const dotsToIn = d => d / DPI;
