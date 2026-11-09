import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as yieldEventLoop } from "node:timers/promises";

/*
 * The production module is imported, never rewritten. Its fs/promises object
 * is replaced at the I/O boundary. Each writer I/O waits for a scheduler step;
 * GETs use the same byte store without advancing a writer. In particular, an
 * rm observation is not coalesced with the later index rename or response.
 *
 * index, blobs, temporary and the background group are decoded from storage.
 * base/loaded are histories of lock-entry/read observations. target/garbage
 * describe the pending request applied to the actual read result, until the
 * serialized write supplies the concrete target. These are observation
 * bookkeeping, not a second implementation that supplies persisted results.
 * Request status comes from actual handler settlement. A swallowed read error
 * remains running if the handler proceeds to another filesystem operation.
 */

type Scenario = "concurrent" | "upsert" | "trim" | "delete-one" | "delete-all" | "recover";
type Phase = "idle" | "read" | "blob-mkdir" | "blob-write" | "index-mkdir" |
  "index-write" | "index-rename" | "cleanup" | "success" | "error" | "done";
type Status = "unused" | "queued" | "running" | "ok" | "error";
type Operation = "readFile" | "mkdir" | "writeFile" | "rename" | "rm";
type FailureSite = "none" | "read" | "blob-mkdir" | "blob-write" |
  "index-mkdir" | "index-write" | "index-rename" | "remove";
type Meta = { id: string; createdAt: number; kind: string; name: string; mime: string; size: number };
type Route = {
  GET(req: Request): Promise<Response>;
  POST(req: Request): Promise<Response>;
  DELETE(req: Request): Promise<Response>;
};
type Context = { fixture: Fixture; call: number; reader: boolean };
type Pending = {
  call: number; op: Operation; args: unknown[];
  resolve(value: unknown): void; reject(reason: unknown): void;
};
type Outcome = { status: number; body?: unknown; error?: string };

const real = {
  readFile: fs.readFile.bind(fs), mkdir: fs.mkdir.bind(fs),
  writeFile: fs.writeFile.bind(fs), rename: fs.rename.bind(fs), rm: fs.rm.bind(fs),
  mkdtemp: fs.mkdtemp.bind(fs),
};
const context = new AsyncLocalStorage<Context>();
const scenarios: Scenario[] = ["concurrent", "upsert", "trim", "delete-one", "delete-all", "recover"];
const sites: FailureSite[] = ["none", "read", "blob-mkdir", "blob-write", "index-mkdir", "index-write", "index-rename", "remove"];
const payloads = { bytesA: Buffer.from("given bytes A"), bytesB: Buffer.from("given bytes B") };
const backgroundBytes = Buffer.from("fixed background bytes");
const ids = [1, 2, 3, 4];
const diskID = (id: number) => id.toString(16).padStart(24, "0");
const mv = (value: string) => ({ $mv: value });
const seq = (value: unknown[]) => ({ $seq: value });
const fn = (pairs: unknown[][]) => ({ $fn: pairs });
const set = (value: unknown[]) => ({ $set: value });

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

// FNV-1a seed expansion followed by xorshift32; no clock or ambient randomness.
function generator(seed: string) {
  let word = 2166136261;
  for (const ch of seed) word = Math.imul(word ^ ch.charCodeAt(0), 16777619) >>> 0;
  if (!word) word = 1;
  return (bound: number) => {
    word ^= word << 13; word ^= word >>> 17; word ^= word << 5;
    return (word >>> 0) % bound;
  };
}

function ioError(message: string, code = "EIO"): Error {
  return Object.assign(new Error(message), { code });
}

class Fixture {
  readonly scenario: Scenario;
  readonly root: string;
  readonly files = new Map<string, Buffer>();
  readonly pending: Pending[] = [];
  readonly outcomes = new Map<number, Outcome>();
  readonly events: Record<string, unknown>[] = [];
  readonly backgroundRecords: Meta[];
  readonly indexPath: string;
  readonly blobDir: string;
  readonly temporaryPath: string;
  readonly calls: number[];
  readonly fault: { site: FailureSite; call: number; occurrence: number; effect: number };
  readonly seen = new Map<string, number>();
  readonly generated = new Set<number>();
  readonly readResults = new Map<number, Meta[]>();
  readonly blobWritten = new Set<number>();
  route!: Route;
  queue: number[];
  owner = 0;
  status: Status[];
  pc: Phase = "idle";
  base: number[] = [];
  loaded: number[] = [];
  target: number[] = [];
  garbage: number[] = [];
  failures = 0;
  failedAt: FailureSite = "none";
  protectedItems: number[] = [];
  backgroundPending = false;
  backgroundTarget = true;
  started = false;
  step = 0;

