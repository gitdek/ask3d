import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as React from "react";

// Load the existing service module by its relative name at runtime as well:
// its optional three.js converters need the app's bundler type resolution.
// Only these existing sidecar exports are replaced by the fixture.
type StatueEngine = "hunyuan" | "space" | "hunyuan-space";
interface StatueHealth {
  ok: boolean;
  mock: boolean;
  default_engine: string;
  engines: Record<string, boolean>;
  busy: boolean;
}
interface StatueTaskStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  detail: string;
  elapsed_seconds: number;
  model_format: "glb" | "obj" | "stl" | null;
  error: string | null;
  engine?: string | null;
  seed?: number | null;
  octree?: string | null;
  repair_warning?: string | null;
}
interface LatestStatueTask {
  id: string;
  status: StatueTaskStatus["status"];
  detail: string;
  age_seconds: number;
  model_format: StatueTaskStatus["model_format"];
  engine: string | null;
}
interface StatueApi {
  statueHealth(): Promise<StatueHealth | null>;
  createStatueTask(images: File[], engine: StatueEngine): Promise<string>;
  fetchLatestStatueTask(): Promise<LatestStatueTask | null>;
  pollStatueTask(id: string): Promise<StatueTaskStatus>;
  fetchStatueModel(id: string): Promise<ArrayBuffer>;
}
let statue: StatueApi;

// Exercise the existing public hook boundary with the repository's React 19 host.
interface Progress {
  uploadPath: string;
  phase: "starting" | "generating" | "converting";
  detail: string;
  elapsedSeconds: number;
}

interface Start {
  images: File[];
  engine: StatueEngine;
  sourceName: string;
  sourcePath: string;
}

interface Delivery {
  taskId: string;
  name: string;
  model: ArrayBuffer;
  format: "glb" | "obj" | "stl";
  sourcePath: string | null;
  note: string | undefined;
  repairWarning: string | null;
}

interface Task {
  progress: Progress | null;
  start(input: Start): Promise<void>;
  dismiss(): void;
}

type UseStatueTask = (options: {
  onDeliver: (delivery: Delivery) => Promise<void>;
  onError: (message: string | null) => void;
}) => Task;

async function loadUseStatueTask(): Promise<UseStatueTask> {
  const serviceSpecifier: string = "../statue";
  statue = await import(serviceSpecifier);
  const specifier: string = "../../hooks/use-statue-task";
  let loaded: { useStatueTask?: UseStatueTask } = {};
  let failure = "";
  try {
    loaded = await import(specifier);
  } catch (error) {
    failure = String(error);
  }
  expect(typeof loaded.useStatueTask, `load the statue task hook: ${failure}`).toBe("function");
  return loaded.useStatueTask!;
}

// The compiler conformance driver already hosts React 19 hooks with an
// in-memory dispatcher. This host exercises the real hook entry points, state,
// dependencies and effect cleanup without adding a DOM/test-renderer package.
// It observes only the public return value, never the hook's refs or cell order.
type Cleanup = () => void;
type Cell = { kind: string; value?: unknown; deps?: readonly unknown[]; cleanup?: Cleanup };

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) {
  return a !== undefined && b !== undefined && a.length === b.length
    && a.every((value, i) => Object.is(value, b[i]));
}

class HookHost {
  private cells: Cell[] = [];
  private cursor = 0;
  private effects: Cleanup[] = [];
  private mounted = true;
  value!: Task;

  constructor(private readonly hook: () => Task) {}

  private cell(kind: string, initialize: () => Cell) {
    const index = this.cursor++;
    const cell = this.cells[index] ?? (this.cells[index] = initialize());
    if (cell.kind !== kind) throw new Error("React hook order changed");
    return cell;
  }

