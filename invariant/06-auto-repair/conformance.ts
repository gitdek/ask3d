import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import * as React from "react";

// Resolve the package's bundler-style TypeScript imports under plain Node.
// Only the checked hook is included in the supplied source snapshot. Use
// explicit doubles for missing utilities; prefer real modules when present.
const support = new URL("./conformance-support.ts", import.meta.url).href;
const missingUtilities = new Set([
  "../../lib/ai/system-prompt", "../../lib/scad/extract", "../../lib/scad/components",
].map(path => new URL(path, import.meta.url).href));
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".")) throw error;
      for (const suffix of [".ts", "/index.ts"]) {
        try { return nextResolve(specifier + suffix, context); }
        catch (candidateError) {
          if ((candidateError as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw candidateError;
        }
      }
      const resolved = new URL(specifier, context.parentURL).href.replace(/\.ts$/, "");
      if (missingUtilities.has(resolved)) return nextResolve(support, context);
      throw error;
    }
  },
});
const { useAutoRepair, MAX_REPAIR_ATTEMPTS } = await import("../../hooks/use-auto-repair.ts");
const { extractLastScadBlock } = await import("../../lib/scad/extract.ts");
const { analyzeStlComponents } = await import("../../lib/scad/components.ts");

type Options = Parameters<typeof useAutoRepair>[0];
type Success = NonNullable<Options["result"]>;
type Failure = NonNullable<Options["failure"]>;
type Signal = "good" | "debris" | "empty" | "code" | "timeout" | "environment";
type Phase = "idle" | "compiling" | "repairing" | "accepted" | "error";
type Call = "compile" | "cancel" | "sendRepair" | "showError" | "clearError" | "onModel" | "onAccepted";
type Input = Signal | "initial" | "human" | "reply" | "noCode" | "nullReply" | "replace" | "expect" | "retry";
type Dependencies = readonly unknown[] | undefined;
type Cell = { kind: string; value: any; deps?: Dependencies; setter?: (value: any) => void };
const sources = ["cube(20);", "sphere(10);", "cylinder(h=20,r=5);"] as const;
const signals: Signal[] = ["good", "debris", "empty", "code", "timeout", "environment"];
const blankCore = ["idle", null, null, null, false, 0, 0, 0, false, null];

// React 19's public hook functions delegate to H. Supplying that dispatcher
// runs the imported, unmodified hook while exposing the storage it owns.
// No source rewriting, copied hook logic, timers, DOM, or compiler process.
class HookHost {
  cells: Cell[] = [];
  cursor = 0;
  dirty = true;
  effects: (() => void)[] = [];
  api!: ReturnType<typeof useAutoRepair>;
  options!: Options;
  dispatcher = {
    useState: (initial: any) => {
      const cell = this.cell("state", () => typeof initial === "function" ? initial() : initial);
      cell.setter ??= (value: any) => {
        const next = typeof value === "function" ? value(cell.value) : value;
        if (!Object.is(cell.value, next)) { cell.value = next; this.dirty = true; }
      };
      return [cell.value, cell.setter];
    },
    useRef: (initial: any) => this.cell("ref", () => ({ current: initial })).value,
    useCallback: (callback: any, deps: Dependencies) => {
      const cell = this.cell("callback", () => undefined);
      if (!this.sameDeps(cell.deps, deps)) { cell.value = callback; cell.deps = deps; }
      return cell.value;
    },
    useEffect: (effect: () => void, deps: Dependencies) => {
      const cell = this.cell("effect", () => undefined);
      if (!this.sameDeps(cell.deps, deps)) {
        cell.deps = deps;
        this.effects.push(() => {
          if (typeof cell.value === "function") cell.value();
          cell.value = effect();
        });
      }
    },
  };
  cell(kind: string, initial: () => any): Cell {
    const index = this.cursor++;
    const cell = this.cells[index] ??= { kind, value: initial() };
    if (cell.kind !== kind) throw new Error(`Hook order changed at ${index}`);
    return cell;
  }
  sameDeps(a: Dependencies, b: Dependencies): boolean {
    return !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  }
  settle(): void {
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    if (!internals || !("H" in internals)) throw new Error("Expected the package's React 19 dispatcher");
    for (let renders = 0; ; renders++) {
      if (renders > 100) throw new Error("React effects did not settle");
      this.dirty = false;
      this.cursor = 0;
      const previous = internals.H;
      internals.H = this.dispatcher;
      try { this.api = useAutoRepair(this.options); }
      finally { internals.H = previous; }
      const effects = this.effects.splice(0);
      for (const effect of effects) effect();
      if (!this.dirty) return;
    }
  }
  ref(name: "count" | "latest" | "cached" | "pending"): any {
    // These are the nine useRef calls in the real hook, in declaration order.
    // The driver reads four. It keeps its own account of the rest: the
    // current program, the viewer, the repairs sent and what was handled.
    const names = ["count", "sent", "current", "latest", "cached", "shown", "pending", "handled", "status"];
    const refs = this.cells.filter(cell => cell.kind === "ref");
    if (refs.length !== names.length) throw new Error("Update the storage adapter for the hook's new ref layout");
    return refs[names.indexOf(name)].value.current;
  }
}

