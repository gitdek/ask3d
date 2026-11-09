import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLocalLibrary, type HistoryMeta } from "../history";

const FLAG = "ask3d:library-migrated-v1";
const DB = "ask3d-history";
type ReadFault = "request" | "transaction" | "store" | "read";
type UploadFault = "http" | "network";
type Metadata = Omit<HistoryMeta, "id" | "createdAt" | "size">;

// These browser fakes expose asynchronous request events and transaction
// completion. Only external storage and HTTP are replaced, never history.ts.
class Events extends EventTarget {
  onsuccess: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onupgradeneeded: ((event: Event) => void) | null = null;
  oncomplete: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;

  emit(name: "success" | "error" | "upgradeneeded" | "complete" | "abort") {
    const event = new Event(name);
    this.dispatchEvent(event);
    this[`on${name}`]?.call(this, event);
  }
}

class RequestEvents<T> extends Events {
  result: T | undefined;
  error: DOMException | null = null;
  transaction: { abort: () => void } | null = null;
}

function item(id: string, createdAt = 1, extra: Partial<HistoryMeta> = {}): HistoryMeta {
  return {
    id, createdAt, kind: "mesh", name: `${id}.stl`, mime: "model/stl", size: 3,
    ...extra,
  };
}

function key(meta: Pick<HistoryMeta, "kind" | "name">): string {
  return `${meta.kind}|${meta.name}`;
}

function fixture(local: HistoryMeta[], shared: HistoryMeta[] = []) {
  const original = local.map((m) => ({ ...m }));
  const localItems = local.map((m) => ({ ...m }));
  const blobs = new Map<string, ArrayBuffer | undefined>(
    local.map((m) => [m.id, new Uint8Array([3, 1, 4]).buffer]),
  );
  const remote = new Map(shared.map((m) => [key(m), { ...m }]));
  const values = new Map<string, string>();
  const posts: { meta: Metadata; bytes: number[] }[] = [];
  const reads: string[] = [];
  const connections: { close: ReturnType<typeof vi.fn> }[] = [];
  const state = {
    exists: true,
    openError: false,
    storageError: false,
    metaFault: undefined as ReadFault | undefined,
    blobFault: undefined as ReadFault | "missing" | undefined,
    blobID: "",
    uploadFault: undefined as UploadFault | undefined,
    uploadName: "",
    listError: false,
  };
  const storage = {
    getItem: vi.fn((name: string) => {
      if (state.storageError) throw new Error("localStorage is unavailable");
      return values.get(name) ?? null;
    }),
    setItem: vi.fn((name: string, value: string) => { values.set(name, value); }),
    removeItem: vi.fn((name: string) => { values.delete(name); }),
  };
  const abortCreation = vi.fn();
  const open = vi.fn((name: string, version?: number) => {
    if (name !== DB || (version !== undefined && version !== 1)) {
      throw new Error("unexpected legacy database");
    }
    const request = new RequestEvents<unknown>();
    const connection = {
      close: vi.fn(),
      transaction: (store: string, mode: string = "readonly") => {
        if (!["meta", "blobs"].includes(store) || mode !== "readonly") {
          throw new Error("migration must only read the legacy stores");
        }
        const fault = store === "meta" ? state.metaFault : state.blobFault;
        if (fault === "transaction") throw new Error("transaction unavailable");
        const tx = Object.assign(new Events(), {
          error: null as DOMException | null,
          objectStore: (storeName: string) => {
            if (storeName !== store) throw new Error("unexpected object store");
            if (fault === "store") throw new Error("object store unavailable");
            function read(id?: string) {
              if (id !== undefined) reads.push(id);
              const applies = store === "meta" || id === state.blobID;
              if (applies && fault === "read") throw new Error("read unavailable");
              const req = new RequestEvents<unknown>();
              queueMicrotask(() => {
                if (applies && fault === "request") {
                  req.error = new DOMException("read failed", "UnknownError");
                  req.emit("error");
                  tx.error = req.error;
                  tx.emit("error");
                  queueMicrotask(() => tx.emit("abort"));
                  return;
                }
                req.result = store === "meta"
                  ? localItems.map((m) => ({ ...m }))
                  : applies && fault === "missing" ? undefined : blobs.get(id!);
                req.emit("success");
                queueMicrotask(() => tx.emit("complete"));
              });
              return req;
            }
            return { getAll: () => read(), get: (id: string) => read(id) };
          },
        });
        return tx;
      },
    };
    request.transaction = {
      abort: () => {
        abortCreation();
        queueMicrotask(() => {
          request.error = new DOMException("creation aborted", "AbortError");
          request.emit("error");
        });
      },
    };
    queueMicrotask(() => {
      if (state.openError) {
        request.error = new DOMException("open failed", "UnknownError");
        request.emit("error");
      } else if (!state.exists) {
        request.result = connection;
        request.emit("upgradeneeded");
      } else {
        connections.push(connection);
        request.result = connection;
        request.emit("success");
      }
    });
    return request;
  });
  const deleteDatabase = vi.fn((name: string) => {
    if (name !== DB) throw new Error("unexpected deletion target");
    localItems.splice(0);
    blobs.clear();
    const request = new RequestEvents<undefined>();
    queueMicrotask(() => request.emit("success"));
    return request;
  });
  const http = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== "/api/library") throw new Error("unexpected HTTP endpoint");
    if (!init?.method || init.method === "GET") {
      if (state.listError) return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ items: [...remote.values()] });
    }
    if (init.method !== "POST" || !(init.body instanceof FormData)) {
      throw new Error("expected a multipart upload");
    }
    const meta = JSON.parse(String(init.body.get("meta"))) as Metadata;
    const blob = init.body.get("bytes");
    if (!(blob instanceof Blob)) throw new Error("upload is missing bytes");
    const bytes = [...new Uint8Array(await blob.arrayBuffer())];
    posts.push({ meta, bytes });
    if (meta.name === state.uploadName && state.uploadFault) {
      if (state.uploadFault === "network") throw new TypeError("network unavailable");
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    remote.set(key(meta), { ...meta, id: `server-${posts.length}`, createdAt: 100, size: bytes.length });
    return Response.json({ id: `server-${posts.length}` });
  });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("indexedDB", { open, deleteDatabase });
  vi.stubGlobal("fetch", http);
  return {
    state, original, localItems, blobs, remote, values, storage, posts, reads,
    connections, open, deleteDatabase, abortCreation, http,
  };
}

