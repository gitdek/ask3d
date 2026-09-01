/**
 * Shared library client. The store lives on the ask3d server's disk
 * (.library/, served by /api/library), so every browser pointed at this
 * instance sees the same items — your desktop Chrome, the embedded pane,
 * a laptop on the LAN. Formerly this was per-browser IndexedDB; a one-time
 * migration pushes any old local items up to the server.
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

export async function listHistory(): Promise<HistoryMeta[]> {
  const res = await fetch("/api/library");
  if (!res.ok) throw new Error(`library list failed (${res.status})`);
  return ((await res.json()) as { items: HistoryMeta[] }).items;
}

export async function saveHistoryItem(
  item: Omit<HistoryMeta, "id" | "createdAt" | "size">,
  bytes: ArrayBuffer,
): Promise<void> {
  const form = new FormData();
  form.append("meta", JSON.stringify(item));
  form.append("bytes", new Blob([bytes]));
  const res = await fetch("/api/library", { method: "POST", body: form });
  if (!res.ok) throw new Error(`library save failed (${res.status})`);
}

export async function getHistoryBytes(id: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`/api/library?id=${encodeURIComponent(id)}`);
  return res.ok ? res.arrayBuffer() : null;
}

export async function deleteHistoryItem(id: string): Promise<void> {
  await fetch(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function clearHistory(): Promise<void> {
  await fetch("/api/library?all=1", { method: "DELETE" });
}

/**
 * One-time migration of the old per-browser IndexedDB library into the
 * shared server store. Safe to call every startup: a localStorage flag
 * skips it after the first success, and server-side upsert by (kind, name)
 * makes re-runs harmless anyway.
 */
export async function migrateLocalLibrary(): Promise<void> {
  const FLAG = "ask3d:library-migrated-v1";
  try {
    if (localStorage.getItem(FLAG)) return;
  } catch {
    return; // no localStorage → nothing local to migrate either
  }
  try {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open("ask3d-history", 1);
      req.onupgradeneeded = () => {
        // DB didn't exist before — abort so we don't create an empty one.
        req.transaction?.abort();
        resolve(null);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!db) {
      localStorage.setItem(FLAG, "1");
      return;
    }
    const items: HistoryMeta[] = await new Promise((resolve) => {
      try {
        const tx = db.transaction("meta", "readonly");
        const req = tx.objectStore("meta").getAll();
        req.onsuccess = () => resolve(req.result as HistoryMeta[]);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    const existing = new Set((await listHistory()).map((m) => `${m.kind}|${m.name}`));
    items.sort((a, b) => a.createdAt - b.createdAt); // oldest first keeps order
    for (const m of items) {
      if (existing.has(`${m.kind}|${m.name}`)) continue;
      const bytes: ArrayBuffer | null = await new Promise((resolve) => {
        try {
          const tx = db.transaction("blobs", "readonly");
          const req = tx.objectStore("blobs").get(m.id);
          req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (!bytes) continue;
      const { id: _id, createdAt: _c, size: _s, ...meta } = m;
      await saveHistoryItem(meta, bytes).catch(() => {});
    }
    db.close();
    localStorage.setItem(FLAG, "1");
    if (items.length > 0) console.info(`[library] migrated ${items.length} local items to the shared library`);
  } catch (error) {
    console.warn("[library] migration failed (will retry next load):", error);
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