type Point = [number, number, number];
type Triangle = [Point, Point, Point];
function mesh(withDebris: boolean): ArrayBuffer {
  const triangles: Triangle[] = [];
  // Subdivide a closed, plate-touching cube. Shared vertices have exact
  // coordinates; a tiny, elevated tetrahedron is a disconnected fragment.
  for (let axis = 0; axis < 3; axis++) for (const side of [0, 20]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const point = (i: number, j: number): Point => {
      const p: Point = [0, 0, 0]; p[axis] = side; p[u] = i * 2.5; p[v] = j * 2.5; return p;
    };
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      const a = point(i, j), b = point(i + 1, j), c = point(i + 1, j + 1), d = point(i, j + 1);
      triangles.push(...(side === 20 ? [[a, b, c], [a, c, d]] : [[a, c, b], [a, d, c]]) as Triangle[]);
    }
  }
  if (withDebris) {
    const a: Point = [50, 50, 50], b: Point = [51, 50, 50], c: Point = [50, 51, 50], d: Point = [50, 50, 51];
    triangles.push([a, c, b], [a, b, d], [a, d, c], [b, c, d]);
  }
  const buffer = new ArrayBuffer(84 + 50 * triangles.length);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, i) => triangle.flat().forEach((n, j) => view.setFloat32(84 + i * 50 + 12 + j * 4, n, true)));
  return buffer;
}
const geometry = { good: mesh(false), debris: mesh(true), empty: new ArrayBuffer(84) };
if (MAX_REPAIR_ATTEMPTS !== 2) throw new Error("The ratified repair bound is two");
if (analyzeStlComponents(geometry.good).debrisCount !== 0 || analyzeStlComponents(geometry.debris).debrisCount < 1)
  throw new Error("STL fixtures do not exercise their declared geometry outcomes");

type Delivery = { kind: Signal; object: Success | Failure };
type Observation = {
  input: Input; source: string | null; pendingBefore: boolean; duplicate: boolean;
  target: string | null; calls: Call[]; before: unknown[];
};
type State = {
  phase: Phase; current: string | null; latest: string | null; cached: string | null;
  visible: boolean; attempt: number; count: number; sent: number; pending: boolean;
  retrySource: string | null; observation: Observation;
};
const core = (s: State): unknown[] => [s.phase, s.current, s.latest, s.cached, s.visible, s.attempt, s.count, s.sent, s.pending, s.retrySource];

class Driver {
  host = new HookHost();
  phase: Phase = "idle";
  // The spec explicitly includes the caller's current input, viewer, callback
  // log and identity ledger alongside the hook's own state and refs.
  current: string | null = null;
  viewer: Success | null = null;
  error: Parameters<Options["showError"]>[0] = null;
  errorSource: string | null = null;
  repairs: string[] = [];
  calls: Call[] = [];
  compileRequests: { source: string; options?: { timeoutMs?: number } }[] = [];
  accepted: Success[] = [];
  lintFault = false;
  handled = new WeakSet<object>();
  deliveries: Delivery[] = [];
  active: Delivery | null = null;
  observation: Observation = { input: "initial", source: null, pendingBefore: false, duplicate: false, target: null, calls: [], before: blankCore };