  constructor(scenario: Scenario, root: string, random: (n: number) => number) {
    this.scenario = scenario;
    this.root = root;
    this.indexPath = path.join(root, ".library", "index.json");
    this.blobDir = path.join(root, ".library", "blobs");
    this.temporaryPath = `${this.indexPath}.${process.pid}.tmp`;
    this.calls = scenario === "concurrent" || scenario === "recover" ? [1, 2] : [1];
    this.queue = [...this.calls];
    this.status = ["unused", "queued", this.calls.length === 2 ? "queued" : "unused"];
    this.fault = {
      site: sites[random(sites.length)], call: this.calls[random(this.calls.length)],
      occurrence: scenario === "delete-all" && random(2) ? 1 + random(60) : 1,
      effect: random(3), // no effect / partial write (or completed rm) / complete write
    };
    this.backgroundRecords = Array.from({ length: 58 }, (_, i) => ({
      id: `background-${i.toString().padStart(2, "0")}`,
      createdAt: 2100 + i, kind: "image", name: `background-${i}`,
      mime: "application/octet-stream", size: backgroundBytes.length,
    })).reverse();
    const seed = scenario === "concurrent" ? [] :
      scenario === "upsert" || scenario === "recover" ? [1] : [2, 1];
    const records = [...this.backgroundRecords, ...seed.map(id => this.record(id))];
    this.files.set(this.indexPath, Buffer.from(JSON.stringify(records)));
    for (const record of this.backgroundRecords) this.files.set(this.blobPath(record.id), Buffer.from(backgroundBytes));
    for (const id of seed) this.files.set(this.blobPath(diskID(id)), Buffer.from(this.bytes(id)));
  }

  get post() { return this.scenario !== "delete-one" && this.scenario !== "delete-all"; }
  blobPath(id: string) { return path.join(this.blobDir, `${id}.bin`); }
  key(id: number): [string, string] {
    return [id <= 2 || this.scenario === "upsert" || (this.scenario === "concurrent" && id === 3)
      ? "image" : "mesh", id === 2 ? "two" : "one"];
  }
  bytes(id: number): Buffer {
    return id === 2 || id === 4 || (this.scenario === "upsert" && id === 3) ? payloads.bytesB : payloads.bytesA;
  }
  record(id: number): Meta {
    const [kind, name] = this.key(id);
    return { id: diskID(id), createdAt: id * 1000, kind, name, mime: "application/octet-stream", size: this.bytes(id).length };
  }
  log(event: Record<string, unknown>) { this.events.push({ step: this.step, ...event }); }

