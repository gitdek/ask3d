import { writeFile } from "node:fs/promises";
import { migrateLocalLibrary, type HistoryMeta } from "../../lib/history.ts";

// This is an event observer, not an implementation of the migration. The real
// function owns the loop, duplicate checks, catches, marker, and deletion.
// Synchronous calls can emit several observations in one JS turn; we buffer
// those snapshots so each trace edge still denotes one observed model action.
// No source rewriting, real clock, network, or additional dependencies are used.
const FLAG = "ask3d:library-migrated-v1";
const DATABASE = "ask3d-history";
const MAX_LOADS = 2;

function numberEnv(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${name}`);
  return n;
}

class Random {
  private value = 2166136261;
  constructor(seed: string) {
    for (const c of seed) this.value = Math.imul(this.value ^ c.charCodeAt(0), 16777619);
    this.value = this.value >>> 0 || 1;
  }
  next(): number {
    let n = this.value;
    n ^= n << 13;
    n ^= n >>> 17;
    n ^= n << 5;
    return this.value = n >>> 0;
  }
  pick<T>(xs: readonly T[]): T { return xs[this.next() % xs.length]; }
}

type Counts = { upload: number; mark: number; delete: number };
type Phase = "idle" | "flag" | "open" | "metadata" | "list" | "scan" |
  "read" | "upload" | "mark" | "markEmpty" | "delete" | "return";
type JSONValue = string | number | boolean | { [key: string]: JSONValue | JSONValue[] };
const set = (xs: JSONValue[]): JSONValue => ({ $set: xs });
const tuple = (xs: JSONValue[]): JSONValue => ({ $seq: xs });
const key = (m: Pick<HistoryMeta, "kind" | "name">) => `${m.kind}|${m.name}`;
const zero = (): Counts => ({ upload: 0, mark: 0, delete: 0 });

type Request = {
  result?: unknown;
  onsuccess?: () => void;
  onerror?: () => void;
  onupgradeneeded?: () => void;
  transaction?: { abort(): void };
};

class Browser {
  readonly random: Random;
  readonly storageReadable: boolean;
  readonly databaseExisted: boolean;
  readonly meta = new Map<string, HistoryMeta>();
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly server = new Map<string, HistoryMeta>();
  readonly localStorage = new Map<string, string>();
  // Deletion completion is deliberately pending (e.g. another open connection).
  // The spec observes invocation, and retains the original rows/DB existence.
  readonly deletes: string[] = [];
  readonly markerAttempts: { name: string; value: string }[] = [];
  readonly uploadAttempts: { meta: HistoryMeta; bytes: Blob }[] = [];
  readonly pending: (() => void)[] = [];
  readonly observations: { state: JSONValue; event: string }[] = [];
  readonly itemNumbers = new Map<string, number>();
  readonly unreadable = new Set<number>();
  readonly failed = new Set<number>();
  readonly retryItems = new Set<number>();
  readonly todo = new Set<number>();
  readonly seen = new Set<string>();
  phase: Phase = "idle";
  loads = 0;
  metadataOK = true;
  entryDone = false;
  entryWrites = zero();
  active = false;
  fatal: unknown;
  private markerSucceeded = false;

  constructor(random: Random) {
    this.random = random;
    this.storageReadable = random.pick([true, true, true, true, true, true, true, false]);
    this.databaseExisted = random.pick([true, true, true, true, true, true, true, false]);
    if (this.databaseExisted && random.pick([true, true, true, true, true, true, false])) {
      const m: HistoryMeta = {
        id: "local-1", createdAt: 1, kind: "image", name: "part",
        mime: "application/octet-stream", size: 3,
      };
      this.meta.set(m.id, m);
      this.itemNumbers.set(m.id, 1);
      this.blobs.set(m.id, Uint8Array.of(1, 2, 3).buffer);
      if (random.pick([false, false, false, true])) this.server.set(key(m), { ...m, id: "server-1" });
    }
    // Exercise both near misses. They must not be mistaken for an exact copy.
    for (const [kind, name] of [["mesh", "part"], ["image", "other"]] as const) {
      if (random.pick([true, false])) {
        const m: HistoryMeta = { id: `server-${kind}-${name}`, kind, name,
          createdAt: 0, mime: "application/octet-stream", size: 3 };
        this.server.set(key(m), m);
      }
    }
  }

  counts(): Counts {
    return { upload: this.uploadAttempts.length, mark: this.markerAttempts.length, delete: this.deletes.length };
  }

  observe(event: string): void { this.observations.push({ state: abstract(this), event }); }

  install(): void {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (name: string) => {
        if (name !== FLAG) throw new Error(`Unexpected storage key ${name}`);
        const value = this.localStorage.get(name) ?? null;
        this.phase = !this.storageReadable || value ? "return" : "open";
        this.observe("ReadFlag");
        if (!this.storageReadable) throw new Error("localStorage unavailable");
        return value;
      },
      setItem: (name: string, value: string) => {
        if (name !== FLAG) throw new Error(`Unexpected storage key ${name}`);
        // Observe the actual attempt, even after metadata/read/upload failure.
        // In particular, do NOT choose 'return' because the contract requires it.
        const absentHandle = this.phase === "open";
        this.phase = absentHandle ? "markEmpty" : "mark";
        this.observe(absentHandle ? "NullDatabaseHandle" : "FinishItems: setItem called");
        this.markerAttempts.push({ name, value });
        if (this.random.pick([false, false, false, false, false, false, false, true])) {
          this.phase = "return";
          this.observe("MarkerError");
          throw new Error("localStorage write failed");
        }
        this.localStorage.set(name, value);
        // The next real operation tells us whether control reaches delete or
        // return. Do not predict that choice from the driver's failure ledger.
        this.markerSucceeded = true;
      },
    } });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
      open: (name: string, version: number) => this.open(name, version),
      deleteDatabase: (name: string) => {
        if (name !== DATABASE) throw new Error(`Unexpected database ${name}`);
        this.finishMarker("delete");
        this.deletes.push(name);
        this.phase = "return";
        this.observe("DeleteDatabase");
        return {}; // A pending IDBOpenDBRequest; migration never awaits it.
      },
    } });
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
      this.fetch(String(url), init)) as typeof fetch;
  }

  private finishMarker(next: "delete" | "return"): void {
    if (!this.markerSucceeded) return;
    this.markerSucceeded = false;
    this.phase = next;
    this.observe("MarkerWritten");
  }

  private open(name: string, version: number): Request {
    if (name !== DATABASE || version !== 1) throw new Error("Unexpected indexedDB.open");
    const outcome = this.random.pick(["ok", "ok", "ok", "ok", "ok", "ok", "error", "throw"]);
    if (outcome === "throw") {
      this.phase = "return";
      this.observe("OpenThrows");
      throw new Error("indexedDB.open threw");
    }
    const request: Request = { transaction: { abort() {} } };
    Object.defineProperty(request, "result", { get: () => {
      this.todo.clear(); this.seen.clear(); this.unreadable.clear(); this.failed.clear();
      this.metadataOK = true;
      this.phase = "metadata";
      this.observe("OpenDatabase");
      return {
        transaction: (store: string, mode: string) => this.transaction(store, mode),
        close() {},
      };
    } });
    this.pending.push(() => {
      if (outcome === "error") request.onerror!();
      else if (!this.databaseExisted) request.onupgradeneeded!();
      else request.onsuccess!();
    });
    return request;
  }

  private transaction(store: string, mode: string): unknown {
    if (mode !== "readonly" || !["meta", "blobs"].includes(store)) throw new Error("Unexpected transaction");
    if (store === "blobs") {
      this.phase = "read";
      this.observe("StartRead: blobs transaction");
    }
    const outcome = this.random.pick(store === "meta"
      ? ["ok", "ok", "ok", "ok", "ok", "ok", "error", "throw"]
      : ["ok", "ok", "null", "error", "throw"]);
    if (outcome === "throw") {
      this.readFailure(store);
      throw new Error(`${store} transaction failed`);
    }
    return { objectStore: (requested: string) => {
      if (requested !== store) throw new Error("Wrong object store");
      return {
        getAll: () => this.readRequest("meta", outcome),
        get: (id: string) => this.readRequest("blobs", outcome, id),
      };
    } };
  }

  private readFailure(store: string): void {
    if (store === "meta") {
      this.metadataOK = false;
      this.todo.clear();
      this.phase = "list";
      this.observe("MetadataError");
    } else {
      const item = this.current();
      this.unreadable.add(item);
      this.todo.delete(item);
      this.phase = "scan";
      this.observe("BytesUnavailable");
    }
  }

  private current(): number {
    if (this.todo.size !== 1) throw new Error("Expected one current item within ItemCount=1");
    return [...this.todo][0];
  }

  private readRequest(store: "meta" | "blobs", outcome: string, id?: string): Request {
    const request: Request = {};
    Object.defineProperty(request, "result", { get: () => {
      if (store === "meta") {
        const rows = [...this.meta.values()].map(m => ({ ...m }));
        this.todo.clear();
        for (const m of rows) this.todo.add(this.itemNumbers.get(m.id)!);
        this.metadataOK = true;
        this.phase = "list";
        this.observe("ReadMetadata");
        return this.observeIteration(rows);
      }
      const bytes = outcome === "null" ? undefined : this.blobs.get(id!);
      if (bytes === undefined) this.readFailure("blobs");
      else { this.phase = "upload"; this.observe("ReadBytes"); }
      return bytes;
    } });
    this.pending.push(() => {
      if (outcome === "error") { this.readFailure(store); request.onerror!(); }
      else request.onsuccess!();
    });
    return request;
  }

  private observeIteration(rows: HistoryMeta[]): HistoryMeta[] {
    const browser = this;
    const originalIterator = rows[Symbol.iterator].bind(rows);
    Object.defineProperty(rows, Symbol.iterator, { value: function* () {
      for (const m of { [Symbol.iterator]: originalIterator }) {
        yield m;
        // Re-entered only when the REAL loop advances. An item without a read
        // or upload event was actually skipped, regardless of what we expected.
        const item = browser.itemNumbers.get(m.id)!;
        if (browser.todo.delete(item)) browser.observe("SkipExisting: loop advanced without reading");
      }
    } });
    return rows;
  }

  private fetch(url: string, init?: RequestInit): Promise<Response> {
    if (url !== "/api/library") throw new Error(`Unexpected fetch ${url}`);
    if (!init?.method || init.method === "GET") {
      return new Promise(resolve => this.pending.push(() => {
        const ok = this.random.pick([true, true, true, true, true, true, true, false]);
        const rows = [...this.server.values()].map(m => ({ ...m }));
        const browser = this;
        Object.defineProperty(rows, "map", { value(callback: (m: HistoryMeta, i: number, a: HistoryMeta[]) => unknown) {
          const result = Array.prototype.map.call(rows, callback) as string[];
          browser.seen.clear();
          for (const k of result) browser.seen.add(k);
          browser.phase = "scan";
          browser.observe("ListShared: listing mapped by migration");
          return result;
        } });
        resolve({
          get ok() {
            if (!ok) { browser.phase = "return"; browser.observe("ListError"); }
            return ok;
          },
          status: ok ? 200 : 503,
          json: async () => ({ items: rows }),
        } as Response);
      }));
    }
    if (init.method !== "POST" || !(init.body instanceof FormData)) throw new Error("Unexpected library request");
    const meta = JSON.parse(String(init.body.get("meta"))) as HistoryMeta;
    const bytes = init.body.get("bytes");
    if (!(bytes instanceof Blob)) throw new Error("Upload did not include bytes");
    this.uploadAttempts.push({ meta, bytes });
    const item = this.current();
    return new Promise(resolve => this.pending.push(() => {
      const ok = this.random.pick([true, true, false]);
      const browser = this;
      if (ok) this.server.set(key(meta), { ...meta, id: `saved-${this.uploadAttempts.length}`, createdAt: 1, size: bytes.size });
      resolve({
        get ok() {
          if (!ok) browser.failed.add(item);
          browser.todo.delete(item);
          browser.phase = "scan";
          browser.observe(ok ? "UploadSuccess" : "UploadFailure");
          return ok;
        },
        status: ok ? 200 : 503,
      } as Response);
    }));
  }

  private startLoad(): void {
    this.loads++;
    this.entryDone = Boolean(this.localStorage.get(FLAG));
    this.entryWrites = this.counts();
    this.phase = "flag";
    this.active = true;
    this.observe("StartLoad");
    // Call even if the marker is set, storage is unavailable, or DB is absent.
    void migrateLocalLibrary().then(() => {
      this.finishMarker("return");
      if (this.phase !== "return") throw new Error(`Unobserved return from ${this.phase}`);
      if (this.loads === 1) {
        this.retryItems.clear();
        for (const [id, m] of this.meta) {
          const n = this.itemNumbers.get(id)!;
          if (!this.server.has(key(m)) && (this.unreadable.has(n) || this.failed.has(n))) this.retryItems.add(n);
        }
      }
      this.phase = "idle";
      this.active = false;
      this.observe("ReturnFromLoad");
    }).catch(error => { this.fatal = error; });
  }

  async step(): Promise<{ state: JSONValue; event: string }> {
    // Draw at every step, including bounded stutters. The actual pending API
    // request determines which response can be delivered; its outcome is random.
    const choice = this.random.next();
    if (this.observations.length === 0) {
      if (this.pending.length) this.pending.splice(choice % this.pending.length, 1)[0]();
      else if (!this.active && this.loads < MAX_LOADS) this.startLoad();
      else if (this.active) throw new Error("Migration stalled without an I/O request");
      // Drain only native promise jobs. No timers, sleeps, or wall-clock reads.
      for (let i = 0; i < 32; i++) await Promise.resolve();
      if (this.fatal) throw this.fatal;
    }
    return this.observations.shift() ?? { state: abstract(this), event: "Idle: load bound reached" };
  }
}

function abstract(s: Browser): JSONValue {
  const local = [...s.meta.values()];
  const projectedKeys = (has: (k: string) => boolean) => set(local.filter(m => has(key(m))).map(m => tuple([m.kind, m.name])));
  const numbers = (xs: Iterable<number>) => set([...xs].sort((a, b) => a - b));
  return {
    storage: s.storageReadable, oldDatabase: s.databaseExisted,
    localItems: numbers(s.itemNumbers.values()), shared: projectedKeys(k => s.server.has(k)),
    flag: Boolean(s.localStorage.get(FLAG)), deleteIssued: s.deletes.length > 0,
    phase: s.phase, loads: s.loads, todo: numbers(s.todo), seen: projectedKeys(k => s.seen.has(k)),
    unreadable: numbers(s.unreadable), failed: numbers(s.failed), metadataOK: s.metadataOK,
    writes: s.counts(), entryDone: s.entryDone, entryWrites: { ...s.entryWrites }, retryItems: numbers(s.retryItems),
  };
}

const runs = numberEnv("INVARIANT_RUNS", 100);
const steps = numberEnv("INVARIANT_STEPS", 100);
const random = new Random(process.env.INVARIANT_SEED ?? "1");
const output = process.env.INVARIANT_TRACES;
if (!output) throw new Error("INVARIANT_TRACES is required");
const traces: JSONValue[][] = [];
const failures = new Map<string, unknown>();

// Silence only the function's informational logging, retaining driver failures.
const savedInfo = console.info;
const savedWarn = console.warn;
console.info = () => {};
console.warn = () => {};
try {
  for (let run = 0; run < runs; run++) {
    const browser = new Browser(random);
    browser.install();
    const trace = [abstract(browser)];
    for (let step = 1; step <= steps; step++) {
      const observation = await browser.step();
      trace.push(observation.state);
      // Diagnostics are derived from the observed snapshot, never used to
      // suppress a call, discard a trace, change an outcome, or stop execution.
      const s = observation.state as Record<string, any>;
      if (s.flag && s.shared.$set.length < s.localItems.$set.length) {
        const reason = s.unreadable.$set.length ? "unreadable" : s.failed.$set.length ? "upload" : !s.metadataOK ? "metadata" : "open";
        if (!failures.has(reason)) failures.set(reason, { run, step, event: observation.event, state: s });
      }
      if (s.deleteIssued && s.shared.$set.length < s.localItems.$set.length && !failures.has("delete")) {
        failures.set("delete", { run, step, event: observation.event, state: s });
      }
      if (s.loads === 2 && s.phase === "idle" && s.flag && s.retryItems.$set.length && !failures.has("retry-suppressed")) {
        failures.set("retry-suppressed", { run, step, event: observation.event, state: s });
      }
    }
    traces.push(trace);
  }
} finally {
  console.info = savedInfo;
  console.warn = savedWarn;
}
await writeFile(output, JSON.stringify({ traces }));
console.error(JSON.stringify({ seed: process.env.INVARIANT_SEED ?? "1", runs, steps, observedViolations: Object.fromEntries(failures) }));