  constructor() {
    this.host.options = { status: "ready", reply: null, result: null, failure: null, ...this.callbacks() };
    this.settle();
    if (this.calls.length) throw new Error("Unexpected callback on mount");
  }
  callbacks(): Pick<Options, "compile" | "cancel" | "lint" | "sendRepair" | "showError" | "onModel" | "onAccepted"> {
    return {
      compile: (source, options) => {
        this.calls.push("compile"); this.compileRequests.push({ source, options });
        this.current = source; this.phase = "compiling";
      },
      cancel: () => { this.calls.push("cancel"); this.current = null; this.phase = "idle"; },
      lint: () => this.lintFault ? [{ message: "Synthetic lint fault", line: 1 }] : [],
      sendRepair: text => { this.calls.push("sendRepair"); this.repairs.push(text); this.phase = "repairing"; },
      showError: error => {
        this.calls.push(error ? "showError" : "clearError");
        this.error = error;
        // The retry closure is created for the failure being delivered.
        this.errorSource = error?.retry ? this.active?.object.source ?? null : null;
        if (error) this.phase = "error";
      },
      onModel: result => { this.calls.push("onModel"); this.viewer = result; },
      onAccepted: result => { this.calls.push("onAccepted"); this.accepted.push(result); this.phase = "accepted"; },
    };
  }
  settle(): void {
    this.host.settle();
  }
  read(): State {
    const cached = this.host.ref("cached");
    return {
      phase: this.phase, current: this.current, latest: this.host.ref("latest"), cached,
      visible: cached !== null && this.viewer?.source === cached,
      attempt: this.host.api.attempt, count: this.host.ref("count"), sent: this.repairs.length,
      pending: this.host.ref("pending") !== null,
      retrySource: this.error?.retry ? this.errorSource : null, observation: this.observation,
    };
  }
  observe(input: Input, source: string | null, before: State, duplicate = false): void {
    const signal = signals.includes(input as Signal);
    this.observation = {
      input, source, pendingBefore: input === "reply" && before.pending, duplicate,
      target: signal ? before.current : null, calls: [...new Set(this.calls)],
      before: signal && (source !== before.current || duplicate) ? core(before) : blankCore,
    };
  }
  makeDelivery(kind: Signal, source: string): Delivery {
    const object = kind === "good" || kind === "debris" || kind === "empty"
      ? { source, stl: geometry[kind], stderr: [] } as unknown as Success
      : { source, kind, errors: [{ message: `Synthetic ${kind} failure`, line: 1 }], stderr: [] } as unknown as Failure;
    const delivery = { kind, object };
    this.deliveries.push(delivery);
    return delivery;
  }
  deliver(delivery: Delivery, before: State): void {
    const duplicate = this.handled.has(delivery.object);
    // A worker can deliver the same object again. A null transition makes
    // that a delivery even if React last saw that identical reference.
    this.host.options.result = null; this.host.options.failure = null; this.settle();
    this.active = delivery;
    if (["good", "debris", "empty"].includes(delivery.kind)) this.host.options.result = delivery.object as Success;
    else this.host.options.failure = delivery.object as Failure;
    this.settle();
    this.handledIfCurrent(delivery, before);
    this.observe(delivery.kind, delivery.object.source, before, duplicate);
  }
  // The identity ledger is the driver's own, not read from the hook: an
  // object delivered for the current program is one the hook had to act on,
  // and so is handled from then on, whatever the hook recorded.
  handledIfCurrent(delivery: Delivery, before: State): void {
    if (delivery.object.source === before.current) this.handled.add(delivery.object);
  }
  step(operation: Operation): State {
    const before = this.read();
    this.calls = [];
    // TypeOK deliberately includes the third-send error state. A worker
    // delivery is still tried after two sends; the hook owns the limit.
    // Only a fourth output is outside even that error-state domain.
    if (this.outsideOutputDomain(operation, before)) return before;
    switch (operation.kind) {
      case "human":
        this.repairs = []; this.host.api.reset(); this.settle();
        this.observe("human", null, before); break;
      case "reply": {
        this.lintFault = operation.lintFault;
        this.host.options.status = "streaming";
        this.host.options.reply = operation.text;
        this.settle();
        const source = operation.text === null ? null : extractLastScadBlock(operation.text);
        // The caller's current program follows every finished program reply,
        // including one the hook skips. It never follows a compiler result.
        if (source) this.current = source;
        this.host.options.status = "ready"; this.settle();
        this.observe(operation.text === null ? "nullReply" : source ? "reply" : "noCode", source || null, before);
        break;
      }
      case "signal": this.deliver(this.makeDelivery(operation.signal, operation.source), before); break;
      case "repeat": {
        // With no prior object, the worker has nothing to redeliver.
        const delivery = this.deliveries[operation.index % this.deliveries.length];
        if (delivery) this.deliver(delivery, before);
        break;
      }
      case "replace":
        this.viewer = null; this.host.api.modelReplaced(); this.settle();
        this.observe("replace", null, before); break;
      case "expect":
        // Caller-started compile; the hook itself calls no compile callback.
        this.compileRequests.push({ source: operation.source });
        this.current = this.compileRequests[this.compileRequests.length - 1].source;
        this.phase = "compiling"; this.host.api.expect(operation.source); this.settle();
        this.observe("expect", operation.source, before); break;
      case "retry": {
        const retry = this.error?.retry;
        retry?.run(); this.settle();
        if (retry) this.observe("retry", before.retrySource, before);
        break;
      }
      case "churn": {
        const duplicate = this.active ? this.handled.has(this.active.object) : false;
        Object.assign(this.host.options, this.callbacks()); this.settle();
        if (this.active) this.handledIfCurrent(this.active, before);
        if (this.active) this.observe(this.active.kind, this.active.object.source, before, duplicate);
        break;
      }
      case "wait": this.settle(); break;
    }
    return this.read();
  }
  outsideOutputDomain(operation: Operation, before: State): boolean {
    if (before.sent < MAX_REPAIR_ATTEMPTS + 1 || before.count >= MAX_REPAIR_ATTEMPTS) return false;
    if (operation.kind === "reply") {
      const source = operation.text === null ? null : extractLastScadBlock(operation.text);
      return !!source && source !== before.cached &&
        ((source === before.latest && before.pending) || operation.lintFault);
    }
    const delivery = operation.kind === "repeat" ? this.deliveries[operation.index % this.deliveries.length]
      : operation.kind === "churn" ? this.active : null;
    const kind = operation.kind === "signal" ? operation.signal : delivery?.kind;
    const source = operation.kind === "signal" ? operation.source : delivery?.object.source;
    return !!kind && ["code", "empty", "debris"].includes(kind) && source === before.latest &&
      (!delivery || !this.handled.has(delivery.object));
  }
}

