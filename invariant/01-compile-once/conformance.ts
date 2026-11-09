import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { compileOnce } from "../../lib/scad/compile-once.ts";

const MAX_DELIVERIES = 2;
const models = [new ArrayBuffer(8), new ArrayBuffer(16)] as const;
const modelNames = new Map<unknown, string>([
  [models[0], "model1"],
  [models[1], "model2"],
]);
const failureMessage = "color part failed to compile";
const timeoutMessage = "color part render timed out";

type Signal = { kind: "done" | "failure" | "error" | "timeout"; value: unknown };
type Observation = {
  outcome: "pending" | "resolved" | "rejected";
  value: unknown;
  settlements: number;
};
type Message = { type: string; model?: ArrayBuffer };
type Timer = { callback: () => void; due: number; active: boolean };

// These are observations at the host callback boundary, independent of what
// the returned promise does. In particular, a late callback is still recorded.
class Deliveries {
  readonly events: Signal[] = [];

  record(event: Signal): void {
    this.events.push(event);
  }
}

class ControlledWorker {
  onmessage: ((event: { data: Message }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = false;
  readonly posted: unknown[] = [];
  readonly log: Deliveries;

  constructor(log: Deliveries) {
    this.log = log;
  }

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  deliverMessage(data: Message): void {
    assert.equal(typeof this.onmessage, "function", "worker message handler missing");
    this.log.record(data.type === "done"
      ? { kind: "done", value: data.model }
      : { kind: "failure", value: failureMessage });
    // Deliberately invoke queued callbacks even after terminate(). There is no
    // settled/terminated guard here to hide the implementation's late behavior.
    this.onmessage!.call(this, { data });
  }

  deliverError(message: string): void {
    assert.equal(typeof this.onerror, "function", "worker error handler missing");
    this.log.record({ kind: "error", value: message || "worker error" });
    this.onerror!.call(this, { message });
  }
}

class ControlledClock {
  private now = 0;
  private nextId = 1;
  readonly timers = new Map<number, Timer>();
  readonly log: Deliveries;

  constructor(log: Deliveries) {
    this.log = log;
  }

  setTimeout = (callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]): number => {
    assert.equal(typeof callback, "function");
    assert.ok(Number.isFinite(delay) && delay >= 0);
    const id = this.nextId++;
    this.timers.set(id, {
      callback: () => callback(...args),
      due: this.now + delay,
      active: true,
    });
    return id;
  };

  clearTimeout = (id: number): void => {
    const timer = this.timers.get(id);
    if (timer) timer.active = false;
  };

  attemptTimeout(): void {
    // Every timeout operation reaches the clock, including after cancellation.
    // The host refuses to fire cleared/expired one-shot timers.
    const timer = [...this.timers.values()]
      .filter((entry) => entry.active)
      .sort((a, b) => a.due - b.due)[0];
    if (!timer) return;
    this.now = timer.due;
    timer.active = false; // F1=A: expiration itself satisfies timer cleanup.
    this.log.record({ kind: "timeout", value: timeoutMessage });
    timer.callback();
  }

  get active(): boolean {
    return [...this.timers.values()].some((timer) => timer.active);
  }
}

// Do not wrap or replace Promise: the observation counts actual native promise
// settlement notifications, never calls to the executor's resolve/reject.
function observe(promise: Promise<ArrayBuffer>): Observation {
  assert.ok(promise instanceof Promise);
  const observation: Observation = { outcome: "pending", value: "none", settlements: 0 };
  void promise.then(
    (value) => {
      observation.settlements++;
      observation.outcome = "resolved";
      observation.value = value;
    },
    (error: unknown) => {
      observation.settlements++;
      observation.outcome = "rejected";
      // Keep unexpected values visible to the checker; never replace them with
      // the prescribed error for the delivered signal.
      observation.value = error instanceof Error ? error.message : error;
    },
  );
  return observation;
}

function abstractValue(value: unknown): string | number | boolean | { $mv: string } {
  const name = modelNames.get(value);
  if (name !== undefined) return { $mv: name };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error("The implementation returned a value outside the model vocabulary");
}

function abstract(s: { log: Deliveries; worker: ControlledWorker; clock: ControlledClock; promise: Observation }) {
  const events = s.log.events;
  const event = (signal: Signal | undefined) => signal
    ? { kind: signal.kind, value: abstractValue(signal.value) }
    : { kind: "none", value: "none" };
  return {
    firstEvent: event(events[0]),
    lastEvent: event(events[events.length - 1]),
    outcome: s.promise.outcome,
    value: abstractValue(s.promise.value),
    settlements: s.promise.settlements,
    deliveries: events.length,
    workerTerminated: s.worker.terminated,
    timerActive: s.clock.active,
  };
}

// FNV-1a seed hashing followed by Mulberry32, with no ambient randomness/time.
function randomGenerator(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619) >>> 0;
  }
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert.notEqual(value, undefined, `${name} is required`);
  return value!;
}

function countEnv(name: string): number {
  const value = requiredEnv(name);
  assert.match(value, /^\d+$/, `${name} must be a nonnegative integer`);
  const count = Number(value);
  assert.ok(Number.isSafeInteger(count), `${name} must be a safe integer`);
  return count;
}

async function main(): Promise<void> {
  const runs = countEnv("INVARIANT_RUNS");
  const steps = countEnv("INVARIANT_STEPS");
  const random = randomGenerator(requiredEnv("INVARIANT_SEED"));
  const output = requiredEnv("INVARIANT_TRACES");
  const originals = new Map(["Worker", "setTimeout", "clearTimeout"].map((name) => [
    name, Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  const replaceGlobal = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const traces: ReturnType<typeof abstract>[][] = [];

  try {
    for (let run = 0; run < runs; run++) {
      const log = new Deliveries();
      const clock = new ControlledClock(log);
      const workers: ControlledWorker[] = [];
      replaceGlobal("Worker", class extends ControlledWorker {
        constructor(_url: URL, _options: unknown) {
          super(log);
          workers.push(this);
        }
      });
      replaceGlobal("setTimeout", clock.setTimeout);
      replaceGlobal("clearTimeout", clock.clearTimeout);

      const source = "cube(1);";
      const result = compileOnce(source, undefined, 25);
      const promise = observe(result);
      // Complete synchronous setup and flush the native promise observer.
      await Promise.resolve();
      assert.equal(workers.length, 1, "compileOnce must create one fresh worker");
      assert.equal(clock.timers.size, 1, "compileOnce must create one timer");
      const worker = workers[0];
      assert.deepEqual(worker.posted, [{ type: "compile", source, jobId: 1, files: undefined }]);
      const state = { log, clock, worker, promise };
      const trace = [abstract(state)];

      for (let step = 0; step < steps; step++) {
        // Select operations without consulting outcome, resource state or the
        // first signal. Only the ratified delivery bound may skip an operation.
        const operation = Math.floor(random() * 6);
        if (log.events.length < MAX_DELIVERIES) {
          switch (operation) {
            case 0: worker.deliverMessage({ type: "done", model: models[0] }); break;
            case 1: worker.deliverMessage({ type: "done", model: models[1] }); break;
            case 2: worker.deliverMessage({ type: "error" }); break;
            case 3: worker.deliverError(""); break;
            case 4: worker.deliverError("worker crashed"); break;
            case 5: clock.attemptTimeout(); break;
          }
        }
        await Promise.resolve();
        trace.push(abstract(state));
      }
      traces.push(trace);
    }
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
  // The gate supplies a path in its temporary sandbox. This is the only I/O.
  await writeFile(output, JSON.stringify({ traces }));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