type Fixture = ReturnType<typeof fixture>;

function expectRetained(f: Fixture) {
  expect(f.values.has(FLAG), "failed migration must remain retryable").toBe(false);
  expect(f.storage.setItem).not.toHaveBeenCalled();
  expect(f.deleteDatabase).not.toHaveBeenCalled();
  expect(f.localItems).toEqual(f.original);
  expect(f.blobs.size).toBe(f.original.length);
  for (const connection of f.connections) expect(connection.close).toHaveBeenCalled();
}

function expectComplete(f: Fixture) {
  expect(f.values.get(FLAG)).toBe("1");
  expect(f.deleteDatabase).toHaveBeenCalledTimes(1);
  expect(f.deleteDatabase).toHaveBeenCalledWith(DB);
  expect(f.localItems).toEqual([]);
  for (const meta of f.original) expect(f.remote.has(key(meta))).toBe(true);
  for (const connection of f.connections) expect(connection.close).toHaveBeenCalled();
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local library migration", () => {
  it("distinguishes an open error from an absent library and retries", async () => {
    const unreadable = fixture([item("private")]);
    unreadable.state.storageError = true;
    await migrateLocalLibrary();
    expectRetained(unreadable);
    expect(unreadable.open).not.toHaveBeenCalled();
    expect(unreadable.http).not.toHaveBeenCalled();

    const absent = fixture([]);
    absent.state.exists = false;
    await migrateLocalLibrary();
    expect(absent.abortCreation).toHaveBeenCalledTimes(1);
    expect(absent.values.get(FLAG)).toBe("1");
    expect(absent.http).not.toHaveBeenCalled();
    expect(absent.deleteDatabase).not.toHaveBeenCalled();

    const f = fixture([item("saved")]);
    f.state.openError = true;
    await migrateLocalLibrary();
    expectRetained(f);
    expect(f.http).not.toHaveBeenCalled();
    f.state.openError = false;
    await migrateLocalLibrary();
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.posts.map((p) => p.meta.name)).toEqual(["saved.stl"]);
    expectComplete(f);
    const requests = f.http.mock.calls.length;
    await migrateLocalLibrary();
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.http).toHaveBeenCalledTimes(requests);
    expect(f.deleteDatabase).toHaveBeenCalledTimes(1);
  });

  it.each(["request", "transaction", "store", "read"] as const)(
    "retries metadata read failures (%s)", async (fault) => {
      const f = fixture([item("saved")]);
      f.state.metaFault = fault;
      await migrateLocalLibrary();
      expectRetained(f);
      expect(f.posts).toEqual([]);
      f.state.metaFault = undefined;
      await migrateLocalLibrary();
      expect(f.open).toHaveBeenCalledTimes(2);
      expect(f.posts.map((p) => p.meta.name)).toEqual(["saved.stl"]);
      expectComplete(f);

      // An actually empty legacy database is a successful migration.
      const empty = fixture([]);
      await migrateLocalLibrary();
      expect(empty.posts).toEqual([]);
      expectComplete(empty);
    },
  );

  it.each(["missing", "request", "transaction", "store", "read"] as const)(
    "retries byte read failures without repeating successful uploads (%s)", async (fault) => {
      const first = item("first", 1);
      const second = item("second", 2, {
        kind: "compiled", prompt: "make a hook", scad: "cube(3);",
        dims: { x: 3, y: 3, z: 3 }, note: "saved design",
      });
      const existing = item("existing", 3);
      const f = fixture([existing, second, first], [
        { ...existing, id: "remote-copy" },
        item("other-kind", 4, { kind: "image", name: second.name }),
      ]);
      // This matching shared item needs no readable local blob.
      f.blobs.set(existing.id, undefined);
      f.state.blobID = second.id;
      f.state.blobFault = fault;
      // Transaction/store failures precede get(id), so they apply to every
      // blob transaction; the other faults target only the second item.
      await migrateLocalLibrary();
      expectRetained(f);
      const successfulBefore = f.posts.map((p) => p.meta.name);
      f.state.blobFault = undefined;
      await migrateLocalLibrary();
      expectComplete(f);
      expect(f.open).toHaveBeenCalledTimes(2);
      expect(f.posts.map((p) => p.meta.name)).toEqual([first.name, second.name]);
      for (const name of successfulBefore) {
        expect(f.posts.filter((p) => p.meta.name === name)).toHaveLength(1);
      }
      expect(f.reads).not.toContain(existing.id);
      expect(f.remote.has(key({ kind: "image", name: second.name }))).toBe(true);
      expect(f.posts[1]).toEqual({
        meta: {
          kind: second.kind, name: second.name, mime: second.mime,
          prompt: second.prompt, scad: second.scad, dims: second.dims, note: second.note,
        },
        bytes: [3, 1, 4],
      });
    },
  );

  it.each(["http", "network"] as const)(
    "retries partial uploads and a failed shared listing (%s)", async (fault) => {
      const first = item("first", 1);
      const second = item("second", 2, { kind: "image", thumb: "data:image/jpeg;base64,AQID" });
      const f = fixture([second, first]);
      f.state.uploadName = second.name;
      f.state.uploadFault = fault;
      await migrateLocalLibrary();
      expectRetained(f);
      expect(f.posts.map((p) => p.meta.name)).toEqual([first.name, second.name]);
      expect(f.remote.has(key(first))).toBe(true);
      expect(f.remote.has(key(second))).toBe(false);

      f.state.uploadFault = undefined;
      f.state.listError = true;
      await migrateLocalLibrary();
      expectRetained(f);
      expect(f.posts).toHaveLength(2);

      f.state.listError = false;
      await migrateLocalLibrary();
      expectComplete(f);
      expect(f.open).toHaveBeenCalledTimes(3);
      expect(f.posts.map((p) => p.meta.name)).toEqual([first.name, second.name, second.name]);
      expect(f.posts[2]).toEqual({
        meta: { kind: second.kind, name: second.name, mime: second.mime, thumb: second.thumb },
        bytes: [3, 1, 4],
      });
    },
  );
});
