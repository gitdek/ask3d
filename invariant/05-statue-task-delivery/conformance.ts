import { register } from "node:module";
import { writeFileSync } from "node:fs";

// The gate places this project at invariant/05-statue-task-delivery.
// Import the original module, never a copied or reimplemented hook.
register(new URL("./conformance-loader.mjs", import.meta.url), import.meta.url);
const { useStatueTask } = await import("../../hooks/use-statue-task.ts");

type Remote = "absent" | "active" | "fresh" | "old" | "failed";
type Delivery = { task: number; name: string };
type Exit = "none" | "restarted" | "delivered" | "delivered-after-clear" |
  "delivered-after-rejection" | "start-error" | "task-error" |
  "download-error" | "delivery-error" | "poll-error";
const errors = new Set<Exit>(["start-error", "task-error", "download-error", "delivery-error", "poll-error"]);

class Deferred<T> {
  pending = true;
  promise: Promise<T>;
  private fulfill!: (value: T) => void;
  private rejectPromise!: (error: Error) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.fulfill = resolve;
      this.rejectPromise = reject;
    });
  }
  resolve(value: T) {
    if (!this.pending) return;
    this.pending = false;
    this.fulfill(value);
  }
  reject(message: string) {
    if (!this.pending) return;
    this.pending = false;
    this.rejectPromise(new Error(message));
  }
}

class Clock {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delay: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  }
  tick() {
    // Attempt the next scheduled worker wakeup even when there is no work.
    const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) return;
    this.now = next[1].at;
    this.timers.delete(next[0]);
    next[1].callback();
  }
}

// Sidecar and localStorage are the authorized in-memory boundary substitutes.
// The server controls age_seconds independently of the browser's sleep clock.
class Sidecar {
  records = new Map<number, any>();
  constructor(seed: Remote) {
    if (seed !== "absent") this.records.set(1, this.record(1, seed));
  }
  record(id: number, status: Remote) {
    return { id: String(id), status: status === "active" ? "running" :
      status === "failed" ? "failed" : "succeeded",
      age_seconds: status === "old" ? 600 : 0, elapsed_seconds: 0,
      model_format: "stl", engine: "space", error: "task-error" };
  }
  state(id: number): Remote {
    const r = this.records.get(id);
    return !r ? "absent" : r.status === "running" || r.status === "queued" ? "active" :
      r.status === "failed" ? "failed" : r.age_seconds < 600 ? "fresh" : "old";
  }
  busy() { return [...this.records.keys()].some(id => this.state(id) === "active"); }
  latest() {
    const r = this.records.get(this.records.size);
    return r ? { ...r } : null;
  }
  create() {
    if (this.busy()) throw new Error("already being generated");
    if (this.records.size >= 2) throw new Error("driver exceeded MaxTasks");
    const id = this.records.size + 1;
    this.records.set(id, this.record(id, "active"));
    return String(id);
  }
  finish(id: number, failed: boolean) {
    // A worker's terminal update is idempotent; it cannot create a task.
    if (this.state(id) !== "active") return;
    this.records.set(id, this.record(id, failed ? "failed" : "fresh"));
  }
  age(id: number) {
    const r = this.records.get(id);
    if (r?.status === "succeeded") r.age_seconds = 600;
  }
}

class World {
  sidecar: Sidecar;
  storage = new Map<string, string>();
  cleared = new Set<number>();
  completed: Delivery[] = [];
  rejected: Delivery = { task: 0, name: "" };
  library = new Map<string, { taskId: string; model: ArrayBuffer }>();
  mount = 0;
  page!: Page;
  constructor(seed: Remote) { this.sidecar = new Sidecar(seed); this.reload(); }
  reload() {
    if (this.mount >= 2) return; // MaxMounts is the only reload bound.
    this.page?.dispose();
    this.mount++;
    this.page = new Page(this);
    activePage = this.page;
    this.page.render();
  }
}

let activePage: Page;
let rendering: Page | undefined;
const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

