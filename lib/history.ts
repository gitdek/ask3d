/**
 * Browser-persistent history of uploads and generated models (IndexedDB).
 *
 * Two stores: `meta` (small records the panel lists — name, kind, dims,
 * thumbnail) and `blobs` (the actual bytes, loaded only on restore).
 * Entries upsert by (kind, name): re-attaching or regenerating something
 * replaces its previous entry instead of accumulating duplicates.
 */

export type HistoryKind = "image" | "mesh" | "scad" | "statue" | "compiled";

export interface HistoryMeta {
  id: string;
  createdAt: number;
  kind: HistoryKind;
  name: string;
  mime: string;
  size: number;
  /** Small data-URL preview (images only). */
  thumb?: string;
  /** Printer-mm dimensions (models only). */
  dims?: { x: number; y: number; z: number };
  /** The chat request that produced this model (compiled only). */
  prompt?: string;
  /** The OpenSCAD source that compiled to this model (compiled only). */
  scad?: string;
  /** Generation provenance, e.g. "local · seed 98590 · octree 1024" (statues). */
  note?: string;
}

const DB_NAME = "ask3d-history";
const DB_VERSION = 1;
const MAX_ITEMS = 40;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("could not open history DB"));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("history transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("history transaction aborted"));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("history request failed"));
  });
}

export async function listHistory(): Promise<HistoryMeta[]> {
  const db = await openDb();
  try {
    const tx = db.transaction("meta", "readonly");
    const all = await reqResult(tx.objectStore("meta").getAll() as IDBRequest<HistoryMeta[]>);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

function newId(): string {
  // crypto.randomUUID is secure-context-only — absent when the dev server
  // is opened over LAN HTTP (e.g. from a phone).
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function saveOnce(
  item: Omit<HistoryMeta, "id" | "createdAt" | "size">,
  bytes: ArrayBuffer,
  keepNewest: number,
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(["meta", "blobs"], "readwrite");
    const meta = tx.objectStore("meta");
    const blobs = tx.objectStore("blobs");
    const existing = await reqResult(meta.getAll() as IDBRequest<HistoryMeta[]>);
    // Upsert by (kind, name); then evict oldest beyond the cap.
    for (const m of existing.filter((m) => m.kind === item.kind && m.name === item.name)) {
      meta.delete(m.id);
      blobs.delete(m.id);
    }
    const survivors = existing
      .filter((m) => !(m.kind === item.kind && m.name === item.name))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const m of survivors.slice(keepNewest - 1)) {
      meta.delete(m.id);
      blobs.delete(m.id);
    }
    const id = newId();
    meta.put({ ...item, id, createdAt: Date.now(), size: bytes.byteLength });
    blobs.put(bytes, id);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function saveHistoryItem(
  item: Omit<HistoryMeta, "id" | "createdAt" | "size">,
  bytes: ArrayBuffer,
): Promise<void> {
  try {
    await saveOnce(item, bytes, MAX_ITEMS);
  } catch (error) {
    // A quota-aborted transaction rolls back its own evictions, so a full
    // origin would otherwise fail every future save. Retry once keeping
    // only half the items — the eviction commits with the new entry.
    if ((error as DOMException)?.name === "QuotaExceededError" || (error as Error)?.message?.includes("Quota")) {
      await saveOnce(item, bytes, Math.floor(MAX_ITEMS / 2));
    } else {
      throw error;
    }
  }
}

export async function getHistoryBytes(id: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  try {
    const tx = db.transaction("blobs", "readonly");
    const bytes = await reqResult(tx.objectStore("blobs").get(id) as IDBRequest<ArrayBuffer>);
    return bytes ?? null;
  } finally {
    db.close();
  }
}

export async function deleteHistoryItem(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(["meta", "blobs"], "readwrite");
    tx.objectStore("meta").delete(id);
    tx.objectStore("blobs").delete(id);
    await txDone(tx);
  } finally {
    db.close();
  }
}

export async function clearHistory(): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(["meta", "blobs"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("blobs").clear();
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** ~96px JPEG data-URL for image cards; null when decoding fails (HEIC etc.). */
export async function makeImageThumb(file: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = 96 / Math.max(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}