  // Refuse lossy projections: background records may only be all present or
  // all absent, unchanged and in their time order, including relative to saves.
  project(records: Meta[]): { items: number[]; background: boolean } {
    if (!Array.isArray(records)) throw new Error("Projection refused: index is not an array");
    const group = records.filter(r => r.id.startsWith("background-"));
    if (group.length !== 0 && group.length !== 58) throw new Error("Projection refused: partially indexed background");
    for (let i = 0; i < group.length; i++) {
      const want = this.backgroundRecords[i];
      if (Object.keys(group[i]).length !== Object.keys(want).length ||
          Object.entries(want).some(([key, value]) => (group[i] as unknown as Record<string, unknown>)[key] !== value)) {
        throw new Error("Projection refused: changed or reordered background metadata");
      }
    }
    for (let i = 1; i < records.length; i++) {
      if ((records[i - 1].id.startsWith("background-") || records[i].id.startsWith("background-")) &&
          records[i - 1].createdAt < records[i].createdAt) {
        throw new Error("Projection refused: background ordering disagrees with timestamps");
      }
    }
    const tracked = records.filter(r => !r.id.startsWith("background-")).map(r => {
      const id = ids.find(id => diskID(id) === r.id);
      if (!id) throw new Error(`Projection refused: unknown id ${r.id}`);
      const want = this.record(id);
      if (r.kind !== want.kind || r.name !== want.name || r.createdAt !== want.createdAt || r.size !== want.size) {
        throw new Error(`Projection refused: changed tracked metadata ${r.id}`);
      }
      return id;
    });
    return { items: tracked, background: group.length === 58 };
  }
  published() {
    const data = this.files.get(this.indexPath);
    if (!data) throw new Error("Projection refused: published index disappeared");
    return this.project(JSON.parse(data.toString("utf8")));
  }
  temporary() {
    const data = this.files.get(this.temporaryPath);
    if (!data) return { state: "none", items: [] as number[], keepBackground: false };
    let decoded: Meta[];
    try { decoded = JSON.parse(data.toString("utf8")); }
    catch { return { state: "partial", items: [] as number[], keepBackground: false }; }
    const projected = this.project(decoded);
    return { state: "ready", items: projected.items, keepBackground: projected.background };
  }
  blobValue(id: number): string {
    const data = this.files.get(this.blobPath(diskID(id)));
    if (!data) return "missing";
    if (data.equals(payloads.bytesA)) return "bytesA";
    if (data.equals(payloads.bytesB)) return "bytesB";
    return "partial";
  }
  snapshot() {
    const published = this.published();
    return {
      scenario: this.scenario, index: published.items,
      blobs: ids.map(id => this.blobValue(id)), queue: [...this.queue], owner: this.owner,
      status: this.status.slice(1), pc: this.pc, base: [...this.base], loaded: [...this.loaded],
      target: [...this.target], garbage: [...this.garbage], temporary: this.temporary(),
      failures: this.failures, failedAt: this.failedAt, protected: [...this.protectedItems],
      background: {
        listed: published.background,
        complete: this.backgroundRecords.every(r => this.files.get(this.blobPath(r.id))?.equals(backgroundBytes) === true),
        pending: this.backgroundPending, targetListed: this.backgroundTarget,
      },
    };
  }