class Page {
  slots: any[] = [];
  refs: any[] = [];
  cursor = 0;
  effects: (() => void)[] = [];
  dirty = false;
  disposed = false;
  api: ReturnType<typeof useStatueTask>;
  clock = new Clock();
  health?: Deferred<any>;
  latest = new Deferred<any>();
  captured = false;
  latestResponse: any = null;
  model?: Deferred<ArrayBuffer>;
  delivery?: { payload: any; result: Deferred<void> };
  pollReject = false;
  createReject = "";
  // These are observations of real boundary calls, not a predicted machine.
  polls: boolean[] = [];
  adopted?: { taskId: string; baseName: string; settled: boolean };
  startingInput: any;
  acceptedInput: any;
  observedName = "";
  error = "";
  errorMessages: (string | null)[] = [];
  admission = { kind: "none", busy: false, cleared: false };
  outcome: Exit = "none";
  unexpected: unknown[] = [];

  readonly world: World;
  constructor(world: World) { this.world = world; }

  // Stable callback identities for a whole mount, as required by the model.
  onError = (message: string | null) => {
    this.errorMessages.push(message);
    if (message === null) { this.error = ""; return; }
    const category: Exit = errors.has(message as Exit) ? message as Exit : "start-error";
    this.error = category;
    this.outcome = category;
  };
  onDeliver = (payload: any) => {
    const result = new Deferred<void>();
    this.delivery = { payload, result };
    this.observedName = payload.name;
    return result.promise.then(() => {
      const record = { task: Number(payload.taskId), name: payload.name };
      // Fulfillment is the commit point. Rejection below never saves anything.
      this.world.library.set(`statue:${payload.name}`, { taskId: payload.taskId, model: payload.model });
      this.world.completed.push(record);
      this.outcome = this.world.cleared.has(record.task) ? "delivered-after-clear" :
        this.world.rejected.task === record.task && this.world.rejected.name === record.name ?
          "delivered-after-rejection" : "delivered";
    }, error => {
      this.world.rejected = { task: Number(payload.taskId), name: payload.name };
      throw error;
    });
  };

  render() {
    this.cursor = 0;
    this.dirty = false;
    rendering = this;
    this.api = useStatueTask({ onDeliver: this.onDeliver, onError: this.onError });
    rendering = undefined;
    for (const run of this.effects.splice(0)) run();
  }
  dispose() {
    this.disposed = true;
    for (const slot of this.slots) slot.cleanup?.();
    // Reload destroys the page's JS: outstanding promises remain unresolved.
    this.clock.timers.clear();
  }
  get running() { return this.refs[0].current; }
  get lastTask() { return Number(this.refs[1].current ?? 0); }
  get task() { return Number(this.adopted?.taskId ?? 0); }
  get phase() {
    if (this.health?.pending) return "starting";
    if (this.model?.pending) return "downloading";
    if (this.delivery?.result.pending) return "delivering";
    if (this.adopted && !this.adopted.settled) return "polling";
    return "idle";
  }
  get pollFailures() {
    let count = 0;
    for (let i = this.polls.length - 1; i >= 0 && !this.polls[i]; i--) count++;
    return count;
  }
  captureLatest() {
    if (!this.latest.pending || this.captured) return;
    this.latestResponse = this.world.sidecar.latest();
    this.captured = true;
  }
  receiveLatest() {
    // No result can be received before a server response has been captured.
    if (this.captured) this.latest.resolve(this.latestResponse);
  }
}