  private dispatcher = {
    useState: (initial: unknown) => {
      const cell = this.cell("state", () => {
        const state = { current: typeof initial === "function" ? initial() : initial };
        const set = (update: unknown) => {
          state.current = typeof update === "function" ? update(state.current) : update;
        };
        return { kind: "state", value: { state, set } };
      });
      const { state, set } = cell.value as {
        state: { current: unknown }; set: (update: unknown) => void;
      };
      return [state.current, set];
    },
    useRef: (initial: unknown) =>
      this.cell("ref", () => ({ kind: "ref", value: { current: initial } })).value,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => {
      const cell = this.cell("callback", () => ({ kind: "callback" }));
      if (!sameDeps(cell.deps, deps)) {
        cell.value = callback;
        cell.deps = deps;
      }
      return cell.value;
    },
    useMemo: (factory: () => unknown, deps?: readonly unknown[]) => {
      const cell = this.cell("memo", () => ({ kind: "memo" }));
      if (!sameDeps(cell.deps, deps)) {
        cell.value = factory();
        cell.deps = deps;
      }
      return cell.value;
    },
    useEffect: (effect: () => Cleanup | void, deps?: readonly unknown[]) => {
      const cell = this.cell("effect", () => ({ kind: "effect" }));
      if (!sameDeps(cell.deps, deps)) {
        cell.deps = deps;
        this.effects.push(() => {
          cell.cleanup?.();
          cell.cleanup = effect() || undefined;
        });
      }
    },
  };

  render() {
    if (!this.mounted) return;
    this.cursor = 0;
    const internals = (React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    internals.H = this.dispatcher;
    try {
      this.value = this.hook();
    } finally {
      internals.H = previous;
    }
    for (const effect of this.effects.splice(0)) effect();
  }

  unmount() {
    if (!this.mounted) return;
    this.mounted = false;
    for (const cell of this.cells) cell.cleanup?.();
  }
}

const KEY = "ask3d:dismissed-statue-task";
const hosts: HookHost[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function healthy(extra: Partial<StatueHealth> = {}): StatueHealth {
  return {
    ok: true, mock: false, default_engine: "hunyuan", busy: false,
    engines: { hunyuan: true, space: true }, ...extra,
  };
}

function status(extra: Partial<StatueTaskStatus> = {}): StatueTaskStatus {
  return {
    status: "succeeded", detail: "finished", elapsed_seconds: 12,
    model_format: "stl", error: null, ...extra,
  };
}

function latest(extra: Partial<LatestStatueTask> = {}): LatestStatueTask {
  return {
    id: "old-task", status: "succeeded", detail: "finished", age_seconds: 20,
    model_format: "stl", engine: "hunyuan", ...extra,
  };
}

function input(engine: StatueEngine = "hunyuan"): Start {
  return {
    engine, sourceName: "My.figure.front.PNG", sourcePath: "/uploads/front.png",
    images: [new File(["front"], "front.png"), new File(["left"], "left.jpg")],
  };
}

function fixture() {
  const values = new Map<string, string>();
  const storageState = { failRead: false, failWrite: false };
  const storage = {
    getItem: vi.fn((key: string) => {
      if (storageState.failRead) throw new Error("private storage");
      return values.get(key) ?? null;
    }),
    setItem: vi.fn((key: string, value: string) => {
      if (storageState.failWrite) throw new Error("private storage");
      values.set(key, value);
    }),
  };
  vi.stubGlobal("localStorage", storage);
  const model = new Uint8Array([1, 3, 5, 7]).buffer;
  const errors: (string | null)[] = [];
  const deliveries: Delivery[] = [];
  return {
    values, storage, storageState, model, errors, deliveries,
    health: vi.spyOn(statue, "statueHealth").mockReset().mockResolvedValue(healthy()),
    create: vi.spyOn(statue, "createStatueTask").mockReset().mockResolvedValue("new-task"),
    latest: vi.spyOn(statue, "fetchLatestStatueTask").mockReset().mockResolvedValue(null),
    poll: vi.spyOn(statue, "pollStatueTask").mockReset().mockResolvedValue(status()),
    download: vi.spyOn(statue, "fetchStatueModel").mockReset().mockResolvedValue(model),
    deliver: vi.fn(async (delivery: Delivery) => { deliveries.push(delivery); }),
    onError: vi.fn((message: string | null) => { errors.push(message); }),
  };
}

type Fixture = ReturnType<typeof fixture>;

function mount(useTask: UseStatueTask, f: Fixture) {
  const host = new HookHost(() => useTask({ onDeliver: f.deliver, onError: f.onError }));
  hosts.push(host);
  host.render();
  return host;
}

async function settle(host: HookHost) {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    host.render();
  }
}

async function tick(host: HookHost, milliseconds = 4000) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settle(host);
}

