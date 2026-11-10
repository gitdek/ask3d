import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./hook-loader.mjs", import.meta.url), {
  parentURL: import.meta.url,
  data: { hook: new URL("../../hooks/use-statue-task.ts", import.meta.url).href },
});
// The actual checked module, from invariant/05-statue-task-delivery in ask3d.
const { useStatueTask } = await import("../../hooks/use-statue-task.ts");

type Remote = "absent" | "active" | "fresh" | "old" | "failed";
type Delivery = { task: number; name: string };
type Request = {
  kind: string; task: number; settled: boolean; captured?: boolean; value?: any;
  resolve: (value?: any) => void; reject: (reason: Error) => void; promise: Promise<any>;
};
const errors = new Set(["start-error", "task-error", "download-error", "delivery-error", "poll-error"]);
const pendingRecovery = () => ({ state: "pending", task: 0, status: "absent" });
const noAdmission = () => ({ kind: "none", busy: false, cleared: false });

function deferred(kind: string, task = 0): Request {
  const r = { kind, task, settled: false } as Request;
  r.promise = new Promise((resolve, reject) => {
    r.resolve = value => { if (!r.settled) { r.settled = true; resolve(value); } };
    r.reject = error => { if (!r.settled) { r.settled = true; reject(error); } };
  });
  return r;
}

// The sidecar and its single localStorage slot survive a destroyed page.
class Sidecar {
  records = new Map<number, any>();
  storage = new Map<string, string>();
  library = new Map<string, number>();
  completed: Delivery[] = [];
  rejected = { task: 0, name: "", mount: 0 };
  cleared = new Set<number>();
  constructor(seed: Remote) { if (seed !== "absent") this.records.set(1, this.record(1, seed)); }
  record(id: number, state: Remote) {
    return { id: String(id), status: state === "active" ? "running" : state === "failed" ? "failed" : "succeeded",
      age_seconds: state === "old" ? 600 : 0, elapsed_seconds: 0,
      model_format: "stl", engine: "hunyuan", detail: "", error: "task-error" };
  }
  status(id: number): Remote {
    const r = this.records.get(id);
    return !r ? "absent" : ["running", "queued"].includes(r.status) ? "active"
      : r.status === "failed" ? "failed" : r.age_seconds < 600 ? "fresh" : "old";
  }
  latest() { return Math.max(0, ...this.records.keys()); }
  busy() { return [...this.records.keys()].some(id => this.status(id) === "active"); }
  finish(id: number, state: "fresh" | "failed") {
    // A worker can only finish an existing nonterminal task.
    if (this.status(id) === "active") this.records.set(id, this.record(id, state));
  }
  age(id: number) { if (this.status(id) === "fresh") this.records.get(id).age_seconds = 600; }
}

// Minimal React semantics: stable cells, dependency comparisons, batched state
// rerenders, and cleanup before an effect with changed dependencies is invoked.
// Ref setters only observe writes; they never reject or alter a hook write.
class Page {
  cells: any[] = [];
  refs: any[] = [];
  cursor = 0;
  effects: (() => void)[] = [];
  dirty = false;
  alive = true;
  api: ReturnType<typeof useStatueTask>;
  requests: Request[] = [];
  timers: { id: number; at: number; callback: () => void }[] = [];
  now = 0;
  serial = 0;
  currentLatest?: Request;
  waiting = "idle";
  observedTask = 0;
  observedName = "";
  pollFailures = 0;
  error = "";
  errorMessage: string | null = null;
  outcome = "none";
  admission = noAdmission();
  intent = "none";
  incomingTask = 0;
  inDismiss = false;
  deliveries: { request: Request; value: any }[] = [];
  onDeliver: (d: any) => Promise<void>;
  onError: (e: string | null) => void;
  world: World;
  number: number;

