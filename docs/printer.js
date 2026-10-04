// Web Bluetooth connection to the TP88 (works in Bluefy on iOS, Chrome on Mac/Android).
import { QUERY, parseStatus } from "./protocol.js";

// Full 128-bit UUIDs: some iOS Bluetooth browsers reject the short numeric form.
const SERVICE = "0000ff00-0000-1000-8000-00805f9b34fb";
const WRITE   = "0000ff02-0000-1000-8000-00805f9b34fb";
const NOTIFY  = "0000ff03-0000-1000-8000-00805f9b34fb";
const CREDIT_TIMEOUT_MS = 10000;

async function retry(fn, tries) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries) throw e; await new Promise(r => setTimeout(r, 400 * i)); }
  }
}

/** Find both characteristics, preferring one listing call over two lookups. */
async function openChannels(svc, at) {
  const want = { notify: NOTIFY, write: WRITE };
  const found = {};
  try {
    for (const c of await svc.getCharacteristics()) {
      for (const [k, uuid] of Object.entries(want)) if (String(c.uuid).toLowerCase() === uuid) found[k] = c;
    }
  } catch { /* fall back to direct lookups */ }
  for (const [k, uuid] of Object.entries(want)) {
    if (!found[k]) {
      at(k === "notify" ? "Opening reply channel…" : "Opening send channel…");
      found[k] = await svc.getCharacteristic(uuid);
    }
  }
  return found;
}

export class Printer extends EventTarget {
  device = null;
  #write = null;
  #credits = 0;
  #maxPayload = 20;            // until the printer tells us (02 LL HH)
  #creditWaiters = [];
  #busy = false;
  status = {};

  get connected() { return !!this.device?.gatt?.connected && !!this.#write; }
  get busy() { return this.#busy; }

  /** Must be called from a user tap (browser rule for Bluetooth). */
  async connect(onStep = () => {}) {
    if (!navigator.bluetooth) throw new Error("This browser can't use Bluetooth. On iPhone/iPad, open the app in Bluefy.");
    let step = "";
    const at = s => { step = s; onStep(s); };
    try {
      if (!this.device) {
        at("Choosing printer…");
        this.device = await navigator.bluetooth.requestDevice({
          filters: [{ name: "TP88" }, { namePrefix: "TP88" }],
          optionalServices: [SERVICE],
        });
        this.device.addEventListener("gattserverdisconnected", () => this.#onDisconnect());
      }
      let notify;
      for (let attempt = 1; ; attempt++) {
        try {
          at("Connecting…");
          const server = await retry(() => this.device.gatt.connect(), 3);
          at("Finding print service…");
          const svc = await server.getPrimaryService(SERVICE);
          at("Opening channels…");
          ({ notify, write: this.#write } = await openChannels(svc, at));
          break;
        } catch (err) {
          // iOS sometimes hands back stale handles after a retried connect: start clean once.
          if (attempt >= 2) throw err;
          this.device.gatt.disconnect();
          await new Promise(r => setTimeout(r, 800));
        }
      }
      this.#credits = 0;
      notify.addEventListener("characteristicvaluechanged", e => {
        const v = e.target.value;
        this.#onNotify(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
      at("Starting notifications…");
      await notify.startNotifications();
      this.#emit("connection");
      at("Reading status…");
      await this.refreshStatus();
      at("");
    } catch (err) {
      if (err?.name === "NotFoundError" && step === "Choosing printer…") throw err;   // user cancelled the picker
      const detail = [err?.name, err?.message, err?.code].filter(v => v != null && v !== "").join(": ") || String(err);
      const e = new Error(`${step.replace("…", "")} failed (${detail})`);
      e.name = "ConnectError";
      throw e;
    }
  }

  disconnect() { this.device?.gatt?.disconnect(); }

  async refreshStatus() {
    for (const q of [QUERY.battery, QUERY.paper, QUERY.cover]) await this.send(new Uint8Array(q));
  }

  /** Send bytes, chunked to the printer's payload size and paced by its credits. */
  async send(data, onProgress) {
    for (let i = 0; i < data.length; i += this.#maxPayload) {
      if (!this.connected) throw new Error("Printer disconnected");
      await this.#takeCredit();
      const chunk = data.subarray(i, i + this.#maxPayload);
      if (this.#write.writeValueWithoutResponse) await this.#write.writeValueWithoutResponse(chunk);
      else await this.#write.writeValue(chunk);
      onProgress?.(Math.min(1, (i + chunk.length) / data.length));
    }
  }

  async print(job, onProgress) {
    if (this.#busy) throw new Error("Already printing");
    this.#busy = true;
    try {
      const done = new Promise(res => this.addEventListener("jobdone", res, { once: true }));
      await this.send(job, onProgress);
      // Wait for the printer's "finished" message, but don't hang if it never comes.
      await Promise.race([done, new Promise(res => setTimeout(res, 20000))]);
    } finally {
      this.#busy = false;
      this.refreshStatus().catch(() => {});
    }
  }

  #takeCredit() {
    if (this.#credits > 0) { this.#credits--; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: setTimeout(() => {
        this.#creditWaiters = this.#creditWaiters.filter(x => x !== w);
        reject(new Error("Printer stopped responding"));
      }, CREDIT_TIMEOUT_MS) };
      this.#creditWaiters.push(w);
    });
  }

  #onNotify(b) {
    // One notification can carry several messages back to back (e.g. "1a 06 88 1a 06 88").
    let i = 0;
    while (i < b.length) {
      const t = b[i];
      if (t === 0x01) { this.#addCredits(b[i + 1]); i += 2; }
      else if (t === 0x02) { this.#maxPayload = b[i + 1] | (b[i + 2] << 8); i += 3; }
      else if (t === 0x1a) {
        const len = { 0x04: 3, 0x05: 3, 0x06: 3, 0x07: 5, 0x0f: 3 }[b[i + 1]] ?? (b.length - i);
        const s = parseStatus(b.subarray(i, i + len));
        if (s?.jobDone) this.#emit("jobdone");
        else if (s && !s.unknown) { Object.assign(this.status, s); this.#emit("status"); }
        i += len;
      } else break;
    }
  }

  #addCredits(n) {
    this.#credits += n;
    while (this.#credits > 0 && this.#creditWaiters.length) {
      const w = this.#creditWaiters.shift();
      clearTimeout(w.timer);
      this.#credits--;
      w.resolve();
    }
  }

  #onDisconnect() {
    this.#write = null;
    for (const w of this.#creditWaiters) { clearTimeout(w.timer); w.reject(new Error("Printer disconnected")); }
    this.#creditWaiters = [];
    this.#emit("connection");
  }

  #emit(type) { this.dispatchEvent(new Event(type)); }
}
