import { describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "../../app/api/library/route";

type FailurePoint = "mkdir" | "blob-write" | "index-write" | "publish" | "remove";
type Snapshot = { index: string | null; blobs: Record<string, string> };
type Event = { operation: "mkdir" | "write" | "rename" | "remove"; path: string; to?: string };
type Item = {
  id: string;
  createdAt: number;
  kind: string;
  name: string;
  mime: string;
  size: number;
  prompt?: string;
};

// Only the disk boundary is replaced. Requests, multipart parsing, route logic,
// locking, metadata and Response bodies all run through the production route.
const disk = vi.hoisted(() => {
  const state = {
    index: `${process.cwd()}/.library/index.json`,
    blobs: `${process.cwd()}/.library/blobs/`,
    files: new Map<string, Buffer>(),
    readError: undefined as Error | undefined,
    failure: undefined as { point: FailurePoint; remaining: number } | undefined,
    failedPath: undefined as string | undefined,
    trace: [] as Snapshot[],
    events: [] as Event[],
  };
  function ioError(code: string): Error {
    return Object.assign(new Error(`injected ${code}`), { code });
  }
  function snapshot(): Snapshot {
    return {
      index: state.files.get(state.index)?.toString("utf8") ?? null,
      blobs: Object.fromEntries(
        [...state.files.entries()]
          .filter(([file]) => file.startsWith(state.blobs))
          .map(([file, bytes]) => [file, bytes.toString("hex")]),
      ),
    };
  }
  function record(event: Event): void {
    state.events.push(event);
    state.trace.push(snapshot());
  }
  function fail(point: FailurePoint, file: string): void {
    if (state.failure?.point !== point) return;
    state.failure.remaining -= 1;
    if (state.failure.remaining === 0) {
      state.failedPath = file;
      throw ioError("EIO");
    }
  }
  const fs = {
    async readFile(file: string, encoding?: string) {
      if (file === state.index && state.readError) throw state.readError;
      const bytes = state.files.get(file);
      if (!bytes) throw ioError("ENOENT");
      return encoding === "utf8" ? bytes.toString("utf8") : Buffer.from(bytes);
    },
    async mkdir(file: string) {
      fail("mkdir", file);
      record({ operation: "mkdir", path: file });
    },
    async writeFile(file: string, data: string | Uint8Array) {
      const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      const point = file.startsWith(state.blobs) ? "blob-write" : "index-write";
      try {
        fail(point, file);
      } catch (error) {
        // A rejected write can already have truncated or partially written its
        // destination. Atomic publication must protect the old index anyway.
        state.files.set(file, bytes.subarray(0, 2));
        record({ operation: "write", path: file });
        throw error;
      }
      state.files.set(file, bytes);
      record({ operation: "write", path: file });
    },
    async rename(from: string, to: string) {
      fail("publish", to);
      const bytes = state.files.get(from);
      if (!bytes) throw ioError("ENOENT");
      state.files.set(to, bytes);
      state.files.delete(from);
      record({ operation: "rename", path: from, to });
    },
    async rm(file: string, options?: { force?: boolean }) {
      fail("remove", file);
      if (!state.files.has(file) && !options?.force) throw ioError("ENOENT");
      state.files.delete(file);
      record({ operation: "remove", path: file });
    },
  };
  return Object.assign(state, { snapshot, ioError, fs });
});

vi.mock("fs", () => ({ promises: disk.fs }));

const uploadBytes = new Uint8Array([0, 255, 13, 10, 42]);
const uploadMeta = {
  kind: "mesh",
  name: "target.stl",
  mime: "model/stl",
  prompt: "a replacement mesh",
};

function blobPath(id: string): string {
  return `${disk.blobs}${id}.bin`;
}

function oldBytes(id: string): Buffer {
  return Buffer.from(`original bytes for ${id}`);
}

function item(id: string, createdAt: number, kind = "mesh", name = `${id}.stl`): Item {
  return { id, createdAt, kind, name, mime: "model/stl", size: oldBytes(id).length };
}

function seed(items: Item[], index: string | null = JSON.stringify(items)): void {
  disk.files.clear();
  disk.readError = undefined;
  disk.failure = undefined;
  disk.failedPath = undefined;
  disk.events.length = 0;
  disk.trace.length = 0;
  if (index !== null) disk.files.set(disk.index, Buffer.from(index));
  for (const entry of items) disk.files.set(blobPath(entry.id), oldBytes(entry.id));
  disk.trace.push(disk.snapshot());
}

function list(): Promise<Response> {
  return GET(new Request("http://localhost/api/library"));
}

function save(name = uploadMeta.name): Promise<Response> {
  const form = new FormData();
  form.set("meta", JSON.stringify({ ...uploadMeta, name }));
  form.set("bytes", new Blob([uploadBytes], { type: "model/stl" }));
  return POST(new Request("http://localhost/api/library", { method: "POST", body: form }));
}

function remove(id: string): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
}

