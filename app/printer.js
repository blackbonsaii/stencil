// Web Bluetooth connection to the TP88 (works in Bluefy on iOS, Chrome on Mac/Android).
import { QUERY, parseStatus } from "./protocol.js";

const SERVICE = 0xff00;
const WRITE = 0xff02;
const NOTIFY = 0xff03;
const CREDIT_TIMEOUT_MS = 10000;

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
  async connect() {
    if (!navigator.bluetooth) throw new Error("This browser can't use Bluetooth. On iPhone/iPad, open the app in Bluefy.");
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ name: "TP88" }, { services: [SERVICE] }],
        optionalServices: [SERVICE],
      });
      this.device.addEventListener("gattserverdisconnected", () => this.#onDisconnect());
    }
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    const notify = await svc.getCharacteristic(NOTIFY);
    this.#write = await svc.getCharacteristic(WRITE);
    this.#credits = 0;
    notify.addEventListener("characteristicvaluechanged", e => this.#onNotify(new Uint8Array(e.target.value.buffer)));
    await notify.startNotifications();
    this.#emit("connection");
    await this.refreshStatus();
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
