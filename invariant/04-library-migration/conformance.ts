import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { migrateLocalLibrary, type HistoryMeta } from "../../lib/history.ts";

// Only browser/service boundaries are replaced. The migration and its HTTP
// helpers run unchanged. Nothing uses a timer, a network socket, or a real DB.
const FLAG = "ask3d:library-migrated-v1";
const DB = "ask3d-history";
const kinds = ["open", "read", "list", "upload", "mark", "delete"] as const;
type Counts = Record<(typeof kinds)[number], number>;
const zero = (): Counts => Object.fromEntries(kinds.map(k => [k, 0])) as Counts;
type Event = { kind: string; store?: string; ok?: boolean };
type Load = { events: Event[]; returned: boolean; warnings: number };
type Callback = ((event: any) => void) | null;

class Request {
  result: any;
  error: Error | null = null;
  readyState = "pending";
  onsuccess: Callback = null;
  onerror: Callback = null;
  onupgradeneeded: Callback = null;
  transaction: any = null;
}

class MemoryFormData {
  values = new Map<string, string | Blob>();
  append(key: string, value: string | Blob) { this.values.set(key, value); }
  get(key: string) { return this.values.get(key); }
}

class ReadTransaction {
  request = new Request();
  oncomplete: Callback = null;
  onabort: Callback = null;
  error: Error | null = null;
  terminal: "complete" | "abort" | "error" | null = null;
  readonly browser: Browser;
  readonly store: string;
  constructor(browser: Browser, store: string) {
    this.browser = browser;
    this.store = store;
  }
  objectStore(name: string) {
    assert.equal(name, this.store);
    return {
      getAll: () => this.read(undefined),
      get: (id: string) => this.read(id),
    };
  }
  read(id: string | undefined) {
    this.browser.record({ kind: "read", store: this.store });
    this.browser.tasks.push(async () => {
      if (this.terminal || this.request.readyState !== "pending") return;
      this.request.result = this.store === "meta"
        ? [...this.browser.localMeta.values()].map(m => ({ ...m }))
        : this.browser.localBlobs.get(id!);
      this.request.readyState = "done";
      this.request.onsuccess?.({ target: this.request });
    });
    // Request success and transaction commit are deliberately separate tasks.
    this.browser.tasks.push(async () => {
      if (this.terminal || this.request.readyState !== "done") return;
      this.terminal = "complete";
      this.oncomplete?.({ target: this });
    });
    return this.request;
  }
  abort() {
    // These are IndexedDB event legality checks, not migration/model guards.
    if (this.terminal) return;
    this.terminal = "abort";
    this.error = new Error("injected transaction abort");
    this.onabort?.({ target: this });
  }
  requestError() {
    if (this.terminal || this.request.readyState !== "pending") return;
    this.terminal = "error";
    this.request.readyState = "done";
    this.request.error = new Error("injected request error");
    this.request.onerror?.({ target: this.request });
  }
  status() {
    if (this.terminal === "complete") {
      return this.store === "blobs" && this.request.result == null ? "missing" : "complete";
    }
    if (this.terminal) return this.terminal;
    if (this.request.readyState === "pending") return "waiting";
    return this.store === "blobs" && this.request.result == null ? "resultMissing" : "result";
  }
}

class Connection {
  closed = false;
  readonly browser: Browser;
  constructor(browser: Browser) { this.browser = browser; }
  transaction(store: string, mode: string) {
    assert.equal(this.closed, false);
    assert.equal(mode, "readonly");
    assert.ok(store === "meta" || store === "blobs");
    const tx = new ReadTransaction(this.browser, store);
    this.browser.reads.push({ load: this.browser.loads.length, tx });
    return tx;
  }
  close() {
    this.closed = true;
    this.browser.record({ kind: "close" });
  }
}