  constructor(world: World, number: number) {
    this.world = world;
    this.number = number;
    this.onDeliver = d => this.deliver(d);
    this.onError = e => this.reportError(e);
  }
  useState(initial: any) {
    const i = this.cursor++;
    if (!this.cells[i]) this.cells[i] = { value: initial, setter: (next: any) => {
      if (!this.alive) return;
      this.cells[i].value = typeof next === "function" ? next(this.cells[i].value) : next;
      this.dirty = true;
    } };
    return [this.cells[i].value, this.cells[i].setter];
  }
  useRef(initial: any) {
    const i = this.cursor++;
    if (!this.cells[i]) {
      const ordinal = this.refs.length;
      let current = initial;
      const ref = Object.defineProperty({}, "current", {
        get: () => current,
        set: value => {
          if (ordinal === 0 && value === true) {
            const kind = this.intent;
            this.admission = { kind, busy: current, cleared: kind === "recover" && this.world.server.cleared.has(this.incomingTask) };
            if (kind === "start") {
              this.observedTask = 0;
              this.observedName = "";
              this.pollFailures = 0;
              this.outcome = errors.has(this.outcome) ? "restarted" : "none";
            } else this.outcome = "none";
          }
          current = value;
          if (ordinal === 1 && value) {
            this.observedTask = Number(value.id);
            this.observedName = `${value.baseName}-statue-${value.id}.stl`;
            this.pollFailures = 0;
          }
        },
      });
      this.refs.push(ref);
      this.cells[i] = { ref };
    }
    return this.cells[i].ref;
  }
  changed(old: any, deps: any[]) { return !old || deps.length !== old.deps.length || deps.some((d, i) => !Object.is(d, old.deps[i])); }
  useCallback(fn: any, deps: any[]) {
    const i = this.cursor++;
    if (this.changed(this.cells[i], deps)) this.cells[i] = { fn, deps };
    return this.cells[i].fn;
  }
  useEffect(fn: any, deps: any[]) {
    const i = this.cursor++;
    if (this.changed(this.cells[i], deps)) {
      const old = this.cells[i];
      const cell = this.cells[i] = { deps, cleanup: undefined };
      this.effects.push(() => { old?.cleanup?.(); cell.cleanup = fn(); });
    }
  }
  render() {
    this.cursor = 0;
    this.dirty = false;
    this.api = useStatueTask({ onDeliver: this.onDeliver, onError: this.onError });
    for (const effect of this.effects.splice(0)) effect();
  }
  destroy() { for (const c of this.cells) c?.cleanup?.(); this.alive = false; this.timers = []; }
  request(kind: string, task = 0) {
    const r = deferred(kind, task);
    this.requests.push(r);
    if (kind === "health" || kind === "create") this.waiting = "starting";
    if (kind === "poll") this.waiting = "polling";
    if (kind === "download") this.waiting = "downloading";
    if (kind === "latest") this.currentLatest = r;
    return r.promise;
  }
  pending(kind: string) { return this.requests.find(r => r.kind === kind && !r.settled); }
  setTimeout(callback: () => void, ms: number) {
    const id = ++this.serial;
    this.timers.push({ id, at: this.now + ms, callback });
    this.waiting = "polling";
    return id;
  }
  tick() {
    this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const timer = this.timers.shift();
    if (timer) { this.now = timer.at; timer.callback(); }
  }
  reportError(message: string | null) {
    this.errorMessage = message;
    if (message === null) { this.error = ""; return; }
    const category = errors.has(message) ? message :
      /statue service|one-time install|photo-to-3D|already generating|already generating —|free GPU quota/.test(message) ? "start-error" : undefined;
    assert.ok(category, `Unclassified real onError message: ${message}`);
    this.error = category;
    this.outcome = category;
  }
  async deliver(value: any) {
    const request = deferred("delivery", Number(value.taskId));
    this.deliveries.push({ request, value });
    this.waiting = "delivering";
    this.observedTask = Number(value.taskId);
    this.observedName = value.name; // Actual callback arguments, never a desired name.
    try { await request.promise; }
    catch (error) {
      this.world.server.rejected = { task: Number(value.taskId), name: value.name, mount: this.number };
      throw error;
    }
    const server = this.world.server;
    // Rejection precedes this save (F2/B). A save replaces by kind and name.
    server.library.set(`statue:${value.name}`, Number(value.taskId));
    server.completed.push({ task: Number(value.taskId), name: value.name });
    this.outcome = server.cleared.has(Number(value.taskId)) ? "delivered-after-clear"
      : server.rejected.task === Number(value.taskId) ? "delivered-after-rejection" : "delivered";
  }
  recovery() {
    const r = this.currentLatest;
    if (!r?.captured) return pendingRecovery();
    const v = r.value;
    return { state: r.settled ? "done" : "ready", task: v ? Number(v.id) : 0,
      status: !v ? "absent" : ["queued", "running"].includes(v.status) ? "active"
        : v.status === "failed" ? "failed" : v.age_seconds < 600 ? "fresh" : "old" };
  }
}