function expectIdle(host: HookHost) {
  expect(host.value.progress).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("The hook must use lib/statue.ts, not direct HTTP");
  }));
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.unmount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Change a public callback once to start a new recovery effect. Keep both
// callbacks stable until its answer resolves, so cleanup cannot reject it.
async function pendingLatest(host: HookHost, f: Fixture) {
  const answer = deferred<LatestStatueTask | null>();
  const calls = f.latest.mock.calls.length;
  f.latest.mockImplementationOnce(() => answer.promise);
  f.deliver = vi.fn(async (value: Delivery) => { f.deliveries.push(value); });
  host.render();
  await settle(host);
  expect(f.latest).toHaveBeenCalledTimes(calls + 1);
  return answer;
}

async function finishFresh(host: HookHost, f: Fixture, id: string) {
  const calls = f.create.mock.calls.length;
  f.create.mockResolvedValueOnce(id);
  const done = host.value.start(input());
  await settle(host);
  expect(f.create).toHaveBeenCalledTimes(calls + 1);
  await tick(host);
  await done;
  await settle(host);
  expectIdle(host);
}

function expectTasks(f: Fixture, ids: string[]) {
  expect(f.deliveries.map((value) => value.taskId)).toEqual(ids);
  expect(f.poll.mock.calls).toEqual(ids.map((id) => [id]));
  expect(f.download.mock.calls).toEqual(ids.map((id) => [id]));
}