class Browser {
  storage = new Map<string, string>();
  localMeta = new Map<string, HistoryMeta>();
  localBlobs = new Map<string, ArrayBuffer>();
  server = new Map<string, { meta: HistoryMeta; bytes: ArrayBuffer }>();
  connections: Connection[] = [];
  reads: { load: number; tx: ReadTransaction }[] = [];
  loads: Load[] = [];
  tasks: (() => Promise<void>)[] = [];
  pendingOpen: Request | undefined;
  pendingHttp: { respond: (ok: boolean) => Promise<void> } | undefined;
  sealed: Counts | undefined;
  failWrites = false;
  sourceExists: boolean;
  readonly original: HistoryMeta;
  readonly originalBytes = new Uint8Array([0, 1, 127, 255]).buffer;
  readonly origin: { storageAvailable: boolean; exists: boolean; items: HistoryMeta[] };
  constructor(random: () => number) {
    const environment = ["library", "library", "library", "empty", "absent", "unavailable"][random() % 6];
    this.sourceExists = environment !== "absent";
    this.original = {
      id: "local-1", createdAt: 100, kind: random() % 2 ? "mesh" : "image",
      name: `item-${random() % 3}`, mime: "application/octet-stream", size: 4,
      note: "migration fixture", dims: { x: 1, y: 2, z: 3 },
    };
    if (environment === "library" || environment === "unavailable") {
      this.localMeta.set(this.original.id, this.original);
      if (random() % 8 !== 0) this.localBlobs.set(this.original.id, this.originalBytes);
    }
    this.origin = {
      storageAvailable: environment !== "unavailable", exists: this.sourceExists,
      items: [...this.localMeta.values()],
    };
    // Same name / wrong kind and same kind / wrong name must not count as copied.
    const wrongKind = { ...this.original, id: "other-kind", kind: "scad" as const };
    const wrongName = { ...this.original, id: "other-name", name: "another-item" };
    for (const meta of [wrongKind, wrongName]) {
      this.server.set(this.key(meta), { meta, bytes: this.originalBytes });
    }
    if (random() % 4 === 0) {
      const meta = { ...this.original, id: "server-existing" };
      this.server.set(this.key(meta), { meta, bytes: this.originalBytes });
    }
  }
  key(meta: Pick<HistoryMeta, "kind" | "name">) { return `${meta.kind}|${meta.name}`; }
  record(event: Event) { this.loads[this.loads.length - 1].events.push(event); }
  counts(): Counts {
    const result = zero();
    for (const load of this.loads) for (const event of load.events) {
      if (kinds.includes(event.kind as any)) result[event.kind as keyof Counts]++;
    }
    return result;
  }
  install() {
    const replacements: Record<string, any> = {
      localStorage: {
        getItem: (key: string) => {
          assert.equal(key, FLAG);
          this.record({ kind: "flagRead", ok: this.origin.storageAvailable });
          if (!this.origin.storageAvailable) throw new Error("storage unavailable");
          return this.storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          assert.equal(key, FLAG);
          const ok = this.origin.storageAvailable && !this.failWrites;
          this.record({ kind: "mark", ok });
          if (!ok) throw new Error("storage write failed");
          this.storage.set(key, value);
        },
      },
      indexedDB: {
        open: (name: string, version: number) => {
          assert.equal(name, DB);
          assert.equal(version, 1);
          this.record({ kind: "open" });
          const req = this.pendingOpen = new Request();
          this.tasks.push(async () => {
            if (req.readyState !== "pending") return;
            req.readyState = "done";
            if (!this.sourceExists) {
              let aborted = false;
              req.transaction = { abort: () => { aborted = true; } };
              req.onupgradeneeded?.({ target: req });
              assert.ok(aborted, "opening a missing DB must abort its creation");
              req.error = new Error("creation aborted");
              req.onerror?.({ target: req });
            } else {
              req.result = new Connection(this);
              this.connections.push(req.result);
              req.onsuccess?.({ target: req });
            }
          });
          return req;
        },
        deleteDatabase: (name: string) => {
          assert.equal(name, DB);
          this.record({ kind: "delete" });
          // Model counts requests. Deletion itself is intentionally deferred;
          // no completion callback is needed by the migration.
          return new Request();
        },
      },
      FormData: MemoryFormData,
      fetch: (url: string, init?: { method?: string; body?: MemoryFormData }) => {
        assert.equal(url, "/api/library");
        const upload = init?.method === "POST";
        assert.ok(upload || init === undefined);
        this.record({ kind: upload ? "upload" : "list" });
        return new Promise(resolve => {
          let settled = false;
          const http = {
            respond: async (ok: boolean) => {
              if (settled) return;
              settled = true;
              if (this.pendingHttp === http) this.pendingHttp = undefined;
              if (ok && upload) {
                const form = init!.body!;
                const meta = JSON.parse(form.get("meta") as string);
                const blob = form.get("bytes");
                assert.ok(blob instanceof Blob);
                const bytes = await blob.arrayBuffer();
                assert.deepEqual(new Uint8Array(bytes), new Uint8Array(this.originalBytes));
                assert.equal(meta.id, undefined);
                assert.equal(meta.createdAt, undefined);
                assert.equal(meta.size, undefined);
                const saved = { ...meta, id: "server-upload", createdAt: 200, size: bytes.byteLength };
                this.server.set(this.key(saved), { meta: saved, bytes });
              }
              resolve({
                ok, status: ok ? 200 : 503,
                json: async () => ({ items: [...this.server.values()].map(x => ({ ...x.meta })) }),
              });
            },
          };
          this.pendingHttp = http;
          this.tasks.push(() => http.respond(true));
        });
      },
    };
    const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(replacements)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const warn = console.warn, info = console.info;
    console.warn = () => { this.loads[this.loads.length - 1].warnings++; };
    console.info = () => {};
    return () => {
      console.warn = warn;
      console.info = info;
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
  }
  startLoad() {
    // The ratified scope is at most two SEQUENTIAL invocations. This is the
    // only bound on calling the real exported operation (including after done).
    if (this.loads.length === 2 || this.loads.some(load => !load.returned)) return;
    const load: Load = { events: [], returned: false, warnings: 0 };
    this.loads.push(load);
    void migrateLocalLibrary().then(() => {
      load.returned = true;
      if (this.storage.get(FLAG) && !this.sealed) this.sealed = this.counts();
    }, error => { throw error; });
  }
  async step(operation: string, failWrites: boolean) {
    this.failWrites = failWrites;
    switch (operation) {
      case "load": this.startLoad(); break;
      case "deliver": await this.tasks.shift()?.(); break;
      case "abort": this.reads[this.reads.length - 1]?.tx.abort(); break;
      case "requestError": this.reads[this.reads.length - 1]?.tx.requestError(); break;
      case "openError": {
        const req = this.pendingOpen;
        if (req?.readyState === "pending") {
          req.readyState = "done";
          req.error = new Error("open failed");
          req.onerror?.({ target: req });
        }
        break;
      }
      case "httpError": await this.pendingHttp?.respond(false); break;
      default: throw new Error(`unknown operation: ${operation}`);
    }
    // Drain the finite await chains in history.ts, without running another
    // browser event. There are no timers or automatically dispatched IDB events.
    for (let i = 0; i < 32; i++) await Promise.resolve();
    this.failWrites = false;
  }
  snapshot() {
    const load = this.loads[this.loads.length - 1];
    const events = load?.events ?? [];
    const latest = (kind: string) => events.filter(e => e.kind === kind).at(-1);
    const read = (store: string) => this.reads.find(r => r.load === this.loads.length && r.tx.store === store)?.tx;
    const meta = read("meta"), bytes = read("blobs"), mark = latest("mark");
    // Control locations are observations of boundary calls and promise return,
    // not a second implementation of the migration's decision logic.
    let stage = "flag", pc = "ready";
    if (load) {
      pc = "check";
      if (latest("open")) stage = "open";
      if (meta) stage = "meta";
      if (latest("list")) stage = "list";
      if (bytes) { stage = "choose"; pc = "read"; }
      if (latest("upload")) { stage = "choose"; pc = "upload"; }
      if (mark) { stage = meta ? (mark.ok ? "close" : "mark") : "absent"; pc = "check"; }
      if (mark?.ok && latest("close")) pc = "delete";
      if (load.returned) pc = load.warnings ? "ready" : latest("flagRead")?.ok === false ? "unavailable" : "done";
    }
    return {
      pc,
      environment: !this.origin.storageAvailable ? "unavailable" : !this.origin.exists ? "absent"
        : this.origin.items.length ? "library" : "empty",
      loads: this.loads.length,
      shared: this.server.has(this.key(this.original)),
      flag: Boolean(this.storage.get(FLAG)),
      dbOpen: this.connections.some(connection => !connection.closed),
      stage, metaRead: meta?.status() ?? "idle", blobRead: bytes?.status() ?? "idle",
      failed: Boolean(load?.returned && load.warnings),
      failedLoads: this.loads.filter(l => l.returned && l.warnings > 0).length,
      calls: this.counts(), sealed: this.sealed ?? zero(), completed: this.sealed !== undefined,
    };
  }
}

function abstract(s: ReturnType<Browser["snapshot"]>) {
  const fn = (counts: Counts) => ({ $fn: kinds.map(k => [k, counts[k]]) });
  return { ...s, shared: { $set: s.shared ? [{ $mv: "item" }] : [] }, calls: fn(s.calls), sealed: fn(s.sealed) };
}

// FNV-1a seed folding followed by xorshift32: deterministic even for text seeds.
let seed = 2166136261;
for (const char of process.env.INVARIANT_SEED ?? "1") seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
if (!seed) seed = 1;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }
const runs = Number(process.env.INVARIANT_RUNS ?? 100);
const steps = Number(process.env.INVARIANT_STEPS ?? 100);
assert.ok(Number.isSafeInteger(runs) && runs > 0 && Number.isSafeInteger(steps) && steps >= 0);
assert.ok(process.env.INVARIANT_TRACES, "INVARIANT_TRACES is required");
const operations = [
  "load", "load", "load", "load", "load", "load",
  ...Array<string>(24).fill("deliver"), "abort", "requestError", "openError", "httpError",
];
const traces = [];
for (let run = 0; run < runs; run++) {
  const browser = new Browser(random);
  const restore = browser.install();
  try {
    const trace = [abstract(browser.snapshot())];
    for (let step = 0; step < steps; step++) {
      // No phase-dependent operation selection or model guards. The browser
      // double refuses events for nonexistent/settled requests, as a browser does.
      await browser.step(operations[random() % operations.length], random() % 32 === 0);
      trace.push(abstract(browser.snapshot()));
    }
    traces.push(trace);
  } finally { restore(); }
}
await writeFile(process.env.INVARIANT_TRACES!, JSON.stringify({ traces }));