  enqueue(call: number, op: Operation, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => { this.pending.push({ call, op, args, resolve, reject }); });
  }
  checkPath(value: unknown): string {
    const name = path.resolve(String(value));
    if (!name.startsWith(path.join(this.root, ".library") + path.sep)) {
      throw new Error(`Unexpected filesystem access: ${name}`);
    }
    return name;
  }
  execute(op: Operation, args: unknown[], effect = 2): unknown {
    const file = this.checkPath(args[0]);
    if (op === "mkdir") return undefined;
    if (op === "readFile") {
      const bytes = this.files.get(file);
      if (!bytes) throw ioError(`No file: ${file}`, "ENOENT");
      return args[1] === "utf8" ? bytes.toString("utf8") : Buffer.from(bytes);
    }
    if (op === "writeFile") {
      const bytes = typeof args[1] === "string" ? Buffer.from(args[1]) : Buffer.from(args[1] as Uint8Array);
      if (effect > 0) this.files.set(file, effect === 1 ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes);
      return undefined;
    }
    if (op === "rm") {
      if (effect > 0) this.files.delete(file);
      return undefined;
    }
    const destination = this.checkPath(args[1]);
    const bytes = this.files.get(file);
    if (!bytes) throw ioError("rename source missing", "ENOENT");
    this.files.set(destination, bytes);
    this.files.delete(file);
    return undefined;
  }
  phase(operation: Pending): FailureSite {
    if (operation.op === "readFile") return "read";
    if (operation.op === "rm") return "remove";
    if (operation.op === "rename") return "index-rename";
    if (operation.op === "writeFile") return operation.args[0] === this.temporaryPath ? "index-write" : "blob-write";
    return this.post && !this.blobWritten.has(operation.call) ? "blob-mkdir" : "index-mkdir";
  }

  // This is the request's abstract intent, calculated from the bytes actually
  // returned by readFile. Publication is always read independently from disk.
  readIntent(records: Meta[], call: number) {
    this.readResults.set(call, records);
    this.loaded = this.project(records).items;
    let next: Meta[];
    if (this.post) {
      const incoming = this.record(call + 2);
      const others = records.filter(r => r.kind !== incoming.kind || r.name !== incoming.name);
      others.sort((a, b) => b.createdAt - a.createdAt);
      next = [incoming, ...others.slice(0, 59)];
    } else next = this.scenario === "delete-all" ? [] : records.filter(r => r.id !== diskID(1));
    const projected = this.project(next);
    this.target = projected.items;
    this.backgroundTarget = projected.background;
    this.garbage = this.loaded.filter(id => !this.target.includes(id));
  }

  submit(call: number) {
    const request = this.post ? {
      // A real FormData and Blob, with the Request parsing seam supplied in
      // memory. This avoids multipart boundary randomness and any transport.
      formData: async () => {
        const form = new FormData();
        const record = this.record(call + 2);
        form.set("meta", JSON.stringify({ kind: record.kind, name: record.name, mime: record.mime }));
        form.set("bytes", new Blob([new Uint8Array(this.bytes(call + 2))]));
        return form;
      },
    } as Request : new Request(`http://library.invalid/api/library?${this.scenario === "delete-all" ? "all=1" : `id=${diskID(1)}`}`);
    this.log({ event: "submit", call, method: this.post ? "POST" : "DELETE" });
    const result = context.run({ fixture: this, call, reader: false }, () =>
      this.post ? this.route.POST(request) : this.route.DELETE(request));
    void result.then(async response => {
      this.outcomes.set(call, { status: response.status, body: await response.json() });
      this.log({ event: "response", call, ...this.outcomes.get(call) });
    }, error => {
      this.outcomes.set(call, { status: 500, error: String(error) });
      this.log({ event: "rejection", call, error: String(error) });
    });
  }
  async settle() {
    // No wall-clock sleep: let native Blob/Response promises and lock-chain
    // continuations reach their next intercepted I/O or handler settlement.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await yieldEventLoop();
  }
  async start() {
    this.started = true;
    this.submit(1);
    for (let i = 0; !this.pending.length && !this.outcomes.has(1); i++) {
      if (i > 100) throw new Error("First request did not reach an observation boundary");
      await this.settle();
    }
    // The first request is paused inside its actual lock. The second is then
    // submitted even if the first operation is destined to fail.
    if (this.calls.length === 2) this.submit(2);
    await this.settle();
  }
  async get(random: (n: number) => number) {
    const id = random(5);
    const response = await context.run({ fixture: this, call: 0, reader: true }, () =>
      this.route.GET(new Request(`http://library.invalid/api/library${id ? `?id=${diskID(id)}` : ""}`)));
    await response.arrayBuffer();
    this.log({ event: "GET", id, status: response.status });
  }

  async advance(random: (n: number) => number) {
    if (!this.started) await this.start();
    if (this.pc === "success" || this.pc === "error") {
      this.log({ event: "release", call: this.owner });
      this.owner = 0;
      this.pc = this.queue.length ? "idle" : "done";
      return;
    }
    if (!this.owner) {
      if (!this.queue.length) { await this.get(random); return; } // two-request bound
      const operation = this.pending[0];
      if (!operation) throw new Error("Queued request has no observed lock entry");
      this.owner = operation.call;
      this.queue = this.queue.filter(call => call !== this.owner);
      this.status[this.owner] = "running";
      this.pc = "read";
      this.base = this.published().items;
      this.loaded = []; this.target = []; this.garbage = [];
      this.log({ event: "acquire", call: this.owner });
      return;
    }
    const unexpected = this.pending.find(op => op.call !== this.owner);
    if (unexpected && !this.outcomes.has(this.owner)) {
      // Do not serialize a broken implementation on its behalf.
      this.status[unexpected.call] = "running";
      this.queue = this.queue.filter(call => call !== unexpected.call);
      this.log({ event: "overlapping-writers", owner: this.owner, other: unexpected.call });
      return;
    }
    const position = this.pending.findIndex(op => op.call === this.owner);
    if (position < 0) {
      const outcome = this.outcomes.get(this.owner);
      if (!outcome) throw new Error("Writer has neither pending I/O nor a handler outcome");
      const ok = outcome.status >= 200 && outcome.status < 300;
      this.status[this.owner] = ok ? "ok" : "error";
      this.pc = ok ? "success" : "error";
      this.log({ event: "observe-response", call: this.owner, ...outcome });
      return;
    }
    const operation = this.pending.splice(position, 1)[0];
    const site = this.phase(operation);
    const occurrenceKey = `${operation.call}:${site}`;
    const occurrence = (this.seen.get(occurrenceKey) ?? 0) + 1;
    this.seen.set(occurrenceKey, occurrence);
    const fail = !this.failures && site === this.fault.site && operation.call === this.fault.call &&
      occurrence === (site === "remove" ? this.fault.occurrence : 1);
    const before = this.published();
    let result: unknown;
    if (fail) {
      this.failures++;
      this.failedAt = site;
      if (site === "read") this.protectedItems = before.items;
      if (operation.op === "writeFile" || operation.op === "rm") this.execute(operation.op, operation.args, this.fault.effect);
      operation.reject(ioError(`Injected ${site} failure`));
    } else {
      result = this.execute(operation.op, operation.args);
      operation.resolve(result);
    }
    this.log({ event: "fs", call: operation.call, op: operation.op, site,
      path: path.relative(this.root, String(operation.args[0])), failed: fail,
      ...(fail ? { effect: this.fault.effect } : {}) });
    await this.settle();

    if (site === "read") {
      if (fail && this.outcomes.has(this.owner)) {
        this.pc = "error"; this.status[this.owner] = "error";
      } else {
        // The continuation reached I/O despite rejection: readIndex caught it.
        // A successful read is parsed from the exact string supplied to code.
        this.readIntent(fail ? [] : JSON.parse(result as string), this.owner);
        this.pc = this.post ? "blob-mkdir" : "index-mkdir";
      }
      return;
    }
    if (fail) {
      this.pc = "error"; this.status[this.owner] = "error";
      return;
    }
    switch (site) {
      case "blob-mkdir": this.pc = "blob-write"; break;
      case "blob-write": this.blobWritten.add(this.owner); this.pc = "index-mkdir"; break;
      case "index-mkdir": this.pc = "index-write"; break;
      case "index-write": {
        const actual = this.temporary();
        this.target = actual.items; this.backgroundTarget = actual.keepBackground;
        this.pc = "index-rename";
        break;
      }
      case "index-rename":
        this.pc = "cleanup";
        this.backgroundPending = !this.published().background && this.backgroundRecords.some(r => this.files.has(this.blobPath(r.id)));
        break;
      case "remove": {
        const removed = ids.find(id => this.blobPath(diskID(id)) === operation.args[0]);
        // Before publication the obsolete entries still belong to the index;
        // keep this intent until publication instead of pretending cleanup ran
        // in the model's safe order. Missing bytes are immediately observable.
        if (removed && !this.published().items.includes(removed)) this.garbage = this.garbage.filter(id => id !== removed);
        if (!this.published().background) this.backgroundPending = this.backgroundRecords.some(r => this.files.has(this.blobPath(r.id)));
        break;
      }
    }
    // A successful publication records whether prior real removals have already
    // exhausted the cleanup work. This does not repair the earlier bad states.
    if (site === "index-rename") this.garbage = this.garbage.filter(id => this.files.has(this.blobPath(diskID(id))));
  }
}