function clear(): Promise<Response> {
  return DELETE(new Request("http://localhost/api/library?all=1", { method: "DELETE" }));
}

type Outcome = { response: Response } | { error: unknown };
async function settle(promise: Promise<Response>): Promise<Outcome> {
  try {
    return { response: await promise };
  } catch (error) {
    return { error };
  }
}

function expectStorageFailure(outcome: Outcome): void {
  // Next turns a rejected route into a 500. An explicit 5xx is also valid;
  // a successful empty list or successful destructive mutation is not.
  if ("response" in outcome) {
    expect(outcome.response.status).toBeGreaterThanOrEqual(500);
    expect(outcome.response.status).toBeLessThan(600);
  } else {
    expect(outcome.error).toBeInstanceOf(Error);
  }
}

async function listedItems(): Promise<Item[]> {
  const response = await list();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["items"]);
  return body.items as Item[];
}

function expectEveryPublishedBlob(): void {
  // Each snapshot is also the persistent state if execution stops at that
  // boundary. Temp files and unlisted blobs are deliberately not required to
  // disappear, but every published entry must have its complete bytes.
  for (const state of disk.trace) {
    if (state.index === null) continue;
    const entries = JSON.parse(state.index) as Item[];
    for (const entry of entries) {
      expect(state.blobs[blobPath(entry.id)], `missing bytes for ${entry.id}`).toBeDefined();
      expect(state.blobs[blobPath(entry.id)]?.length).toBe(entry.size * 2);
    }
  }
}

function expectAtomicPublication(): void {
  expect(disk.events.filter((event) => event.operation === "write" && event.path === disk.index)).toEqual([]);
  expect(disk.events.filter((event) => event.operation === "rename" && event.to === disk.index)).toHaveLength(1);
}

function expectOldLibrary(before: Snapshot): void {
  const after = disk.snapshot();
  expect(after.index).toBe(before.index);
  for (const [file, bytes] of Object.entries(before.blobs)) {
    expect(after.blobs[file], `old blob changed: ${file}`).toBe(bytes);
  }
  expectEveryPublishedBlob();
}

type Operation = "list" | "save" | "remove" | "clear";
function perform(operation: Operation): Promise<Response> {
  if (operation === "list") return list();
  if (operation === "save") return save();
  if (operation === "remove") return remove("original");
  return clear();
}

