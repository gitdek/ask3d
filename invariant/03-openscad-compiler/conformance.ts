import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import React from "react";

// The sandbox supplies the hook but not its parser module. Diagnostic contents
// are outside this model; this pure dependency fixture supplies their payload.
// All status setters, job checks and lifecycle operations run in the real hook.
const parserFixture = "data:text/javascript," + encodeURIComponent(
  "export function parseScadErrors(stderr) { return stderr.map(message => ({ message })); }",
);
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/scad/errors") {
      return { url: parserFixture, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { useOpenscadCompiler } = await import("../../hooks/use-openscad-compiler.ts");
resolution.deregister();

// Use React's real hook entry points with an in-memory dispatcher. The target
// hook module is imported directly and is never edited or reimplemented.
const internals = (React as any)
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
if (!internals) throw new Error("This fixture requires the package's React 19");

type Handler = (...args: any[]) => void;
type Write = { dispatch: number; job: number };
type Cell = {
  kind: string;
  value?: any;
  setter?: Handler;
  deps?: readonly unknown[];
  cleanup?: Handler | void;
};

class HookHost {
  cells: Cell[] = [];
  cursor = 0;
  queued: Handler[] = [];
  effects: Handler[] = [];
  writes: Write[] = [];
  delivering: Write | null = null;
  value!: ReturnType<typeof useOpenscadCompiler>;

  cell(kind: string, initialize: () => Cell): Cell {
    const index = this.cursor++;
    const cell = this.cells[index] ?? (this.cells[index] = initialize());
    if (cell.kind !== kind) throw new Error("Hook order changed");
    return cell;
  }

  dispatcher = {
    useState: (initial: any) => {
      const cell = this.cell("state", () => ({
        kind: "state",
        value: typeof initial === "function" ? initial() : initial,
      }));
      cell.setter ??= (update: any) => {
        // Observe calls, including setters that would be React no-ops. Do not
        // infer acceptance from the final status or from the expected job ID.
        if (this.delivering) this.writes.push({ ...this.delivering });
        this.queued.push(() => {
          cell.value = typeof update === "function" ? update(cell.value) : update;
        });
      };
      return [cell.value, cell.setter];
    },
    useRef: (initial: any) =>
      this.cell("ref", () => ({ kind: "ref", value: { current: initial } })).value,
    useCallback: (callback: Handler, deps: readonly unknown[]) => {
      const cell = this.cell("callback", () => ({ kind: "callback" }));
      if (!sameDeps(cell.deps, deps)) {
        cell.value = callback;
        cell.deps = deps;
      }
      return cell.value;
    },
    useEffect: (effect: () => Handler | void, deps: readonly unknown[]) => {
      const cell = this.cell("effect", () => ({ kind: "effect" }));
      if (!sameDeps(cell.deps, deps)) {
        this.effects.push(() => {
          cell.cleanup?.();
          cell.cleanup = effect();
        });
        cell.deps = deps;
      }
    },
  };

  render() {
    for (const update of this.queued.splice(0)) update();
    this.cursor = 0;
    const previous = internals.H;
    internals.H = this.dispatcher;
    try {
      this.value = useOpenscadCompiler();
    } finally {
      internals.H = previous;
    }
    for (const effect of this.effects.splice(0)) effect();
  }

  // These are the unchanged hook's workerRef, timeoutRef and jobIdRef cells.
  ref(index: number): any {
    return this.cells.filter((cell) => cell.kind === "ref")[index].value.current;
  }

  unmount() {
    for (const cell of this.cells) {
      if (cell.kind === "effect") cell.cleanup?.();
    }
  }
}

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[]) {
  return a !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

type TimerEntry = {
  id: number;
  worker: FixtureWorker;
  callback: Handler;
  due: number;
  armed: boolean;
};

class FixtureWorker {
  onmessage: Handler | null = null;
  onerror: Handler | null = null;
  message: Handler | null = null;
  error: Handler | null = null;
  request: any = null;
  live = true;
  pending = false;

  constructor(fixture: Fixture) {
    fixture.workers.push(this);
    fixture.peakWorkers = Math.max(
      fixture.peakWorkers,
      fixture.workers.filter((worker) => worker.live).length,
    );
  }

  postMessage(request: any) {
    this.request = structuredClone(request);
    // Saved deliveries survive termination, to exercise callbacks already
    // queued by the browser when replacement/cancellation takes place.
    this.message = this.onmessage;
    this.error = this.onerror;
    this.pending = true;
  }

  terminate() {
    this.live = false;
  }
}

class Fixture {
  host = new HookHost();
  workers: FixtureWorker[] = [];
  timers: TimerEntry[] = [];
  compileCalls = 0;
  cancelCalls = 0;
  cancelAt = 0;
  peakWorkers = 0;
  timeouts = 0;
  now = 0;
  dispatches = 0;

  install() {
    const fixture = this;
    globalThis.Worker = class extends FixtureWorker {
      constructor(_url: URL, _options: unknown) {
        super(fixture);
      }
    } as any;
    globalThis.setTimeout = ((callback: Handler, delay = 0, ...args: any[]) => {
      const entry: TimerEntry = {
        id: fixture.timers.length + 1,
        worker: fixture.host.ref(0),
        callback: () => callback(...args),
        due: fixture.now + Math.max(0, Number(delay)),
        armed: true,
      };
      fixture.timers.push(entry);
      return entry.id;
    }) as any;
    globalThis.clearTimeout = ((id: unknown) => {
      const entry = fixture.timers.find((timer) => timer.id === id);
      if (entry) entry.armed = false;
    }) as any;
    this.host.render();
  }

  compile(timeoutMs: number) {
    if (this.compileCalls === 2) return; // Ratified bound, not a status guard.
    this.compileCalls++;
    this.host.writes = []; // Begin a new observation epoch; retain real result.
    this.host.value.compile(`cube(${this.compileCalls});`, [], { timeoutMs });
    this.host.render();
  }

  cancel() {
    if (this.cancelCalls === 1) return; // The single-cancel fixture bound.
    this.cancelCalls++;
    this.host.writes = [];
    this.host.value.cancel();
    this.cancelAt = this.host.ref(2); // Read the hook's invalidation token.
    this.host.render();
  }

  dispatch(worker: FixtureWorker, callback: Handler) {
    const before = this.host.writes.length;
    this.host.delivering = { dispatch: ++this.dispatches, job: worker.request.jobId };
    try {
      callback();
    } finally {
      this.host.delivering = null;
      this.host.render();
    }
    // The ratified fixtures supply one accepted terminal notification per job.
    // Retire its delivery handles only upon observing a setter call. Ignored
    // saved notifications remain replayable. Never check status/current here.
    if (this.host.writes.length !== before) worker.pending = false;
  }

  step(random: () => number) {
    const operation = random() % 10;
    if (operation < 2) {
      this.compile([0, 1, 60_000][random() % 3]);
      return;
    }
    if (operation === 2) {
      this.cancel();
      return;
    }
    if (operation === 9) return; // Explicit Wait.

    // Select from actual delivery storage, including terminated workers. An
    // empty queue has nothing to dispatch. No eligibility test uses hook state.
    const pending = this.workers.filter((worker) => worker.pending);
    if (pending.length === 0) return;
    const worker = pending[random() % pending.length];
    if (operation === 8) {
      if (this.timeouts === 1) return; // Counts stale dispatches as well.
      const timer = this.timers.find((entry) => entry.worker === worker);
      if (!timer) return;
      this.now = Math.max(this.now, timer.due);
      timer.armed = false;
      this.timeouts++;
      this.dispatch(worker, timer.callback); // Also try saved, cleared timers.
    } else if (operation === 6) {
      this.dispatch(worker, () => worker.error?.call(worker, { message: "Fixture worker error" }));
    } else {
      // Cover success, compile error, environment error, and a mismatched ID.
      const jobId = operation === 7 ? (worker.request.jobId % 3) + 1 : worker.request.jobId;
      const data = operation === 3 || operation === 7
        ? { type: "done", jobId, model: new ArrayBuffer(4), stderr: [] }
        : { type: "error", jobId, exitCode: operation === 5 ? null : 1,
            stderr: ["ERROR: Parser error: syntax error in file input.scad, line 1"] };
      this.dispatch(worker, () => worker.message?.call(worker, { data }));
    }
  }
}

function abstract(fixture: Fixture) {
  const { host } = fixture;
  const writes = host.writes;
  const set = (values: number[]) => ({ $set: [...new Set(values)].sort((a, b) => a - b) });
  return {
    status: host.value.status,
    current: host.ref(2),
    cancelAt: fixture.cancelAt,
    alive: set(fixture.workers.filter((worker) => worker.live).map((worker) => worker.request.jobId)),
    timer: host.ref(1) !== null || fixture.timers.some((entry) => entry.armed),
    callbacks: set(fixture.workers.filter((worker) => worker.pending).map((worker) => worker.request.jobId)),
    applied: writes.length === 0 ? 0 : writes[writes.length - 1].job,
    endings: new Set(writes.map((write) => write.dispatch)).size,
    peakWorkers: fixture.peakWorkers,
    timeouts: fixture.timeouts,
  };
}

function generator(seed: string) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  };
}

function count(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

const runs = count("INVARIANT_RUNS", 100);
const steps = count("INVARIANT_STEPS", 30);
const random = generator(process.env.INVARIANT_SEED ?? "1");
const destination = process.env.INVARIANT_TRACES;
if (!destination) throw new Error("INVARIANT_TRACES is required");

const originals = {
  Worker: Object.getOwnPropertyDescriptor(globalThis, "Worker"),
  setTimeout: Object.getOwnPropertyDescriptor(globalThis, "setTimeout"),
  clearTimeout: Object.getOwnPropertyDescriptor(globalThis, "clearTimeout"),
};
const traces: ReturnType<typeof abstract>[][] = [];
try {
  for (let run = 0; run < runs; run++) {
    const fixture = new Fixture();
    try {
      fixture.install();
      const trace = [abstract(fixture)];
      for (let step = 0; step < steps; step++) {
        fixture.step(random);
        trace.push(abstract(fixture));
      }
      traces.push(trace);
    } finally {
      // Unmount is fixture cleanup, outside the bounded mounted-hook trace.
      fixture.host.unmount();
    }
  }
} finally {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
}
writeFileSync(destination, JSON.stringify({ traces }));