const react = {
  useState(initial: any) {
    const p = rendering!, i = p.cursor++;
    if (!p.slots[i]) p.slots[i] = { value: typeof initial === "function" ? initial() : initial };
    const slot = p.slots[i];
    return [slot.value, (value: any) => {
      slot.value = typeof value === "function" ? value(slot.value) : value;
      p.dirty = true;
    }];
  },
  useRef(initial: any) {
    const p = rendering!, i = p.cursor++;
    if (!p.slots[i]) {
      let value = initial;
      const isGuard = p.refs.length === 0;
      const ref = {
        get current() { return value; },
        set current(next: any) {
          if (isGuard && next === true) {
            const isStart = p.startingInput !== undefined;
            p.admission = { kind: isStart ? "start" : "recover", busy: value,
              cleared: !isStart && p.world.cleared.has(Number(p.latestResponse?.id)) };
            p.outcome = isStart && errors.has(p.outcome) ? "restarted" : "none";
            if (isStart) {
              p.acceptedInput = p.startingInput;
              p.adopted = undefined;
              p.polls = [];
              // Before adoption, name denotes the observed start argument.
              p.observedName = `${p.acceptedInput.sourceName.replace(/\.[^.]*$/, "")}-statue.stl`;
            }
          }
          value = next;
        },
      };
      p.slots[i] = { ref };
      p.refs.push(ref);
    }
    return p.slots[i].ref;
  },
  useCallback(callback: (...args: any[]) => any, deps: unknown[]) {
    const p = rendering!, i = p.cursor++;
    if (!p.slots[i] || !sameDeps(p.slots[i].deps, deps)) {
      // Observe the hook's actual private callback arguments, without changing
      // their values, result, rejection, or invocation order.
      const wrapped = (...args: any[]) => {
        if (i === 3) { // adoptStatueTask, after state and the two refs
          const adopted = { taskId: args[0], baseName: args[1], settled: false };
          p.adopted = adopted;
          p.observedName = `${adopted.baseName}-statue.stl`;
          p.polls = [];
          const result = callback(...args);
          result.then(() => { adopted.settled = true; }, () => { adopted.settled = true; });
          return result;
        }
        if (i === 4) { // start: the hook itself decides whether to accept
          p.startingInput = args[0];
          try { return callback(...args); } finally { p.startingInput = undefined; }
        }
        return callback(...args);
      };
      p.slots[i] = { callback: wrapped, deps };
    }
    return p.slots[i].callback;
  },
  useEffect(effect: () => (() => void), deps: unknown[]) {
    const p = rendering!, i = p.cursor++;
    if (!p.slots[i] || !sameDeps(p.slots[i].deps, deps)) {
      const prior = p.slots[i];
      const slot = p.slots[i] = { deps, cleanup: undefined as undefined | (() => void) };
      p.effects.push(() => { prior?.cleanup?.(); slot.cleanup = effect(); });
    }
  },
};

const statue = {
  statueHealth() { return (activePage.health = new Deferred<any>()).promise; },
  async createStatueTask() {
    if (activePage.createReject) throw new Error(activePage.createReject);
    return activePage.world.sidecar.create();
  },
  fetchLatestStatueTask() { return activePage.latest.promise; },
  async pollStatueTask(taskId: string) {
    const p = activePage;
    p.polls.push(!p.pollReject);
    if (p.pollReject) throw new Error("poll-error");
    const status = p.world.sidecar.records.get(Number(taskId));
    if (!status) throw new Error("poll requested nonexistent task");
    return { ...status };
  },
  fetchStatueModel() { return (activePage.model = new Deferred<ArrayBuffer>()).promise; },
  getDismissedStatueTaskId() { return activePage.world.storage.get("dismissed-statue-task") ?? null; },
  setDismissedStatueTaskId(taskId: string) {
    activePage.world.storage.set("dismissed-statue-task", taskId);
    activePage.world.cleared.add(Number(taskId));
  },
};

(globalThis as any).__statueConformance = { react, statue };
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((callback: () => void, delay: number) => activePage.clock.setTimeout(callback, delay)) as any;
globalThis.clearTimeout = ((id: number) => activePage.clock.timers.delete(id)) as any;

// Only native promise microtasks and React renders run here. No real clock,
// network, sleeps, or old-page promise continuations are involved.
async function settle() {
  for (let i = 0; i < 24; i++) {
    await Promise.resolve();
    if (activePage.dirty) activePage.render();
  }
}

function abstract(w: World) {
  const p = w.page, r = p.latestResponse;
  const status: Remote = !r ? "absent" : r.status === "queued" || r.status === "running" ? "active" :
    r.status === "failed" ? "failed" : r.age_seconds < 600 ? "fresh" : "old";
  return {
    mount: w.mount,
    sidecar: { $fn: [1, 2].map(t => [t, w.sidecar.state(t)]) },
    dismissed: Number(w.storage.get("dismissed-statue-task") ?? 0),
    cleared: { $set: [...w.cleared].sort() },
    completed: { $seq: w.completed.map(record => ({ ...record })) },
    rejected: { ...w.rejected },
    phase: p.phase, running: p.running, task: p.task, lastTask: p.lastTask,
    name: p.observedName, pollFailures: p.pollFailures, error: p.error,
    recovery: { state: !p.latest.pending ? "done" : p.captured ? "ready" : "pending",
      task: Number(r?.id ?? 0), status },
    admission: { ...p.admission }, outcome: p.outcome,
  };
}