async function checkReadFailures(operation: Operation): Promise<void> {
  // A genuinely missing index remains a supported empty-library case for all
  // four operations, including a first save and a no-op deletion.
  seed([], null);
  const missing = await perform(operation);
  expect(missing.status).toBe(200);
  if (operation === "list") expect(await missing.json()).toEqual({ items: [] });
  else if (operation === "save") {
    const body = await missing.json();
    expect(body).toEqual({ id: expect.stringMatching(/^[a-f0-9]{24}$/) });
    expect((await listedItems()).map((entry) => entry.id)).toEqual([body.id]);
  } else expect(await missing.json()).toEqual({ ok: true });

  for (const failure of ["EACCES", "EIO", "uncoded", "malformed-json"]) {
    const original = item("original", 1);
    seed([original], failure === "malformed-json" ? "[{broken JSON" : JSON.stringify([original]));
    if (failure !== "malformed-json") {
      disk.readError = failure === "uncoded" ? new Error("unclassified read failure") : disk.ioError(failure);
    }
    const before = disk.snapshot();
    expectStorageFailure(await settle(perform(operation)));
    expect(disk.snapshot()).toEqual(before);

    // Blob downloads still work independently of the index, with the same
    // content type and 404 response for missing blobs as before.
    const download = await GET(new Request("http://localhost/api/library?id=original"));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(oldBytes("original"));
    const absent = await GET(new Request("http://localhost/api/library?id=absent"));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "not found" });

    if (operation === "save") {
      // Restore external readability and verify that an earlier rejected write
      // has not poisoned the lock, and two queued saves cannot lose each other.
      seed([original]);
      const responses = await Promise.all([save("parallel-a.stl"), save("parallel-b.stl")]);
      for (const response of responses) expect(response.status).toBe(200);
      const entries = await listedItems();
      expect(entries.map((entry) => entry.name).sort()).toEqual(["original.stl", "parallel-a.stl", "parallel-b.stl"]);
      expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);
      expectEveryPublishedBlob();
    }
  }
}

type SaveMode = "replace" | "trim";
function prepareSave(mode: SaveMode): Item[] {
  const entries = mode === "replace"
    ? [
        item("replace-a", 10, "mesh", "target.stl"),
        item("same-name-other-kind", 40, "compiled", "target.stl"),
        item("replace-b", 30, "mesh", "target.stl"),
        item("same-kind-other-name", 20),
      ]
    : Array.from({ length: 60 }, (_, i) => item(`saved-${i}`, ((i + 30) % 60) + 1));
  seed(entries);
  return entries;
}

function survivors(entries: Item[]): Item[] {
  return entries
    .filter((entry) => entry.kind !== uploadMeta.kind || entry.name !== uploadMeta.name)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 59);
}

async function expectSavedLibrary(previous: Item[], id?: string): Promise<Item[]> {
  const entries = await listedItems();
  expect(entries.slice(1)).toEqual(survivors(previous));
  expect(entries[0]).toEqual({
    ...uploadMeta,
    id: id ?? expect.stringMatching(/^[a-f0-9]{24}$/),
    createdAt: expect.any(Number),
    size: uploadBytes.length,
  });
  expect(entries[0].createdAt).toBeGreaterThan(60);
  expect(previous.map((entry) => entry.id)).not.toContain(entries[0].id);
  const bytes = await GET(new Request(`http://localhost/api/library?id=${entries[0].id}`));
  expect(bytes.status).toBe(200);
  expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(uploadBytes);
  expectAtomicPublication();
  expectEveryPublishedBlob();
  return entries;
}

async function checkSuccessfulSave(mode: SaveMode): Promise<void> {
  const previous = prepareSave(mode);
  const response = await save();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ id: expect.stringMatching(/^[a-f0-9]{24}$/) });
  const entries = await expectSavedLibrary(previous, body.id);
  expect(entries).toHaveLength(mode === "trim" ? 60 : 3);
  const kept = new Set(entries.map((entry) => entry.id));
  for (const entry of previous) {
    expect(disk.files.has(blobPath(entry.id))).toBe(kept.has(entry.id));
  }
}

function prepareDelete(): Item[] {
  const entries = [item("first", 1), item("selected", 3), item("last", 2)];
  seed(entries);
  return entries;
}

function deleteOperation(all: boolean): Promise<Response> {
  return all ? clear() : remove("selected");
}

