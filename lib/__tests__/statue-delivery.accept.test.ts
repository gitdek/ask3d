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

describe("statue delivery identity", () => {
  it("remembers fresh delivery only after completion and skips it on reload", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const id = "1a2b3c000001";
    f.create.mockResolvedValue(id);
    const delivery = deferred<void>();
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await delivery.promise;
    });
    let host = mount(useTask, f);
    await settle(host);
    const done = host.value.start(input());
    await settle(host);
    await tick(host, 3999);
    expect(f.poll).not.toHaveBeenCalled();
    expect(f.values.get(KEY)).toBeUndefined();
    await tick(host, 1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(host.value.progress?.phase).toBe("converting");
    expect(f.values.get(KEY)).toBeUndefined();
    await host.value.start(input());
    expect(f.create).toHaveBeenCalledTimes(1);
    delivery.resolve();
    await done;
    await settle(host);
    expect(f.values.get(KEY)).toBe(id);
    expect(f.errors).toEqual([null]);
    expectIdle(host);
    host.unmount();

    f.latest.mockResolvedValue(latest({ id, age_seconds: 1 }));
    host = mount(useTask, f);
    await settle(host);
    await tick(host, 12000);
    expect(f.poll).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.download).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expectIdle(host);
  });

  it("remembers recovered delivery while allowing a different latest task", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const previous = "fedcba987654";
    const first = "1a2b3c000001";
    const second = "1a2b3c000002";
    f.values.set(KEY, previous);
    f.latest.mockResolvedValue(latest({ id: first, age_seconds: 599.999 }));
    const delivery = deferred<void>();
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await delivery.promise;
    });
    let host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.values.get(KEY)).toBe(previous);
    delivery.resolve();
    await settle(host);
    expect(f.values.get(KEY)).toBe(first);
    expectIdle(host);
    host.unmount();

    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expectIdle(host);
    host.unmount();

    f.latest.mockResolvedValue(latest({ id: second }));
    host = mount(useTask, f);
    await settle(host);
    expect(f.values.get(KEY)).toBe(first);
    await tick(host);
    expect(f.deliveries.map((value) => value.taskId)).toEqual([first, second]);
    expect(f.values.get(KEY)).toBe(second);
    expect(f.health).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.errors).toEqual([]);
    expectIdle(host);
  });

  it("gives fresh and recovered tasks distinct names even when their ID prefixes match", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const ids = ["1a2b3c000001", "1a2b3c000002", "1a2b3c000003", "1a2b3c000004"];
    f.create.mockResolvedValueOnce(ids[0]).mockResolvedValueOnce(ids[1]);
    let host = mount(useTask, f);
    await settle(host);
    for (let i = 0; i < 2; i++) {
      const done = host.value.start({ ...input(), sourceName: "lucy.jpg" });
      await settle(host);
      await tick(host);
      await done;
      expectIdle(host);
    }
    host.unmount();
    for (const id of ids.slice(2)) {
      f.latest.mockResolvedValue(latest({ id }));
      host = mount(useTask, f);
      await settle(host);
      await tick(host);
      expectIdle(host);
      host.unmount();
    }
    expect(f.deliveries.map((value) => value.taskId)).toEqual(ids);
    expect(f.deliveries.map((value) => value.name)).toEqual(
      ids.map((id, index) => `${index < 2 ? "lucy" : "recovered"}-statue-${id}.stl`),
    );
    expect(new Set(f.deliveries.map((value) => value.name)).size).toBe(4);
    expect(f.errors).toEqual([null, null]);
  });

  it("retries rejected delivery after reload using the recovered task name", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const previous = "fedcba987654";
    const id = "1a2b3c000005";
    f.values.set(KEY, previous);
    f.create.mockResolvedValue(id);
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      throw new Error("delivery failed");
    });
    let host = mount(useTask, f);
    await settle(host);
    const done = host.value.start(input());
    await settle(host);
    await tick(host);
    await done;
    expect(f.values.get(KEY)).toBe(previous);
    expect(f.errors).toEqual([null, "delivery failed"]);
    expectIdle(host);
    const originalName = f.deliveries[0].name;
    expect(originalName).toBe(`My.figure.front-statue-${id}.stl`);
    const recoveredName = `recovered-statue-${id}.stl`;
    host.unmount();

    f.latest.mockResolvedValue(latest({ id }));
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      throw new Error("recovery delivery failed");
    });
    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.values.get(KEY)).toBe(previous);
    expect(f.errors).toEqual([null, "delivery failed", "recovery delivery failed"]);
    expectIdle(host);
    expect(f.deliveries[1].name).toBe(recoveredName);
    host.unmount();

    const delivery = deferred<void>();
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await delivery.promise;
    });
    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliveries.map((value) => value.name)).toEqual([originalName, recoveredName, recoveredName]);
    expect(f.deliveries.map((value) => value.taskId)).toEqual([id, id, id]);
    expect(f.values.get(KEY)).toBe(previous);
    await host.value.start(input());
    expect(f.create).toHaveBeenCalledTimes(1);
    delivery.resolve();
    await settle(host);
    expect(f.values.get(KEY)).toBe(id);
    expectIdle(host);
    host.unmount();

    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliver).toHaveBeenCalledTimes(3);
    expect(f.errors).toEqual([null, "delivery failed", "recovery delivery failed"]);
    expectIdle(host);
  });

  it("retains recovery and task names when localStorage is unavailable", async () => {
    const useTask = await loadUseStatueTask();
    for (const unavailable of ["reads and writes", "writes", "reads", "missing"]) {
      const f = fixture();
      f.storageState.failRead = unavailable === "reads" || unavailable === "reads and writes";
      f.storageState.failWrite = unavailable === "writes" || unavailable === "reads and writes";
      if (unavailable === "missing") vi.stubGlobal("localStorage", undefined);
      const id = "1a2b3c000006";
      f.create.mockResolvedValue(id);
      let host = mount(useTask, f);
      await settle(host);
      const done = host.value.start(input());
      await settle(host);
      await tick(host);
      await done;
      expect(f.errors, unavailable).toEqual([null]);
      expectIdle(host);
      host.unmount();

      f.latest.mockResolvedValue(latest({ id }));
      host = mount(useTask, f);
      await settle(host);
      await tick(host);
      expect(f.deliveries.map((value) => value.taskId), unavailable).toEqual([id, id]);
      expect(f.deliveries[0].name, unavailable).toBe(`My.figure.front-statue-${id}.stl`);
      expect(f.deliveries[1].name, unavailable).toBe(`recovered-statue-${id}.stl`);
      expect(f.errors, unavailable).toEqual([null]);
      expectIdle(host);
      host.unmount();

      host = mount(useTask, f);
      await settle(host);
      await tick(host);
      expect(f.deliveries.map((value) => value.taskId), unavailable).toEqual([id, id, id]);
      expect(f.deliveries[2].name, unavailable).toBe(f.deliveries[1].name);
      expect(f.errors, unavailable).toEqual([null]);
      expectIdle(host);
      host.unmount();
    }
  });

  it("keeps rejected fresh and recovered task names when retried on the same page", async () => {
    const useTask = await loadUseStatueTask();
    for (const origin of ["fresh", "recovered"] as const) {
      const f = fixture();
      const previous = "fedcba987654";
      const id = "1a2b3c000007";
      const expectedName = `${origin === "fresh" ? "My.figure.front" : "recovered"}-statue-${id}.stl`;
      const expectedErrors = origin === "fresh" ? [null, "delivery failed"] : ["delivery failed"];
      f.values.set(KEY, previous);
      f.create.mockResolvedValue(id);
      if (origin === "recovered") f.latest.mockResolvedValue(latest({ id }));
      f.deliver.mockImplementationOnce(async (value) => {
        f.deliveries.push(value);
        throw new Error("delivery failed");
      });
      const host = mount(useTask, f);
      await settle(host);
      const done = origin === "fresh" ? host.value.start(input()) : Promise.resolve();
      await settle(host);
      await tick(host);
      await done;
      expect(f.deliveries.map((value) => value.name), origin).toEqual([expectedName]);
      expect(f.values.get(KEY), origin).toBe(previous);
      expect(f.errors, origin).toEqual(expectedErrors);
      expectIdle(host);

      // A new delivery callback causes the mounted hook to reconsider the
      // latest task through its existing recovery effect. No reload occurs.
      f.latest.mockResolvedValue(latest({ id }));
      const delivery = deferred<void>();
      f.deliver = vi.fn(async (value: Delivery) => {
        f.deliveries.push(value);
        await delivery.promise;
      });
      host.render();
      await settle(host);
      await tick(host);
      expect(f.deliveries.map((value) => value.taskId), origin).toEqual([id, id]);
      expect(f.deliveries.map((value) => value.name), origin).toEqual([expectedName, expectedName]);
      expect(f.values.get(KEY), origin).toBe(previous);
      expect(host.value.progress?.phase, origin).toBe("converting");
      await host.value.start(input());
      expect(f.create, origin).toHaveBeenCalledTimes(origin === "fresh" ? 1 : 0);
      delivery.resolve();
      await settle(host);
      expect(f.values.get(KEY), origin).toBe(id);
      expect(f.errors, origin).toEqual(expectedErrors);
      expectIdle(host);
      host.unmount();
    }
  });
});