describe("statue recovery exclusions", () => {
  it("ignores a live delayed answer for an earlier recovered delivery after a fresh delivery", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const first = "1a2b3c000001";
    const second = "1a2b3c000002";
    const firstDelivery = deferred<void>();
    f.latest.mockResolvedValueOnce(latest({ id: first }));
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await firstDelivery.promise;
    });
    const host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliveries.map((value) => value.taskId)).toEqual([first]);
    expect(host.value.progress?.phase).toBe("converting");
    expect(f.storage.setItem).not.toHaveBeenCalled();
    firstDelivery.resolve();
    await settle(host);
    expectIdle(host);
    expect(f.values.get(KEY)).toBe(first);

    const answer = await pendingLatest(host, f);
    const secondDelivery = deferred<void>();
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await secondDelivery.promise;
    });
    f.create.mockResolvedValueOnce(second);
    const done = host.value.start(input());
    await settle(host);
    await tick(host);
    expect(host.value.progress?.phase).toBe("converting");
    expect(f.values.get(KEY)).toBe(first);
    await host.value.start(input());
    expect(f.create).toHaveBeenCalledTimes(1);
    secondDelivery.resolve();
    await done;
    await settle(host);
    expectIdle(host);
    expect(f.values.get(KEY)).toBe(second);

    // The second start has finished its finally block, releasing the guard.
    // No callback change or unmount has cancelled this outstanding request.
    answer.resolve(latest({ id: first, age_seconds: 599.999 }));
    await settle(host);
    await tick(host, 12000);
    expect(f.latest).toHaveBeenCalledTimes(2);
    expectTasks(f, [first, second]);
    expect(f.deliveries).toEqual([
      {
        taskId: first, name: `recovered-statue-${first}.stl`, model: f.model,
        format: "stl", sourcePath: null, note: undefined, repairWarning: null,
      },
      {
        taskId: second, name: `My.figure.front-statue-${second}.stl`, model: f.model,
        format: "stl", sourcePath: "/uploads/front.png", note: undefined, repairWarning: null,
      },
    ]);
    expectIdle(host);
    expect(f.errors).toEqual([null]);
    expect(f.values.get(KEY)).toBe(second);
    expect(f.storage.setItem.mock.calls).toEqual([[KEY, first], [KEY, second]]);

    // Excluding old tasks must leave recovery available for an unrelated ID.
    const next = await pendingLatest(host, f);
    const third = "1a2b3c000003";
    next.resolve(latest({ id: third, status: "queued", age_seconds: 900 }));
    await settle(host);
    await tick(host);
    expectTasks(f, [first, second, third]);
    expect(f.deliveries[2].name).toBe(`recovered-statue-${third}.stl`);
    expectIdle(host);
  });

  it("remembers the dismissal present at mount before any latest answer arrives", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const dismissed = "fedcba987654";
    const second = "1a2b3c000002";
    f.values.set(KEY, dismissed);
    const answer = deferred<LatestStatueTask | null>();
    f.latest.mockImplementationOnce(() => answer.promise);
    const host = mount(useTask, f);
    await settle(host);
    expectIdle(host);
    await finishFresh(host, f, second);
    expect(f.values.get(KEY)).toBe(second);

    answer.resolve(latest({ id: dismissed }));
    await settle(host);
    await tick(host, 12000);
    expect(f.latest).toHaveBeenCalledTimes(1);
    expectTasks(f, [second]);
    expect(f.deliveries[0].name).toBe(`My.figure.front-statue-${second}.stl`);
    expect(f.values.get(KEY)).toBe(second);
    expect(f.storage.setItem.mock.calls).toEqual([[KEY, second]]);
    expect(f.errors).toEqual([null]);
    expectIdle(host);
  });

  it("keeps a cleared pending delivery excluded after rejection and a newer success", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const cleared = "1a2b3c000001";
    const second = "1a2b3c000002";
    const answer = deferred<LatestStatueTask | null>();
    const delivery = deferred<void>();
    f.latest.mockImplementationOnce(() => answer.promise);
    f.create.mockResolvedValueOnce(cleared);
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await delivery.promise;
    });
    const host = mount(useTask, f);
    await settle(host);
    const done = host.value.start(input());
    await settle(host);
    await tick(host);
    expect(host.value.progress?.phase).toBe("converting");
    expect(f.storage.setItem).not.toHaveBeenCalled();
    host.value.dismiss();
    expect(f.values.get(KEY)).toBe(cleared);
    expect(host.value.progress?.phase).toBe("converting");
    await host.value.start(input());
    expect(f.create).toHaveBeenCalledTimes(1);
    delivery.reject(new Error("delivery failed"));
    await done;
    await settle(host);
    expectIdle(host);
    expect(f.errors).toEqual([null, "delivery failed"]);
    await finishFresh(host, f, second);
    expect(f.values.get(KEY)).toBe(second);

    answer.resolve(latest({ id: cleared }));
    await settle(host);
    await tick(host, 12000);
    expect(f.latest).toHaveBeenCalledTimes(1);
    expectTasks(f, [cleared, second]);
    expect(f.deliveries.map((value) => value.name)).toEqual([
      `My.figure.front-statue-${cleared}.stl`, `My.figure.front-statue-${second}.stl`,
    ]);
    expect(f.errors).toEqual([null, "delivery failed", null]);
    expect(f.values.get(KEY)).toBe(second);
    expect(f.storage.setItem.mock.calls).toEqual([[KEY, cleared], [KEY, second]]);
    expectIdle(host);
  });

  it("remembers Clear after generation fails without reaching delivery", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const cleared = "1a2b3c000001";
    const second = "1a2b3c000002";
    const answer = deferred<LatestStatueTask | null>();
    f.latest.mockImplementationOnce(() => answer.promise);
    f.poll.mockResolvedValueOnce(status({ status: "failed", error: "generation failed" }));
    const host = mount(useTask, f);
    await settle(host);
    await finishFresh(host, f, cleared);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.storage.setItem).not.toHaveBeenCalled();
    host.value.dismiss();
    expect(f.values.get(KEY)).toBe(cleared);
    await finishFresh(host, f, second);
    expect(f.values.get(KEY)).toBe(second);

    answer.resolve(latest({ id: cleared, status: "running", age_seconds: 900 }));
    await settle(host);
    await tick(host, 12000);
    expect(f.latest).toHaveBeenCalledTimes(1);
    expect(f.poll.mock.calls).toEqual([[cleared], [second]]);
    expect(f.download.mock.calls).toEqual([[second]]);
    expect(f.deliveries.map((value) => value.taskId)).toEqual([second]);
    expect(f.errors).toEqual([null, "generation failed", null]);
    expect(f.values.get(KEY)).toBe(second);
    expect(f.storage.setItem.mock.calls).toEqual([[KEY, cleared], [KEY, second]]);
    expectIdle(host);
  });

  it.each(["reads and writes", "writes", "reads", "missing"] as const)(
    "keeps delivered and cleared tasks excluded when storage is unavailable: %s",
    async (unavailable) => {
      const useTask = await loadUseStatueTask();
      const f = fixture();
      f.storageState.failRead = unavailable === "reads" || unavailable === "reads and writes";
      f.storageState.failWrite = unavailable === "writes" || unavailable === "reads and writes";
      if (unavailable === "missing") vi.stubGlobal("localStorage", undefined);
      const recovered = "1a2b3c000001";
      const cleared = "1a2b3c000002";
      const fresh = "1a2b3c000003";
      f.latest.mockResolvedValueOnce(latest({ id: recovered }));
      const host = mount(useTask, f);
      await settle(host);
      await tick(host);
      expectIdle(host);
      expectTasks(f, [recovered]);

      const answer = await pendingLatest(host, f);
      f.deliver.mockImplementationOnce(async (value) => {
        f.deliveries.push(value);
        throw new Error("delivery failed");
      });
      await finishFresh(host, f, cleared);
      host.value.dismiss();
      await finishFresh(host, f, fresh);

      answer.resolve(latest({ id: recovered }));
      await settle(host);
      await tick(host, 12000);
      expect(f.latest).toHaveBeenCalledTimes(2);
      expectTasks(f, [recovered, cleared, fresh]);
      expectIdle(host);

      const clearedAnswer = await pendingLatest(host, f);
      clearedAnswer.resolve(latest({ id: cleared }));
      await settle(host);
      await tick(host, 12000);
      expect(f.latest).toHaveBeenCalledTimes(3);
      expectTasks(f, [recovered, cleared, fresh]);
      expectIdle(host);

      const freshAnswer = await pendingLatest(host, f);
      freshAnswer.resolve(latest({ id: fresh }));
      await settle(host);
      await tick(host, 12000);
      expect(f.latest).toHaveBeenCalledTimes(4);
      expectTasks(f, [recovered, cleared, fresh]);
      expect(f.deliveries.map((value) => value.name)).toEqual([
        `recovered-statue-${recovered}.stl`,
        `My.figure.front-statue-${cleared}.stl`,
        `My.figure.front-statue-${fresh}.stl`,
      ]);
      expect(f.errors).toEqual([null, "delivery failed", null]);
      expectIdle(host);
      expect([...f.values.entries()]).toEqual(unavailable === "reads" ? [[KEY, fresh]] : []);
      expect(f.storage.setItem.mock.calls).toEqual(unavailable === "missing"
        ? [] : [[KEY, recovered], [KEY, cleared], [KEY, fresh]]);
    },
  );
});