class World {
  server: Sidecar;
  page: Page;
  trace: any[] = [];
  operations: string[] = [];
  constructor(seed: Remote = "absent") { this.server = new Sidecar(seed); this.page = new Page(this, 1); }
  connect() {
    const p = () => this.page;
    (globalThis as any).__statueHarness = {
      useState: (...a: any[]) => p().useState(a[0]),
      useRef: (...a: any[]) => p().useRef(a[0]),
      useCallback: (...a: any[]) => p().useCallback(a[0], a[1]),
      useEffect: (...a: any[]) => p().useEffect(a[0], a[1]),
      statueHealth: () => p().request("health"),
      createStatueTask: () => p().request("create"),
      fetchLatestStatueTask: () => p().request("latest"),
      pollStatueTask: (id: string) => p().request("poll", Number(id)),
      fetchStatueModel: (id: string) => p().request("download", Number(id)),
      getDismissedStatueTaskId: () => this.server.storage.get("dismissed") ?? null,
      setDismissedStatueTaskId: (id: string) => {
        this.server.storage.set("dismissed", id);
        if (p().inDismiss) this.server.cleared.add(Number(id));
      },
    };
    globalThis.setTimeout = ((fn: () => void, ms: number) => p().setTimeout(fn, ms)) as any;
    globalThis.clearTimeout = ((id: number) => { p().timers = p().timers.filter(t => t.id !== id); }) as any;
  }
  async settle() {
    // All dependencies stop at explicit deferred promises. Drain the finite
    // await/catch/finally chains, including batched React renders, without time.
    for (let i = 0; i < 32; i++) { await Promise.resolve(); if (this.page.dirty) this.page.render(); }
  }
  async init() { this.connect(); this.page.render(); await this.settle(); this.record(); return this; }
  read() {
    const p = this.page, s = this.server, last = p.refs[1].current;
    return {
      mount: p.number, sidecar: new Map([1, 2].map(t => [t, s.status(t)])),
      dismissed: Number(s.storage.get("dismissed") ?? 0), cleared: s.cleared,
      completed: s.completed, rejected: s.rejected,
      phase: p.cells[0].value === null ? "idle" : p.waiting,
      running: p.refs[0].current, task: p.observedTask,
      lastTask: last ? Number(last.id) : 0,
      lastName: last ? `${last.baseName}-statue-${last.id}.stl` : "",
      name: p.observedName, pollFailures: p.pollFailures, error: p.error,
      recovery: p.recovery(), admission: p.admission, outcome: p.outcome,
    };
  }
  record() { this.trace.push(abstract(this.read())); }
  async step(op: string) {
    const p = this.page, s = this.server;
    this.operations.push(op);
    switch (op) {
      case "start":
        p.intent = "start";
        void p.api.start({ images: [], engine: "hunyuan", sourceName: "source.png", sourcePath: "/source.png" });
        break;
      case "health":
        p.pending("health")?.resolve({ engines: { hunyuan: true, space: true }, busy: s.busy() });
        break;
      case "health-off": p.pending("health")?.resolve(null); break;
      case "engine-off": p.pending("health")?.resolve({ engines: {}, busy: false }); break;
      case "create": {
        const r = p.pending("create");
        if (r && s.busy()) r.reject(new Error("already being generated"));
        else if (r && s.latest() < 2) { // Only the task bound can suppress creation.
          const id = s.latest() + 1;
          s.records.set(id, s.record(id, "active"));
          r.resolve(String(id));
        }
        break;
      }
      case "start-fail": (p.pending("health") ?? p.pending("create"))?.reject(new Error("start-error")); break;
      case "quota-fail": p.pending("create")?.reject(new Error("ZeroGPU quota")); break;
      case "capture": case "capture-cancelled": {
        const r = op === "capture" ? p.currentLatest : p.requests.find(r => r.kind === "latest" && r !== p.currentLatest && !r.settled && !r.captured);
        if (r && !r.captured && !r.settled) {
          r.value = s.records.has(s.latest()) ? { ...s.records.get(s.latest()) } : null;
          r.captured = true;
        }
        break;
      }
      case "receive": case "receive-cancelled": {
        const r = op === "receive" ? p.currentLatest : p.requests.find(r => r.kind === "latest" && r !== p.currentLatest && r.captured && !r.settled);
        if (r?.captured && !r.settled) {
          p.intent = "recover";
          p.incomingTask = Number(r.value?.id ?? 0);
          r.resolve(r.value); // No receipt/history/busy checks in the stub.
        }
        break;
      }
      case "refresh":
        p.onError = e => p.reportError(e);
        p.render();
        break;
      case "clear": p.inDismiss = true; p.api.dismiss(); p.inDismiss = false; break;
      case "reload":
        if (p.number < 2) { p.destroy(); this.page = new Page(this, p.number + 1); this.page.render(); }
        break;
      case "finish1": case "finish2": s.finish(Number(op.at(-1)), "fresh"); break;
      case "fail1": case "fail2": s.finish(Number(op.at(-1)), "failed"); break;
      case "age1": case "age2": s.age(Number(op.at(-1))); break;
      case "tick": p.tick(); break;
      case "poll": case "poll-fail": {
        p.tick();
        await this.settle();
        const r = p.pending("poll");
        if (r) {
          if (op === "poll-fail") { p.pollFailures++; r.reject(new Error("poll-error")); }
          else { p.pollFailures = 0; r.resolve({ ...s.records.get(r.task) }); }
        }
        break;
      }
      case "download": p.pending("download")?.resolve(new ArrayBuffer(4)); break;
      case "download-fail": p.pending("download")?.reject(new Error("download-error")); break;
      case "complete": case "reject": {
        const d = p.deliveries.find(d => !d.request.settled);
        if (d) op === "complete" ? d.request.resolve() : d.request.reject(new Error("delivery-error"));
        break;
      }
      case "wait": break;
      default: throw new Error(`Unknown operation ${op}`);
    }
    await this.settle();
    this.page.intent = "none";
    this.record();
  }
  async script(ops: string[]) { for (const op of ops) await this.step(op); }
}