type Operation =
  | { kind: "human" | "replace" | "retry" | "churn" | "wait" }
  | { kind: "reply"; text: string | null; lintFault: boolean }
  | { kind: "signal"; signal: Signal; source: string }
  | { kind: "repeat"; index: number }
  | { kind: "expect"; source: string };

// FNV-1a seed expansion followed by xorshift32; no ambient randomness/time.
function generator(seed: string): () => number {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  value = (value >>> 0) || 1;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return value >>> 0; };
}
function choose(random: () => number): Operation {
  const choice = random() % 100;
  const source = sources[random() % sources.length];
  if (choice < 5) return { kind: "human" };
  if (choice < 37) return { kind: "reply", text: `\`\`\`scad\n${source}\n\`\`\``, lintFault: random() % 5 === 0 };
  if (choice < 40) return { kind: "reply", text: "I could not produce a program.", lintFault: false };
  if (choice < 42) return { kind: "reply", text: null, lintFault: false };
  if (choice < 76) return { kind: "signal", signal: signals[random() % signals.length], source };
  if (choice < 83) return { kind: "repeat", index: random() };
  if (choice < 87) return { kind: "churn" };
  if (choice < 90) return { kind: "replace" };
  if (choice < 94) return { kind: "expect", source };
  if (choice < 97) return { kind: "retry" };
  return { kind: "wait" };
}

function modelValue(source: unknown): { $mv: string } {
  if (source === null) return { $mv: "none" };
  const index = sources.indexOf(source as typeof sources[number]);
  if (index < 0) throw new Error(`Out-of-domain source: ${String(source)}`);
  return { $mv: `p${index + 1}` };
}
function tuple(values: unknown[]) {
  return { $seq: values.map((value, index) => [1, 2, 3, 9].includes(index) ? modelValue(value) : value) };
}
function abstract(s: State) {
  return {
    ...s, current: modelValue(s.current), latest: modelValue(s.latest), cached: modelValue(s.cached), retrySource: modelValue(s.retrySource),
    observation: {
      ...s.observation, source: modelValue(s.observation.source), target: modelValue(s.observation.target),
      calls: { $set: s.observation.calls }, before: tuple(s.observation.before),
    },
  };
}
function size(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
const output = process.env.INVARIANT_TRACES;
if (!output) throw new Error("INVARIANT_TRACES is required");
const seed = process.env.INVARIANT_SEED ?? "43";
const runs = size("INVARIANT_RUNS", 24), steps = size("INVARIANT_STEPS", 120);
const random = generator(seed);
const traces: ReturnType<typeof abstract>[][] = [];
const findings: Record<string, unknown> = {};
for (let run = 0; run < runs; run++) {
  const driver = new Driver();
  const trace = [abstract(driver.read())];
  for (let step = 0; step < steps; step++) {
    const before = driver.read();
    const state = driver.step(choose(random));
    const after = abstract(state);
    trace.push(after);
    // Report evidence, never alter it or treat an expected bug as success.
    if (state.observation.input === "reply" && state.observation.pendingBefore && state.observation.calls.length === 0)
      findings.RepairReplyAccounted ??= { run, step: step + 1, before: abstract(before), after };
    if ((state.phase === "error" || state.phase === "accepted") && (state.count !== 0 || state.attempt !== 0 || state.pending))
      findings.FinishedRoundIsClear ??= { run, step: step + 1, before: abstract(before), after };
  }
  traces.push(trace);
}
writeFileSync(output, JSON.stringify({ traces }));
console.log(JSON.stringify({ seed, runs, steps, findings }));