type Operation = { kind: string; arg?: number };
async function perform(w: World, op: Operation) {
  const p = w.page, arg = op.arg ?? 0;
  switch (op.kind) {
    case "start":
      // Always call, including while busy, downloading, or delivering.
      p.api.start({ images: [], engine: arg % 2 ? "hunyuan" : "space",
        sourceName: arg < 2 ? "source.png" : "recovered.png", sourcePath: "/memory/input.png" })
        .catch(error => p.unexpected.push(error));
      break;
    case "create":
      if (w.sidecar.records.size >= 2) break; // MaxTasks, not a hook-state filter.
      p.createReject = "";
      p.health?.resolve({ busy: w.sidecar.busy(), engines: { space: true, hunyuan: true } });
      break;
    case "start-error":
      p.createReject = arg % 2 ? "ZeroGPU quota" : "already being generated";
      if (arg % 3 === 0) p.health?.reject("start-error");
      else if (arg % 3 === 1) p.health?.resolve(null);
      else p.health?.resolve({ busy: false, engines: { space: true, hunyuan: true } });
      break;
    case "read": p.captureLatest(); break;
    case "receive": p.receiveLatest(); break;
    case "finish": w.sidecar.finish(1 + arg % 2, false); break;
    case "task-error": w.sidecar.finish(1 + arg % 2, true); break;
    case "age": w.sidecar.age(1 + arg % 2); break;
    case "poll": case "poll-error":
      p.pollReject = op.kind === "poll-error";
      p.clock.tick();
      break;
    case "download": p.model?.resolve(new ArrayBuffer(8)); break;
    case "download-error": p.model?.reject("download-error"); break;
    case "deliver":
      if (w.completed.length >= 3) break; // TypeOK's explicit observation bound.
      p.delivery?.result.resolve(undefined);
      break;
    case "delivery-error": p.delivery?.result.reject("delivery-error"); break;
    case "clear": p.api.dismiss(); break;
    case "reload": w.reload(); break;
    case "wait": break;
    default: throw new Error(`Unknown operation ${op.kind}`);
  }
  await settle();
  if (p.unexpected.length) throw p.unexpected[0];
}

function generator(seed: string) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return (limit: number) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) % limit;
  };
}

const runs = Number(process.env.INVARIANT_RUNS ?? 100);
const steps = Number(process.env.INVARIANT_STEPS ?? 200);
const seed = process.env.INVARIANT_SEED ?? "27";
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(steps) || steps < 1)
  throw new Error("INVARIANT_RUNS and INVARIANT_STEPS must be positive integers");
if (!process.env.INVARIANT_TRACES) throw new Error("INVARIANT_TRACES is required");

// Fixed weights, independent of hook state. Every operation remains possible
// at every step; attempted starts and worker operations are never prefiltered.
const operations = [
  ...Array(6).fill("start"), ...Array(9).fill("create"), ...Array(6).fill("read"),
  ...Array(6).fill("receive"), ...Array(9).fill("finish"), ...Array(12).fill("poll"),
  ...Array(9).fill("download"), ...Array(9).fill("deliver"),
  "task-error", "age", "start-error", "download-error", "delivery-error",
  "clear", "reload", "wait", ...Array(3).fill("poll-error"),
];
const random = generator(seed);
const traces: ReturnType<typeof abstract>[][] = [];
const evidence: any[] = [];
try {
  for (let run = 0; run < runs; run++) {
    const seeds: Remote[] = ["absent", "active", "fresh", "old", "failed"];
    const w = new World(seeds[random(seeds.length)]);
    const trace = [abstract(w)];
    for (let step = 0; step < steps; step++) {
      const op = { kind: operations[random(operations.length)], arg: random(4) };
      const before = trace[trace.length - 1];
      await perform(w, op);
      const after = abstract(w);
      trace.push(after);
      if (after.completed.$seq.length > before.completed.$seq.length) {
        const newest = after.completed.$seq[after.completed.$seq.length - 1];
        const prior = before.completed.$seq;
        if (prior.some(d => d.task === newest.task)) evidence.push({
          violation: "DeliveredAtMostOnce", run, step: step + 1, op, before, after,
        });
        if (prior.some(d => d.task !== newest.task && d.name === newest.name)) evidence.push({
          violation: "NamesNeverReplace", run, step: step + 1, op, before, after,
        });
      }
    }
    traces.push(trace);
    w.page.dispose();
  }
  writeFileSync(process.env.INVARIANT_TRACES, JSON.stringify({ traces }));
  // Evidence is read from actual callback commits, with reproducible locations.
  console.log(JSON.stringify({ seed, runs, steps, violations: evidence }));
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
