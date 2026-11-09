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

// These interfaces describe the proposed public hook boundary. The new module
// is deliberately loaded at runtime: the independent base must type-check and
// reach an assertion even though the hook does not exist on that base.
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

describe("statue task hook", () => {
  it("starts one task and awaits delivery with the original progress and metadata", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const health = deferred<StatueHealth | null>();
    const download = deferred<ArrayBuffer>();
    const delivery = deferred<void>();
    f.health.mockImplementationOnce(() => health.promise);
    f.download.mockImplementationOnce(() => download.promise);
    f.deliver.mockImplementationOnce(async (value) => {
      f.deliveries.push(value);
      await delivery.promise;
    });
    f.poll.mockResolvedValueOnce(status({ status: "queued", detail: "", elapsed_seconds: 4 }))
      .mockResolvedValueOnce(status({ status: "running", detail: "sculpting", elapsed_seconds: 8 }))
      .mockResolvedValueOnce(status({
        model_format: "obj", engine: "hunyuan", seed: 0, octree: "1024",
        repair_warning: "repair unavailable",
      }));
    const host = mount(useTask, f);
    await settle(host);
    expectIdle(host);
    const request = input("hunyuan-space");
    const done = host.value.start(request);
    await settle(host);
    expect(host.value.progress).toEqual({
      uploadPath: request.sourcePath, phase: "starting",
      detail: "contacting statue service…", elapsedSeconds: 0,
    });
    await host.value.start(request);
    expect(f.health).toHaveBeenCalledTimes(1);
    expect(f.errors).toEqual([null]);
    health.resolve(healthy());
    await settle(host);
    expect(f.create).toHaveBeenCalledExactlyOnceWith(request.images, "hunyuan-space");
    await tick(host, 3999);
    expect(f.poll).not.toHaveBeenCalled();
    await tick(host, 1);
    expect(f.poll).toHaveBeenCalledExactlyOnceWith("new-task");
    expect(host.value.progress).toEqual({
      uploadPath: request.sourcePath, phase: "generating", detail: "queued", elapsedSeconds: 4,
    });
    await host.value.start(request);
    await tick(host);
    expect(host.value.progress).toEqual({
      uploadPath: request.sourcePath, phase: "generating", detail: "sculpting", elapsedSeconds: 8,
    });
    await tick(host);
    expect(host.value.progress).toEqual({
      uploadPath: request.sourcePath, phase: "converting", detail: "converting to STL…", elapsedSeconds: 0,
    });
    expect(f.download).toHaveBeenCalledExactlyOnceWith("new-task");
    expect(f.deliver).not.toHaveBeenCalled();
    await host.value.start(request);
    download.resolve(f.model);
    await settle(host);
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith({
      taskId: "new-task", name: "My.figure.front-statue.stl", model: f.model,
      format: "obj", sourcePath: request.sourcePath,
      note: "hunyuan · seed 0 · octree 1024", repairWarning: "repair unavailable",
    });
    await host.value.start(request);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(host.value.progress?.phase).toBe("converting");
    delivery.resolve();
    await done;
    await settle(host);
    expectIdle(host);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    const again = host.value.start(input("space"));
    await settle(host);
    await tick(host);
    await again;
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });

  it("resets poll failures after a response and stops at the fifth consecutive failure", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    for (let i = 0; i < 4; i++) f.poll.mockRejectedValueOnce(new Error("temporary outage"));
    f.poll.mockResolvedValueOnce(status({ status: "running", detail: "back", elapsed_seconds: 20 }));
    for (let i = 0; i < 4; i++) f.poll.mockRejectedValueOnce(new Error("temporary outage"));
    f.poll.mockResolvedValueOnce(status());
    const host = mount(useTask, f);
    await settle(host);
    const done = host.value.start(input());
    await settle(host);
    for (let i = 1; i <= 9; i++) {
      await tick(host);
      expect(f.poll).toHaveBeenCalledTimes(i);
      expect(f.errors).toEqual([null]);
      expect(f.deliver).not.toHaveBeenCalled();
    }
    await tick(host);
    await done;
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expectIdle(host);

    f.poll.mockClear();
    for (let i = 1; i <= 5; i++) f.poll.mockRejectedValueOnce(new Error(`outage ${i}`));
    const failed = host.value.start(input());
    await settle(host);
    for (let i = 1; i <= 4; i++) {
      await tick(host);
      expect(host.value.progress).not.toBeNull();
      expect(f.errors).toEqual([null, null]);
    }
    await tick(host);
    await failed;
    expect(f.errors).toEqual([null, null, "outage 5"]);
    expectIdle(host);
    await tick(host, 12000);
    expect(f.poll).toHaveBeenCalledTimes(5);
    expect(f.download).toHaveBeenCalledTimes(1);
    const retry = host.value.start(input());
    await settle(host);
    await tick(host);
    await retry;
    expect(f.deliver).toHaveBeenCalledTimes(2);
  });

  it("preserves health checks engine readiness and generation error messages", async () => {
    const useTask = await loadUseStatueTask();
    const cases: { engine: StatueEngine; health?: StatueHealth | null; error?: unknown; message: string }[] = [
      { engine: "hunyuan", health: null,
        message: "The statue service is not running. Start it in a terminal:  uv run statue-service/server.py" },
      { engine: "hunyuan", health: healthy({ engines: { hunyuan: false, space: true } }),
        message: "Unlimited on-device generation needs a one-time install: run statue-service/setup.sh --local-engine (Apple silicon, ~15GB of weights). Or pick a cloud engine in the header — those work on any machine." },
      { engine: "space", health: healthy({ engines: { hunyuan: true, space: false } }),
        message: "Run statue-service/setup.sh to turn on photo-to-3D. It is small, works on any machine, and takes about a minute." },
      { engine: "hunyuan-space", health: healthy({ engines: { hunyuan: true, space: false } }),
        message: "Run statue-service/setup.sh to turn on photo-to-3D. It is small, works on any machine, and takes about a minute." },
      { engine: "hunyuan", health: healthy({ busy: true }),
        message: "The statue service is already generating a model." },
      { engine: "space", error: new Error("ZeroGPU quota exceeded"),
        message: "Today's free GPU quota for statue generation is used up (about 2 statues/day on a free Hugging Face account). It resets 24 hours after the first generation — try again later." },
      { engine: "hunyuan-space", error: new Error("A task is already being generated"),
        message: "A statue is already generating — it keeps running even across page reloads, and the app reconnects to it automatically. Give it a minute or two." },
      { engine: "hunyuan", error: "plain rejection", message: "plain rejection" },
    ];
    for (const example of cases) {
      const f = fixture();
      if (example.health !== undefined) f.health.mockResolvedValueOnce(example.health);
      if (example.error !== undefined) f.create.mockRejectedValueOnce(example.error);
      const host = mount(useTask, f);
      await settle(host);
      await host.value.start(input(example.engine));
      await settle(host);
      expect(f.errors).toEqual([null, example.message]);
      expect(f.create).toHaveBeenCalledTimes(example.error === undefined ? 0 : 1);
      expect(f.poll).not.toHaveBeenCalled();
      expect(f.download).not.toHaveBeenCalled();
      expect(f.deliver).not.toHaveBeenCalled();
      expectIdle(host);
      const retry = host.value.start(input(example.engine));
      await settle(host);
      await tick(host);
      await retry;
      expect(f.deliver).toHaveBeenCalledTimes(1);
      host.unmount();
    }
  });

  it("preserves failed tasks format defaults and download or delivery errors", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const host = mount(useTask, f);
    await settle(host);
    for (const message of ["model failed", null]) {
      f.poll.mockResolvedValueOnce(status({ status: "failed", error: message }));
      const done = host.value.start(input());
      await settle(host);
      await tick(host);
      await done;
      expect(f.errors[f.errors.length - 1]).toBe(message || "generation failed");
      expectIdle(host);
    }
    expect(f.download).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    for (const format of [null, "stl", "obj"] as const) {
      f.poll.mockResolvedValueOnce(status({ model_format: format }));
      const done = host.value.start({ ...input(), sourceName: "photo" });
      await settle(host);
      await tick(host);
      await done;
      expect(f.deliver).toHaveBeenLastCalledWith({
        taskId: "new-task", name: "photo-statue.stl", model: f.model,
        format: format ?? "glb", sourcePath: "/uploads/front.png",
        note: undefined, repairWarning: null,
      });
      expectIdle(host);
    }
    f.download.mockRejectedValueOnce(new Error("could not download the generated model (503)"));
    const failedDownload = host.value.start(input());
    await settle(host);
    await tick(host);
    await failedDownload;
    expect(f.errors[f.errors.length - 1]).toBe("could not download the generated model (503)");
    expect(f.deliver).toHaveBeenCalledTimes(3);
    expectIdle(host);
    f.deliver.mockRejectedValueOnce(new Error("The generated model is empty"));
    const failedDelivery = host.value.start(input());
    await settle(host);
    await tick(host);
    await failedDelivery;
    expect(f.errors[f.errors.length - 1]).toBe("The generated model is empty");
    expectIdle(host);
  });

  it("recovers only eligible latest tasks and retains the known recovery behavior", async () => {
    const useTask = await loadUseStatueTask();
    for (const remote of [null, latest({ status: "failed" }), latest({ age_seconds: 600 }), latest({ age_seconds: 900 })]) {
      const f = fixture();
      f.latest.mockResolvedValue(remote);
      const host = mount(useTask, f);
      await settle(host);
      await tick(host, 12000);
      expectIdle(host);
      expect(f.poll).not.toHaveBeenCalled();
      expect(f.deliver).not.toHaveBeenCalled();
      host.unmount();
    }
    for (const remote of [latest({ status: "queued", age_seconds: 900 }), latest({ status: "running", age_seconds: 900 }), latest({ age_seconds: 599.999 })]) {
      const f = fixture();
      f.latest.mockResolvedValue(remote);
      let host = mount(useTask, f);
      await settle(host);
      expect(host.value.progress).toEqual({
        uploadPath: "", phase: "generating", detail: "reconnected to a statue in progress…", elapsedSeconds: 0,
      });
      expect(f.health).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
      await tick(host, 3999);
      expect(f.poll).not.toHaveBeenCalled();
      await tick(host, 1);
      expect(f.poll).toHaveBeenCalledExactlyOnceWith(remote.id);
      const expected: Delivery = {
        taskId: remote.id, name: "recovered-statue.stl", model: f.model,
        format: "stl", sourcePath: null, note: undefined, repairWarning: null,
      };
      expect(f.deliveries).toEqual([expected]);
      expectIdle(host);
      expect(f.storage.setItem).not.toHaveBeenCalled();
      host.unmount();

      // Deliberately preserve the issue's first bug: delivered is not dismissed.
      f.latest.mockResolvedValue(latest({ id: remote.id, age_seconds: 30 }));
      host = mount(useTask, f);
      await settle(host);
      await tick(host);
      expect(f.deliveries).toEqual([expected, expected]);
      host.unmount();

      // Deliberately preserve the other bug: another recovery has the same name.
      f.latest.mockResolvedValue(latest({ id: "another-task" }));
      host = mount(useTask, f);
      await settle(host);
      await tick(host);
      expect(f.deliveries[2]).toEqual({ ...expected, taskId: "another-task" });
      host.unmount();
    }
  });

  it("persists dismissal without cancelling delivery and tolerates unavailable storage", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    let host = mount(useTask, f);
    await settle(host);
    host.value.dismiss();
    expect(f.storage.setItem).not.toHaveBeenCalled();
    const done = host.value.start(input());
    await settle(host);
    host.value.dismiss();
    expect(f.storage.setItem).toHaveBeenCalledExactlyOnceWith(KEY, "new-task");
    expect(host.value.progress).not.toBeNull();
    await tick(host);
    await done;
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.values.get(KEY)).toBe("new-task");
    host.unmount();

    f.latest.mockResolvedValue(latest({ id: "new-task" }));
    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expectIdle(host);
    expect(f.storage.getItem).toHaveBeenCalledWith(KEY);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    host.unmount();

    f.latest.mockResolvedValue(latest({ id: "other-task" }));
    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliver).toHaveBeenCalledTimes(2);
    host.value.dismiss();
    expect(f.values.get(KEY)).toBe("other-task");
    host.unmount();

    f.storageState.failRead = true;
    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    expect(f.deliver).toHaveBeenCalledTimes(3);
    f.storageState.failWrite = true;
    expect(() => host.value.dismiss()).not.toThrow();
    expect(f.errors).toEqual([null]);
    expectIdle(host);
  });

  it("ignores late recovery after start or unmount and keeps recovery errors verbatim", async () => {
    const useTask = await loadUseStatueTask();
    const f = fixture();
    const remote = deferred<LatestStatueTask | null>();
    f.latest.mockImplementationOnce(() => remote.promise);
    let host = mount(useTask, f);
    const done = host.value.start(input());
    await settle(host);
    remote.resolve(latest());
    await settle(host);
    await tick(host);
    await done;
    expect(f.poll).toHaveBeenCalledExactlyOnceWith("new-task");
    expect(f.deliveries.map((value) => value.taskId)).toEqual(["new-task"]);
    host.unmount();

    const afterUnmount = deferred<LatestStatueTask | null>();
    f.latest.mockImplementationOnce(() => afterUnmount.promise);
    host = mount(useTask, f);
    host.unmount();
    afterUnmount.resolve(latest());
    await settle(host);
    await tick(host);
    expect(f.poll).toHaveBeenCalledTimes(1);

    f.latest.mockResolvedValue(latest());
    f.poll.mockResolvedValueOnce(status({ status: "failed", error: "ZeroGPU quota: raw recovery failure" }));
    host = mount(useTask, f);
    await settle(host);
    await host.value.start(input());
    expect(f.create).toHaveBeenCalledTimes(1);
    await tick(host);
    expect(f.errors).toEqual([null, "ZeroGPU quota: raw recovery failure"]);
    expectIdle(host);
    host.unmount();

    const delivery = deferred<void>();
    f.deliver.mockImplementationOnce(async () => { await delivery.promise; });
    host = mount(useTask, f);
    await settle(host);
    await tick(host);
    await host.value.start(input());
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(host.value.progress?.phase).toBe("converting");
    delivery.resolve();
    await settle(host);
    expectIdle(host);
  });
});