// Every recorded value is a read of a stub's actual storage, React cell/ref,
// outstanding operation, or observation of a callback/write; no model runner.
function abstract(value: any): any {
  if (value instanceof Map) return { $fn: [...value].map(([k, v]) => [abstract(k), abstract(v)]) };
  if (value instanceof Set) return { $set: [...value].sort().map(abstract) };
  if (Array.isArray(value)) return { $seq: value.map(abstract) };
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, abstract(v)]));
  return value;
}

const traces: any[][] = [];
const coverage: Record<string, any> = {};
const create = ["start", "health", "create"];
const deliver = ["poll", "download", "complete"];
async function direct(label: string, seed: Remote, operations: string[], check?: (w: World) => void) {
  const w = await new World(seed).init();
  await w.script(operations);
  check?.(w);
  traces.push(w.trace);
  coverage[label] = { steps: operations.length, completed: w.server.completed.length };
  w.page.destroy();
}

function rng(seed: string) {
  let x = 2166136261;
  for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  return () => { x += 0x6d2b79f5; let t = x; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function countEnv(name: string) {
  const n = Number(process.env[name]);
  assert.ok(Number.isSafeInteger(n) && n >= 0, `${name} must be a nonnegative integer`);
  return n;
}

const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
try {
  await direct("CanSkipCompletedOnReload", "absent", [...create, "finish1", ...deliver, "reload", "capture", "receive"], w => {
    const s = w.read();
    assert.equal(s.completed.length, 1);
    assert.equal(s.mount, 2);
    assert.equal(s.phase, "idle"); assert.equal(s.lastTask, 0);
    assert.deepEqual(s.recovery, { state: "done", task: 1, status: "fresh" });
    assert.equal(s.dismissed, 1); assert.equal(s.cleared.size, 0);
  });
  await direct("CanRecoverSecondStatue", "fresh", ["capture", "receive", ...deliver,
    ...create, "reload", "finish2", "capture", "receive", ...deliver], w => {
    assert.equal(w.page.number, 2);
    assert.deepEqual(w.server.completed, [{ task: 1, name: "recovered-statue-1.stl" }, { task: 2, name: "recovered-statue-2.stl" }]);
    assert.equal(w.server.library.size, 2);
  });
  await direct("CanRetryRejectedAfterReload", "fresh", ["capture", "receive", "poll", "download", "reject",
    "reload", "capture", "receive", ...deliver], w => {
    assert.equal(w.page.outcome, "delivered-after-rejection");
    assert.equal(w.server.completed.length, 1);
    assert.equal(w.server.rejected.mount, 1); assert.equal(w.page.number, 2);
  });
  await direct("CanRetryRejectedOnSamePage", "absent", [...create, "finish1", "poll", "download", "reject",
    "refresh", "capture", "receive", ...deliver], w => {
    assert.equal(w.page.outcome, "delivered-after-rejection");
    assert.equal(w.server.completed.length, 1); assert.equal(w.page.number, 1);
    assert.equal(w.server.rejected.mount, 1);
    assert.equal(w.server.completed[0].name, "source-statue-1.stl");
    assert.equal(w.server.rejected.name, w.server.completed[0].name);
  });
  await direct("CanDeliverAfterClear", "fresh", ["capture", "receive", "clear", ...deliver, "reload", "capture", "receive"], w => {
    assert.equal(w.server.completed.length, 1); assert.equal(w.server.cleared.has(1), true);
    assert.equal(w.page.refs[0].current, false);
  });
  // Direct failure and busy-guard checks supplement (never replace) random runs.
  for (const failure of ["start", "task", "download", "delivery", "poll"]) {
    const ops = failure === "start" ? ["start", "start-fail"] : [...create,
      ...(failure === "task" ? ["fail1", "poll"]
        : failure === "poll" ? Array(5).fill("poll-fail")
        : ["finish1", "poll", ...(failure === "download" ? ["download-fail"] : ["download", "reject"])])];
    await direct(`release-${failure}`, "absent", [...ops, "start"], w => {
      assert.equal(w.page.outcome, "restarted"); assert.equal(w.read().phase, "starting");
      assert.equal(w.read().running, true);
    });
  }
  await direct("busy-and-cancelled-recovery", "fresh", ["capture", "start", "receive", "health", "create",
    "start", "refresh", "capture", "refresh", "receive-cancelled", "finish2", "poll", "start", "download", "start", "complete"]);

  const random = rng(process.env.INVARIANT_SEED ?? "0");
  const choose = <T>(values: T[]): T => values[Math.floor(random() * values.length)];
  const operations = ["start", "start", "health", "health", "create", "create", "start-fail", "health-off", "engine-off", "quota-fail",
    "capture", "capture", "receive", "receive", "capture-cancelled", "receive-cancelled", "refresh", "clear", "reload",
    "finish1", "finish2", "fail1", "fail2", "age1", "age2", "tick", "poll", "poll", "poll-fail", "poll-fail",
    "download", "download", "download-fail", "complete", "complete", "reject", "wait"];
  for (let run = 0, runs = countEnv("INVARIANT_RUNS"), steps = countEnv("INVARIANT_STEPS"); run < runs; run++) {
    const w = await new World(choose<Remote>(["absent", "active", "fresh", "old", "failed"])).init();
    for (let i = 0; i < steps; i++) await w.step(choose(operations));
    traces.push(w.trace);
    w.page.destroy();
  }

  // Delay a real latest response across two completed callbacks. This checks
  // the history contract when the single stored receipt has since changed.
  await direct("delayed-latest-across-receipts", "fresh", ["capture", "receive", ...deliver,
    "refresh", "capture", ...create, "finish2", ...deliver, "receive", ...deliver]);
  assert.ok(process.env.INVARIANT_TRACES, "INVARIANT_TRACES is required");
  writeFileSync(process.env.INVARIANT_TRACES!, JSON.stringify({ traces }));
  console.log(JSON.stringify({ direct: coverage, randomRuns: countEnv("INVARIANT_RUNS"), steps: countEnv("INVARIANT_STEPS"), seed: process.env.INVARIANT_SEED }));
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete (globalThis as any).__statueHarness;
}
