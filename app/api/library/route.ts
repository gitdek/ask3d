import { promises as fs } from "fs";
import path from "path";

/**
 * Server-side shared library: one store on disk for every browser that
 * talks to this ask3d instance (Chrome, the embedded pane, a phone on the
 * LAN). Layout: .library/index.json holds the metadata list;
 * .library/blobs/<id>.bin holds the bytes. Single-user app — simple
 * whole-file writes are fine.
 */

export const runtime = "nodejs";

const LIB_DIR = path.join(process.cwd(), ".library");
const BLOB_DIR = path.join(LIB_DIR, "blobs");
const INDEX = path.join(LIB_DIR, "index.json");
const MAX_ITEMS = 60;

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

async function readIndex(): Promise<Meta[]> {
  try {
    return JSON.parse(await fs.readFile(INDEX, "utf8")) as Meta[];
  } catch {
    return [];
  }
}

async function writeIndex(items: Meta[]): Promise<void> {
  await fs.mkdir(BLOB_DIR, { recursive: true });
  await fs.writeFile(INDEX, JSON.stringify(items, null, 1));
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
  let meta: Omit<Meta, "id" | "createdAt" | "size">;
  try {
    meta = JSON.parse(String(form.get("meta")));
  } catch {
    return Response.json({ error: "bad meta" }, { status: 400 });
  }
  if (!meta.kind || !meta.name) return Response.json({ error: "meta needs kind and name" }, { status: 400 });
  const blob = form.get("bytes");
  if (!(blob instanceof Blob)) return Response.json({ error: "missing bytes" }, { status: 400 });
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length === 0) return Response.json({ error: "empty body" }, { status: 400 });
  if (bytes.length > 200 * 1024 * 1024) return Response.json({ error: "too large" }, { status: 413 });

  const items = await readIndex();
  // Upsert by (kind, name), then trim oldest beyond the cap.
  const replaced = items.filter((m) => m.kind === meta.kind && m.name === meta.name);
  for (const m of replaced) await fs.rm(blobPath(m.id), { force: true });
  let survivors = items.filter((m) => !(m.kind === meta.kind && m.name === meta.name));
  survivors.sort((a, b) => b.createdAt - a.createdAt);
  for (const m of survivors.slice(MAX_ITEMS - 1)) await fs.rm(blobPath(m.id), { force: true });
  survivors = survivors.slice(0, MAX_ITEMS - 1);

  const id = [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await fs.mkdir(BLOB_DIR, { recursive: true });
  await fs.writeFile(blobPath(id), bytes);
  const record: Meta = { ...meta, id, createdAt: Date.now(), size: bytes.length };
  await writeIndex([record, ...survivors]);
  return Response.json({ id });
}

export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const all = url.searchParams.get("all") === "1";
  const items = await readIndex();
  if (all) {
    for (const m of items) await fs.rm(blobPath(m.id), { force: true });
    await writeIndex([]);
    return Response.json({ ok: true });
  }
  if (!id) return Response.json({ error: "need id or all=1" }, { status: 400 });
  const keep = items.filter((m) => m.id !== id);
  if (keep.length !== items.length) await fs.rm(blobPath(id), { force: true });
  await writeIndex(keep);
  return Response.json({ ok: true });
}
