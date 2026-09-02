import { promises as fs } from "fs";
import path from "path";

/**
 * Server-side shared library: one store on disk for every browser that
 * talks to this ask3d instance (Chrome, the embedded pane, a phone on the
 * LAN). Layout: .library/index.json holds the metadata list;
 * .library/blobs/<id>.bin holds the bytes. Single-user app, but two
 * browsers do save at the same moment (a statue landing while a compile
 * captures), so index writes are serialized and atomic.
 */

export const runtime = "nodejs";

const LIB_DIR = path.join(process.cwd(), ".library");
const BLOB_DIR = path.join(LIB_DIR, "blobs");
const INDEX = path.join(LIB_DIR, "index.json");
const MAX_ITEMS = 60;
const MAX_BLOB_BYTES = 200 * 1024 * 1024;

const KINDS = new Set(["image", "mesh", "scad", "statue", "compiled"]);
const LIMITS = {
  name: 200,
  mime: 100,
  thumb: 64 * 1024,
  prompt: 8000,
  note: 2000,
  scad: 256 * 1024,
};

interface Meta {
  id: string;
  createdAt: number;
  kind: string;
  name: string;
  mime: string;
  size: number;
  thumb?: string;
  dims?: { x: number; y: number; z: number };
  prompt?: string;
  scad?: string;
  note?: string;
}

type IncomingMeta = Omit<Meta, "id" | "createdAt" | "size">;

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/** Whitelist the client-supplied metadata: known keys, bounded sizes, sane types. */
function sanitizeMeta(raw: unknown): IncomingMeta | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = str(r.kind, 20);
  const name = str(r.name, LIMITS.name)?.trim();
  if (!kind || !KINDS.has(kind) || !name) return null;
  const meta: IncomingMeta = { kind, name, mime: str(r.mime, LIMITS.mime) ?? "" };
  const thumb = str(r.thumb, LIMITS.thumb);
  if (thumb?.startsWith("data:image/")) meta.thumb = thumb;
  const prompt = str(r.prompt, LIMITS.prompt);
  if (prompt) meta.prompt = prompt;
  const note = str(r.note, LIMITS.note);
  if (note) meta.note = note;
  const scad = str(r.scad, LIMITS.scad);
  if (scad) meta.scad = scad;
  if (r.dims && typeof r.dims === "object") {
    const d = r.dims as Record<string, unknown>;
    const [x, y, z] = [d.x, d.y, d.z];
    if ([x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) {
      meta.dims = { x: x as number, y: y as number, z: z as number };
    }
  }
  return meta;
}

// Read-modify-write of the index runs one at a time; a concurrent save
// used to overwrite the other's record and orphan its blob.
let indexChain: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexChain.then(fn, fn);
  indexChain = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<Meta[]> {
  try {
    return JSON.parse(await fs.readFile(INDEX, "utf8")) as Meta[];
  } catch {
    return [];
  }
}

async function writeIndex(items: Meta[]): Promise<void> {
  await fs.mkdir(BLOB_DIR, { recursive: true });
  // Write-then-rename: a reader never sees a half-written index.
  const tmp = `${INDEX}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(items, null, 1));
  await fs.rename(tmp, INDEX);
}

function blobPath(id: string): string {
  // ids are generated server-side (hex) — refuse anything path-like.
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("bad id");
  return path.join(BLOB_DIR, `${id}.bin`);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    try {
      const bytes = await fs.readFile(blobPath(id));
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch {
      return Response.json({ error: "not found" }, { status: 404 });
    }
  }
  const items = await readIndex();
  items.sort((a, b) => b.createdAt - a.createdAt);
  return Response.json({ items });
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return Response.json({ error: "expected multipart form data" }, { status: 400 });
  let rawMeta: unknown;
  try {
    rawMeta = JSON.parse(String(form.get("meta")));
  } catch {
    return Response.json({ error: "bad meta" }, { status: 400 });
  }
  const meta = sanitizeMeta(rawMeta);
  if (!meta) return Response.json({ error: "meta needs a known kind and a name" }, { status: 400 });
  const blob = form.get("bytes");
  if (!(blob instanceof Blob)) return Response.json({ error: "missing bytes" }, { status: 400 });
  if (blob.size > MAX_BLOB_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length === 0) return Response.json({ error: "empty body" }, { status: 400 });

  const id = await withIndexLock(async () => {
    const items = await readIndex();
    // Upsert by (kind, name), then trim oldest beyond the cap.
    const same = (m: Meta) => m.kind === meta.kind && m.name === meta.name;
    for (const m of items.filter(same)) await fs.rm(blobPath(m.id), { force: true });
    let survivors = items.filter((m) => !same(m));
    survivors.sort((a, b) => b.createdAt - a.createdAt);
    for (const m of survivors.slice(MAX_ITEMS - 1)) await fs.rm(blobPath(m.id), { force: true });
    survivors = survivors.slice(0, MAX_ITEMS - 1);

    const newId = [...crypto.getRandomValues(new Uint8Array(12))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await fs.mkdir(BLOB_DIR, { recursive: true });
    await fs.writeFile(blobPath(newId), bytes);
    const record: Meta = { ...meta, id: newId, createdAt: Date.now(), size: bytes.length };
    await writeIndex([record, ...survivors]);
    return newId;
  });
  return Response.json({ id });
}

export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const all = url.searchParams.get("all") === "1";
  if (!all && !id) return Response.json({ error: "need id or all=1" }, { status: 400 });
  await withIndexLock(async () => {
    const items = await readIndex();
    if (all) {
      for (const m of items) await fs.rm(blobPath(m.id), { force: true });
      await writeIndex([]);
      return;
    }
    const keep = items.filter((m) => m.id !== id);
    if (keep.length !== items.length) await fs.rm(blobPath(id!), { force: true });
    await writeIndex(keep);
  });
  return Response.json({ ok: true });
}
