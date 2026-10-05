// Recent designs, kept on this device (IndexedDB) so a design can be reprinted without going
// back to the camera roll. Each record remembers the size it was last printed at.
const DB = "stencil", STORE = "designs", KEEP = 20;

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function run(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode), st = tx.objectStore(STORE);
    const req = fn(st);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/**
 * @typedef {{id: string, name: string, thumb: string, widthIn: number, usedAt: number, blob?: Blob}} Recent
 */
// The image is stored as raw PNG bytes: WebKit can refuse to store Blobs in IndexedDB
// (private browsing and some embedded browsers), but bytes always work.

/** Newest first, without the image data. @returns {Promise<Recent[]>} */
export async function listRecent() {
  const all = await run("readonly", st => st.getAll());
  return all.sort((a, b) => b.usedAt - a.usedAt).map(({ png, ...r }) => r);
}

/** @returns {Promise<Recent|undefined>} */
export async function getRecent(id) {
  const r = await run("readonly", st => st.get(id));
  if (!r) return r;
  const { png, ...rest } = r;
  return { ...rest, blob: new Blob([png], { type: "image/png" }) };
}

/**
 * Record that a design was printed at `widthIn`. `makeBlob`/`thumb` are only used the first
 * time a design is stored. Keeps the newest KEEP designs.
 */
export async function touchRecent({ id, name, widthIn, thumb, makeBlob }) {
  const old = await run("readonly", st => st.get(id));
  const png = old?.png ?? await (await makeBlob()).arrayBuffer();
  await run("readwrite", st => st.put({ id, name, thumb: old?.thumb ?? thumb, widthIn, usedAt: Date.now(), png }));
  const all = await listRecent();
  for (const r of all.slice(KEEP)) await removeRecent(r.id);
}

export const removeRecent = id => run("readwrite", st => st.delete(id));