// Exactly one entry for every TLA+ variable; no untagged JSON arrays.
function abstract(s: ReturnType<Fixture["snapshot"]>) {
  return {
    scenario: s.scenario, index: seq(s.index),
    blobs: fn(ids.map((id, i) => [id, s.blobs[i] === "bytesA" || s.blobs[i] === "bytesB" ? mv(s.blobs[i]) : s.blobs[i]])),
    queue: seq(s.queue), owner: s.owner,
    status: fn([1, 2].map((call, i) => [call, s.status[i]])), pc: s.pc,
    base: seq(s.base), loaded: seq(s.loaded), target: seq(s.target), garbage: seq(s.garbage),
    temporary: { ...s.temporary, items: seq(s.temporary.items) },
    failures: s.failures, failedAt: s.failedAt, protected: set(s.protected), background: s.background,
  };
}

async function main() {
  const runs = positiveInteger("INVARIANT_RUNS", 48);
  const steps = positiveInteger("INVARIANT_STEPS", 100);
  const seed = process.env.INVARIANT_SEED ?? "shared-library";
  const output = process.env.INVARIANT_TRACES;
  if (!output) throw new Error("INVARIANT_TRACES is required");
  const outputPath = path.resolve(output);
  const random = generator(seed);
  const originalCwd = process.cwd();
  const root = await real.mkdtemp(path.join(os.tmpdir(), "invariant-library-"));
  const originalNow = Date.now;
  const cryptoObject = globalThis.crypto;
  const originalRandom = Object.getOwnPropertyDescriptor(cryptoObject, "getRandomValues");
  const traces: ReturnType<typeof abstract>[][] = [];
  const observations: unknown[] = [];
  try {
    process.chdir(root);
    // Literal import is also the gate's existing-code dependency declaration.
    const firstRoute = await import("../../app/api/library/route.ts");
    for (const name of ["readFile", "mkdir", "writeFile", "rename", "rm"] as Operation[]) {
      (fs as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        const current = context.getStore();
        // Module loading and the final trace file are outside the route's ALS
        // context; every filesystem call made by a handler stays in memory.
        if (!current) return (real[name] as (...values: unknown[]) => unknown)(...args);
        if (current.reader) {
          try { return Promise.resolve(current.fixture.execute(name, args)); }
          catch (error) { return Promise.reject(error); }
        }
        return current.fixture.enqueue(current.call, name, args);
      };
    }
    Date.now = () => {
      const current = context.getStore();
      return current && !current.reader ? (current.call + 2) * 1000 : 0;
    };
    Object.defineProperty(cryptoObject, "getRandomValues", { configurable: true, value: (array: Uint8Array) => {
      const current = context.getStore();
      if (!current || current.reader || array.length !== 12 || current.fixture.generated.has(current.call)) {
        throw new Error("Unexpected randomness outside a bounded ID allocation");
      }
      current.fixture.generated.add(current.call);
      array.fill(0); array[array.length - 1] = current.call + 2;
      return array;
    } });
    for (let run = 0; run < runs; run++) {
      const fixture = new Fixture(scenarios[random(scenarios.length)], root, random);
      // Separate module instances give separate real promise chains. An
      // unfinished bounded prefix remains paused, with no timers/resources;
      // no extra request or extra failure is used to drain/reset that fixture.
      fixture.route = run === 0 ? firstRoute : await import(
        new URL(`../../app/api/library/route.ts?invariant_fixture=${run}`, import.meta.url).href
      );
      const trace = [abstract(fixture.snapshot())];
      for (let step = 1; step <= steps; step++) {
        fixture.step = step;
        // Try GETs in every state, including failed writes and missing blobs.
        // Mutations are never screened for safety; only the request-count
        // bound prevents a third mutation. Scheduler choices are reproducible.
        if (random(10) === 0) await fixture.get(random);
        else await fixture.advance(random);
        trace.push(abstract(fixture.snapshot()));
      }
      traces.push(trace);
      observations.push({ run, scenario: fixture.scenario, fault: fixture.fault, events: fixture.events });
    }
    await real.writeFile(outputPath, JSON.stringify({ traces }));
    await real.writeFile(`${outputPath}.observations.json`, JSON.stringify({ seed, runs, steps, observations }, null, 2));
    console.log(`Recorded ${runs} runs of ${steps} steps; seed=${seed}. Filesystem/response evidence: ${outputPath}.observations.json`);
  } finally {
    for (const name of ["readFile", "mkdir", "writeFile", "rename", "rm"] as Operation[]) {
      (fs as unknown as Record<string, unknown>)[name] = real[name];
    }
    Date.now = originalNow;
    if (originalRandom) Object.defineProperty(cryptoObject, "getRandomValues", originalRandom);
    else Reflect.deleteProperty(cryptoObject, "getRandomValues");
    process.chdir(originalCwd);
    await real.rm(root, { recursive: true, force: true });
  }
}

await main();