function afterDelete(entries: Item[], all: boolean): Item[] {
  return all ? [] : entries.filter((entry) => entry.id !== "selected").sort((a, b) => b.createdAt - a.createdAt);
}

describe("shared library index safety", () => {
  it("rejects unreadable and corrupt indexes when listing", async () => {
    await checkReadFailures("list");
  });

  it("rejects unreadable and corrupt indexes when saving and recovers the write lock", async () => {
    await checkReadFailures("save");
  });

  it("rejects unreadable and corrupt indexes when deleting one item", async () => {
    await checkReadFailures("remove");
  });

  it("rejects unreadable and corrupt indexes when deleting all items", async () => {
    await checkReadFailures("clear");
  });

  it("publishes an upsert before removing replaced blobs", async () => {
    await checkSuccessfulSave("replace");
  });

  it("publishes the capped newest-first library before removing trimmed blobs", async () => {
    await checkSuccessfulSave("trim");
  });

  it("preserves the old library when a save cannot publish", async () => {
    const points: FailurePoint[] = ["mkdir", "blob-write", "index-write", "publish"];
    for (const mode of ["replace", "trim"] as const) {
      for (const point of points) {
        prepareSave(mode);
        const before = disk.snapshot();
        disk.failure = { point, remaining: 1 };
        expectStorageFailure(await settle(save()));
        expectOldLibrary(before);
      }
    }
  });

  it("keeps the new index published when save cleanup fails", async () => {
    for (const [mode, removal] of [["replace", 1], ["replace", 2], ["trim", 1]] as const) {
      const previous = prepareSave(mode);
      disk.failure = { point: "remove", remaining: removal };
      expectStorageFailure(await settle(save()));
      const entries = await expectSavedLibrary(previous);
      expect(disk.failedPath).toBeDefined();
      expect(disk.files.has(disk.failedPath!)).toBe(true);
      expect(entries.map((entry) => blobPath(entry.id))).not.toContain(disk.failedPath);
    }
  });

  it("publishes deletions before removing any listed bytes", async () => {
    const initial = prepareDelete();
    const unknown = await remove("unknown");
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ ok: true });
    expect(await listedItems()).toEqual([...initial].sort((a, b) => b.createdAt - a.createdAt));
    for (const entry of initial) expect(disk.files.get(blobPath(entry.id))).toEqual(oldBytes(entry.id));

    for (const all of [false, true]) {
      const previous = prepareDelete();
      const response = await deleteOperation(all);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await listedItems()).toEqual(afterDelete(previous, all));
      for (const entry of previous) {
        expect(disk.files.has(blobPath(entry.id))).toBe(!all && entry.id !== "selected");
      }
      expectAtomicPublication();
      expectEveryPublishedBlob();
    }
  });

  it("preserves the old library when a deletion cannot publish", async () => {
    const points: FailurePoint[] = ["mkdir", "index-write", "publish"];
    for (const all of [false, true]) {
      for (const point of points) {
        prepareDelete();
        const before = disk.snapshot();
        disk.failure = { point, remaining: 1 };
        expectStorageFailure(await settle(deleteOperation(all)));
        expectOldLibrary(before);
      }
    }
  });

  it("keeps deletions published when cleanup fails partway through", async () => {
    for (const [all, removal] of [[false, 1], [true, 1], [true, 2]] as const) {
      const previous = prepareDelete();
      disk.failure = { point: "remove", remaining: removal };
      expectStorageFailure(await settle(deleteOperation(all)));
      const entries = await listedItems();
      expect(entries).toEqual(afterDelete(previous, all));
      expect(disk.failedPath).toBeDefined();
      expect(disk.files.has(disk.failedPath!)).toBe(true);
      expect(entries.map((entry) => blobPath(entry.id))).not.toContain(disk.failedPath);
      expectAtomicPublication();
      expectEveryPublishedBlob();
    }
  });
});
