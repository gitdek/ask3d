import { describe, expect, it } from "vitest";
import * as React from "react";
import { MAX_REPAIR_ATTEMPTS, useAutoRepair } from "../../hooks/use-auto-repair";
import { AUTO_REPAIR_PREFIX } from "../ai/system-prompt";
import { extractLastScadBlock } from "../scad/extract";
import type { CompileFailure, CompileSuccess, ScadError } from "../scad/types";

// These tests hold what the repair loop does: what a finished reply, a
// compile result and a compile failure lead to, and what a human message,
// the timeout's Retry and a replaced model reset.

// A host for React 19 hooks with an in-memory dispatcher, as the statue
// task's tests use: the real hook runs, with its state, refs, callbacks and
// effects, and no DOM. A state change renders again, as React would.
type Cleanup = () => void;
type Cell = { kind: string; value?: unknown; deps?: readonly unknown[]; cleanup?: Cleanup };

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) {
  return a !== undefined && b !== undefined && a.length === b.length
    && a.every((value, i) => Object.is(value, b[i]));
}

class HookHost<T> {
  private cells: Cell[] = [];
  private cursor = 0;
  private effects: Cleanup[] = [];
  private dirty = false;
  value!: T;

  constructor(private readonly hook: () => T) {}

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
          const next = typeof update === "function" ? update(state.current) : update;
          if (!Object.is(next, state.current)) this.dirty = true;
          state.current = next;
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
    for (let pass = 0; pass < 10; pass++) {
      this.dirty = false;
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
      if (!this.dirty) return;
    }
    throw new Error("the hook never settled");
  }
}

type Tri = [number[], number[], number[]];

function stlOf(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  tris.forEach((tri, t) => {
    const base = 84 + t * 50 + 12;
    tri.forEach((v, i) => {
      view.setFloat32(base + i * 12, v[0], true);
      view.setFloat32(base + i * 12 + 4, v[1], true);
      view.setFloat32(base + i * 12 + 8, v[2], true);
    });
  });
  return buf;
}

function tet(ox: number, oy: number, oz: number, s = 1): Tri[] {
  const a = [ox, oy, oz];
  const b = [ox + s, oy, oz];
  const c = [ox, oy + s, oz];
  const d = [ox, oy, oz + s];
  return [[a, b, c], [a, b, d], [a, c, d], [b, c, d]];
}

const SOLID = stlOf(tet(0, 0, 0, 20));
const WITH_DEBRIS = stlOf([...tet(0, 0, 0, 20), ...tet(100, 100, 100, 0.5)]);
const EMPTY = stlOf([]);

const reply = (body: string) => `Here it is.\n\`\`\`openscad\n${body}\n\`\`\`\n`;
const program = (body: string) => extractLastScadBlock(reply(body))!;
const A = program("cube(10);");
const B = program("cube(11);");
const C = program("cube(12);");

interface Shown {
  title: string;
  hint: string;
  errors: ScadError[];
  stderr: string[];
  retry?: { label: string; run: () => void };
}

function loop() {
  const io = {
    status: "ready" as "submitted" | "streaming" | "ready" | "error",
    reply: null as string | null,
    result: null as CompileSuccess | null,
    failure: null as CompileFailure | null,
    lintErrors: [] as ScadError[],
    linted: [] as string[],
    failures: 0,
    compiles: [] as { source: string; options?: { timeoutMs?: number } }[],
    cancels: 0,
    repairs: [] as string[],
    errors: [] as (Shown | null)[],
    shown: [] as CompileSuccess[],
    accepted: [] as CompileSuccess[],
  };
  let compile = (source: string, options?: { timeoutMs?: number }) => {
    io.compiles.push({ source, options });
  };
  const cancel = () => {
    io.cancels += 1;
  };
  const lint = (source: string) => {
    io.linted.push(source);
    return io.lintErrors;
  };
  let sendRepair = (text: string) => {
    io.repairs.push(text);
  };
  const showError = (error: Shown | null) => {
    io.errors.push(error);
  };
  let onModel = (result: CompileSuccess) => {
    io.shown.push(result);
  };
  let onAccepted = (result: CompileSuccess) => {
    io.accepted.push(result);
  };
  const host = new HookHost(() =>
    useAutoRepair({
      status: io.status, reply: io.reply, result: io.result, failure: io.failure,
      compile, cancel, lint, sendRepair, showError, onModel, onAccepted,
    }),
  );
  host.render();
  return {
    io,
    get attempt() {
      return host.value.attempt;
    },
    get error() {
      return io.errors.at(-1) ?? null;
    },
    /** The chat streams a reply, a chunk at a time, and finishes. */
    says(text: string) {
      io.status = "submitted";
      host.render();
      io.status = "streaming";
      io.reply = text.slice(0, Math.ceil(text.length / 2));
      host.render();
      io.reply = text;
      host.render();
      io.status = "ready";
      host.render();
    },
    succeeds(source: string, stl: ArrayBuffer) {
      io.result = { source, stl, stderr: [] };
      host.render();
      return io.result;
    },
    /** Each failure has errors of its own, so a test can tell which one is shown. */
    fails(source: string, kind: CompileFailure["kind"] = "compile") {
      const n = ++io.failures;
      io.failure = {
        source, kind,
        errors: [{ message: `Parser error ${n}: syntax error`, line: 2 + n }],
        stderr: [`ERROR: Parser error ${n}: syntax error in file, line ${2 + n}`],
      };
      host.render();
      return io.failure;
    },
    /** The compiler hands back a result or a failure it gave before. */
    redelivers(earlier: CompileSuccess | CompileFailure) {
      if ("stl" in earlier) io.result = earlier;
      else io.failure = earlier;
      host.render();
    },
    /** A render in which every callback the component passes is a new one. */
    churn() {
      const [compiled, repaired] = [compile, sendRepair];
      compile = (source, options) => compiled(source, options);
      sendRepair = (text) => repaired(text);
      onModel = (result) => {
        io.shown.push(result);
      };
      onAccepted = (result) => {
        io.accepted.push(result);
      };
      host.render();
    },
    /** A render with the chat as it is: its status, and whatever its last reply says now. */
    renders(text: string | null) {
      io.reply = text;
      host.render();
    },
    humanMessage() {
      host.value.reset();
      host.render();
    },
    modelReplaced() {
      host.value.modelReplaced();
      host.render();
    },
    expect(source: string) {
      host.value.expect(source);
      host.render();
    },
  };
}

describe("useAutoRepair", () => {
  it("lints and compiles a finished reply's program, once", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    expect(l.io.linted).toEqual([A]);
    expect(l.io.compiles).toEqual([{ source: A, options: undefined }]);
    expect(l.io.repairs).toEqual([]);
    expect(l.io.errors).toEqual([null]);
    expect(l.attempt).toBe(0);
  });

  it("acts on a reply when the chat finishes, not on a render while it's ready", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.renders(reply("cube(11);"));
    l.renders(reply("cube(12);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A]);
  });

  it("does nothing before the chat has an assistant message, or for a reply with no program", () => {
    const l = loop();
    // The chat is busy and finishes with no assistant message at all.
    l.io.status = "submitted";
    l.renders(null);
    l.io.status = "ready";
    l.renders(null);
    expect(l.io.linted).toEqual([]);
    l.says("That shape can't be printed without supports.\n```openscad\ncube(");
    expect(l.io.linted).toEqual([]);
    expect(l.io.compiles).toEqual([]);
    expect(l.io.errors).toEqual([]);
  });

  it("shows a compiled model, accepts it and leaves no attempt behind", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    const result = l.succeeds(A, SOLID);
    expect(l.io.shown).toEqual([result]);
    expect(l.io.accepted).toEqual([result]);
    expect(l.attempt).toBe(0);
  });

  it(`repairs a compile error ${MAX_REPAIR_ATTEMPTS} times for one human message, then gives up`, () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.io.repairs[0].startsWith(AUTO_REPAIR_PREFIX)).toBe(true);
    expect(l.io.repairs[0]).toContain("Line 3: Parser error 1: syntax error");
    expect(l.io.repairs[0]).toContain("ERROR: Parser error 1: syntax error in file, line 3");
    expect(l.attempt).toBe(1);
    l.says(reply("cube(11);"));
    l.fails(B);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.repairs[1]).toContain("Line 4: Parser error 2: syntax error");
    expect(l.attempt).toBe(2);
    l.says(reply("cube(12);"));
    const last = l.fails(C);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B, C]);
    // The errors shown are those of the failure that spent the attempts.
    expect(l.error).toEqual({
      title: "Compile failed after 2 automatic fix attempts",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: last.errors,
      stderr: last.stderr,
    });
  });

  it("gives up on a third lint failure, and on a third empty model, as on a third compile error", () => {
    const l = loop();
    l.io.lintErrors = [{ message: "import() of a file that wasn't attached", line: 1 }];
    l.says(reply("cube(10);"));
    l.says(reply("cube(11);"));
    l.says(reply("cube(12);"));
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.compiles).toEqual([]);
    expect(l.error).toEqual({
      title: "Compile failed after 2 automatic fix attempts",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: l.io.lintErrors,
      stderr: [],
    });
    const m = loop();
    m.says(reply("cube(10);"));
    m.succeeds(A, EMPTY);
    m.says(reply("cube(11);"));
    m.succeeds(B, EMPTY);
    m.says(reply("cube(12);"));
    m.succeeds(C, EMPTY);
    expect(m.io.repairs).toHaveLength(2);
    expect(m.io.shown).toEqual([]);
    expect(m.error?.title).toBe("Compile failed after 2 automatic fix attempts");
    expect(m.error?.errors[0].message).toContain("produced NO geometry");
  });

  it("takes a reply that finishes after the chat reported an error", () => {
    const l = loop();
    l.io.status = "error";
    l.renders(reply("cube(10);"));
    l.io.status = "ready";
    l.renders(reply("cube(10);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A]);
  });

  it("counts a lint failure as an attempt, without compiling", () => {
    const l = loop();
    l.io.lintErrors = [{ message: "import() of a file that wasn't attached", line: 1 }];
    l.says(reply("cube(10);"));
    expect(l.io.compiles).toEqual([]);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.io.repairs[0]).toContain("Line 1: import() of a file that wasn't attached");
    expect(l.attempt).toBe(1);
  });

  it("counts a reply that re-emits the failing program as another attempt, without compiling again", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    const failure = l.fails(A);
    l.says(reply("cube(10);"));
    expect(l.io.compiles).toHaveLength(1);
    expect(l.io.linted).toEqual([A]);
    expect(l.io.repairs).toHaveLength(2);
    // The second repair carries the errors the first one was sent for.
    expect(l.io.repairs[1]).toBe(l.io.repairs[0]);
    expect(l.io.repairs[1]).toContain("Line 3: Parser error 1: syntax error");
    l.says(reply("cube(10);"));
    expect(l.io.compiles).toHaveLength(1);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.error).toEqual({
      title: "Compile failed after 2 automatic fix attempts",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: failure.errors,
      stderr: failure.stderr,
    });
  });

  it("shows the stored errors when a repair reply has no program, and resets", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    const failure = l.fails(A);
    l.says("Sorry, here is the fix:\n```openscad\ncube(");
    expect(l.error).toEqual({
      title: "The automatic fix attempt didn't produce code",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: failure.errors,
      stderr: failure.stderr,
    });
    expect(l.attempt).toBe(0);
    expect(l.io.repairs).toHaveLength(1);
  });

  it("shows a timeout with a retry, and takes the retry's result after a human message", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A, "timeout");
    expect(l.io.repairs).toEqual([]);
    expect(l.error?.title).toBe("Render timed out");
    expect(l.error?.retry?.label).toBe("Retry with a 5-minute limit");
    l.humanMessage();
    expect(l.io.cancels).toBe(1);
    l.error!.retry!.run();
    expect(l.error).toBeNull();
    expect(l.io.compiles.at(-1)).toEqual({ source: A, options: { timeoutMs: 300_000 } });
    const result = l.succeeds(A, SOLID);
    expect(l.io.accepted).toEqual([result]);
  });

  it("shows an environment failure without repairing it", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A, "environment");
    expect(l.io.repairs).toEqual([]);
    expect(l.error?.title).toBe("The 3D compiler failed to load");
    expect(l.error?.retry).toBeUndefined();
  });

  it("drops a result and a failure for anything but the latest program", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.humanMessage();
    l.succeeds(A, SOLID);
    l.fails(A);
    expect(l.io.shown).toEqual([]);
    expect(l.io.accepted).toEqual([]);
    expect(l.io.repairs).toEqual([]);
    l.says(reply("cube(11);"));
    l.succeeds(A, SOLID);
    l.fails(A);
    expect(l.io.shown).toEqual([]);
    expect(l.io.repairs).toEqual([]);
    // A timeout and a compiler that didn't load are shown, so a stale one
    // would put an error up for a program the chat has moved on from.
    const errors = l.io.errors.length;
    l.fails(A, "timeout");
    l.fails(A, "environment");
    expect(l.io.errors).toHaveLength(errors);
  });

  it("handles each result and each failure once, whatever renders again", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, SOLID);
    l.churn();
    l.churn();
    expect(l.io.shown).toHaveLength(1);
    expect(l.io.accepted).toHaveLength(1);
    l.says(reply("cube(11);"));
    l.fails(B);
    l.churn();
    l.churn();
    expect(l.io.repairs).toHaveLength(1);
  });

  it("repairs a program that makes no geometry, without showing it", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, EMPTY);
    expect(l.io.shown).toEqual([]);
    expect(l.io.accepted).toEqual([]);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.io.repairs[0]).toContain("The program compiled but produced NO geometry.");
    expect(l.attempt).toBe(1);
  });

  it("shows a model with debris and repairs it while attempts remain", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    const result = l.succeeds(A, WITH_DEBRIS);
    expect(l.io.shown).toEqual([result]);
    expect(l.io.accepted).toEqual([]);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.io.repairs[0]).toContain("has 1 small disconnected piece(s) floating in the air (2 separate solids total)");
  });

  it("accepts a model with debris once the attempts are spent", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    l.says(reply("cube(11);"));
    l.fails(B);
    l.says(reply("cube(12);"));
    const result = l.succeeds(C, WITH_DEBRIS);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.shown).toEqual([result]);
    expect(l.io.accepted).toEqual([result]);
    expect(l.attempt).toBe(0);
  });

  it("does nothing for the program already showing, until the model is replaced", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, SOLID);
    l.says(reply("cube(10);"));
    expect(l.io.compiles).toHaveLength(1);
    l.modelReplaced();
    l.says(reply("cube(10);"));
    expect(l.io.compiles).toHaveLength(2);
  });

  it("gives a human message a fresh set of attempts, and cancels the compile in flight", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    expect(l.attempt).toBe(1);
    l.humanMessage();
    expect(l.attempt).toBe(0);
    expect(l.io.cancels).toBe(1);
    l.says(reply("cube(11);"));
    l.fails(B);
    l.says(reply("cube(12);"));
    l.fails(C);
    expect(l.io.repairs).toHaveLength(3);
    expect(l.attempt).toBe(2);
  });

  it("takes the result of a compile started outside the chat", () => {
    const l = loop();
    l.expect("sphere(5);");
    const result = l.succeeds("sphere(5);", SOLID);
    expect(l.io.accepted).toEqual([result]);
  });

  it(`sends ${MAX_REPAIR_ATTEMPTS} repairs for one human message, whatever rounds they're sent in`, () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    l.says(reply("cube(11);"));
    l.succeeds(B, SOLID);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.attempt).toBe(0);
    // A compile started outside the chat fails. The round it starts counts
    // from one, and takes the human message's second repair.
    l.expect("sphere(5);");
    l.fails("sphere(5);");
    expect(l.io.repairs).toHaveLength(2);
    expect(l.attempt).toBe(1);
    l.says(reply("cube(12);"));
    const last = l.fails(C);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.error).toEqual({
      title: "Compile failed after 2 automatic fix attempts",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: last.errors,
      stderr: last.stderr,
    });
    // A model with debris is accepted as it is, once the two are sent.
    l.expect("sphere(6);");
    const debris = l.succeeds("sphere(6);", WITH_DEBRIS);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.accepted.at(-1)).toBe(debris);
    // A human message gives the replies that follow a fresh two.
    l.humanMessage();
    l.says(reply("cube(10);"));
    l.fails(A);
    expect(l.io.repairs).toHaveLength(3);
  });

  it("counts a round's attempts from one after an error ended the round before", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    expect(l.attempt).toBe(1);
    l.says(reply("cube(11);"));
    l.fails(B, "timeout");
    expect(l.attempt).toBe(0);
    // The retry's compile fails: the message's second repair, and the first
    // attempt of the round the retry started.
    l.error!.retry!.run();
    l.fails(B);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.attempt).toBe(1);
  });

  it("doesn't give the timeout's retry a fresh set of repairs", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    l.says(reply("cube(11);"));
    l.fails(B);
    l.says(reply("cube(12);"));
    l.fails(C, "timeout");
    l.error!.retry!.run();
    const last = l.fails(C);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.error).toEqual({
      title: "Compile failed after 2 automatic fix attempts",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: last.errors,
      stderr: last.stderr,
    });
  });

  it("leaves no attempt counted, and no errors pending, once an error is shown", () => {
    for (const kind of ["timeout", "environment"] as const) {
      const l = loop();
      l.says(reply("cube(10);"));
      l.fails(A);
      expect(l.attempt).toBe(1);
      // A compile of the same program, started outside the chat, ends the
      // round with an error while the repair's errors are still pending.
      l.expect(A);
      l.fails(A, kind);
      expect(l.error?.title).toBe(kind === "timeout" ? "Render timed out" : "The 3D compiler failed to load");
      expect(l.attempt).toBe(0);
      // With nothing pending, the same program in a reply is a new program
      // to compile, not a repair that re-emitted the one that failed.
      l.says(reply("cube(10);"));
      expect(l.io.repairs).toHaveLength(1);
      expect(l.io.compiles.map((c) => c.source)).toEqual([A, A]);
    }
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A);
    l.says(reply("cube(11);"));
    l.fails(B);
    l.says(reply("cube(12);"));
    l.fails(C);
    expect(l.error?.title).toBe("Compile failed after 2 automatic fix attempts");
    expect(l.attempt).toBe(0);
  });

  it("shows the failing program's errors when a repair reply goes back to the model already showing", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, SOLID);
    l.humanMessage();
    l.says(reply("cube(11);"));
    const failure = l.fails(B);
    expect(l.attempt).toBe(1);
    l.says(reply("cube(10);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B]);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.error).toEqual({
      title: "The automatic fix attempt went back to the model already showing",
      hint: "Describe what to change in the chat and I'll try a different approach.",
      errors: failure.errors,
      stderr: failure.stderr,
    });
    expect(l.attempt).toBe(0);
    // The round is over. The same reply again is the program already
    // showing, and nothing more.
    const errors = l.io.errors.length;
    l.says(reply("cube(10);"));
    expect(l.io.errors).toHaveLength(errors);
    expect(l.io.compiles).toHaveLength(2);
    // A program that makes no geometry is never shown, so the model in the
    // viewer is still the first program's when a repair goes back to it.
    l.humanMessage();
    l.says(reply("cube(12);"));
    l.succeeds(C, EMPTY);
    expect(l.io.repairs).toHaveLength(2);
    l.says(reply("cube(10);"));
    expect(l.error?.title).toBe("The automatic fix attempt went back to the model already showing");
    expect(l.error?.errors[0].message).toContain("produced NO geometry");
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B, C]);
  });

  it("counts a repair that goes back to an accepted program that no longer lints as a failed attempt", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, SOLID);
    l.humanMessage();
    l.says(reply("cube(11);"));
    l.succeeds(B, WITH_DEBRIS);
    expect(l.io.repairs).toHaveLength(1);
    // A file the first program reads was taken away since it was accepted.
    l.io.lintErrors = [{ message: "import() of a file that wasn't attached", line: 1 }];
    const errors = l.io.errors.length;
    l.says(reply("cube(10);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B]);
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.repairs[1]).toContain("Line 1: import() of a file that wasn't attached");
    expect(l.attempt).toBe(2);
    // No error was cleared on the way, and the program the repair was for
    // is still the one a reply can re-emit.
    expect(l.io.errors).toHaveLength(errors);
    l.io.lintErrors = [];
    l.says(reply("cube(11);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B]);
    expect(l.error?.title).toBe("Compile failed after 2 automatic fix attempts");
    // With no repair pending, the accepted program is a new failure when it
    // doesn't lint: the error showing is cleared, and a repair goes out.
    const m = loop();
    m.says(reply("cube(10);"));
    m.succeeds(A, SOLID);
    m.humanMessage();
    m.says(reply("cube(11);"));
    m.succeeds(B, WITH_DEBRIS);
    m.says("I can't fix that one.");
    expect(m.error?.title).toBe("The automatic fix attempt didn't produce code");
    m.humanMessage();
    m.io.lintErrors = [{ message: "import() of a file that wasn't attached", line: 1 }];
    m.says(reply("cube(10);"));
    expect(m.io.repairs).toHaveLength(2);
    expect(m.io.errors.at(-1)).toBeNull();
    // A repair's reply with a program that was never accepted is a new
    // failure too: that program becomes the one a reply can re-emit.
    const n = loop();
    n.says(reply("cube(10);"));
    n.fails(A);
    n.io.lintErrors = [{ message: "import() of a file that wasn't attached", line: 1 }];
    n.says(reply("cube(11);"));
    expect(n.io.repairs).toHaveLength(2);
    expect(n.io.errors.at(-1)).toBeNull();
    n.io.lintErrors = [];
    n.says(reply("cube(11);"));
    expect(n.io.compiles.map((c) => c.source)).toEqual([A]);
    expect(n.error?.title).toBe("Compile failed after 2 automatic fix attempts");
  });

  it("compiles the accepted program again while another program's model is showing", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    const first = l.succeeds(A, SOLID);
    l.humanMessage();
    l.says(reply("cube(11);"));
    const debris = l.succeeds(B, WITH_DEBRIS);
    expect(l.io.shown.at(-1)).toBe(debris);
    expect(l.io.repairs).toHaveLength(1);
    // The repair goes back to the first program. Its model isn't the one
    // showing, so it compiles, and the viewer gets it back.
    l.says(reply("cube(10);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B, A]);
    expect(l.error).toBeNull();
    const again = l.succeeds(A, SOLID);
    expect(l.io.shown.at(-1)).toBe(again);
    expect(l.io.accepted).toEqual([first, again]);
    expect(l.attempt).toBe(0);
    // The same holds with no repair pending.
    l.humanMessage();
    l.says(reply("cube(11);"));
    l.succeeds(B, WITH_DEBRIS);
    l.says("I can't fix that one.");
    expect(l.error?.title).toBe("The automatic fix attempt didn't produce code");
    l.humanMessage();
    l.says(reply("cube(10);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B, A, B, A]);
  });

  it("handles a result and a failure once, however late the compiler hands them back", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    const first = l.succeeds(A, WITH_DEBRIS);
    l.succeeds(A, WITH_DEBRIS);
    expect(l.io.shown).toHaveLength(2);
    expect(l.io.repairs).toHaveLength(2);
    // The first result comes back after the second was handled.
    l.redelivers(first);
    expect(l.io.shown).toHaveLength(2);
    expect(l.io.accepted).toEqual([]);
    const m = loop();
    m.says(reply("cube(10);"));
    const failure = m.fails(A);
    const second = m.fails(A);
    expect(m.io.repairs).toHaveLength(2);
    const errors = m.io.errors.length;
    m.redelivers(failure);
    expect(m.io.errors).toHaveLength(errors);
    expect(m.attempt).toBe(2);
    // A human message doesn't make an old failure new. Each is handed back
    // in turn, so the hook sees a failure other than the one it holds.
    m.humanMessage();
    m.says(reply("cube(10);"));
    m.redelivers(second);
    m.redelivers(failure);
    expect(m.io.repairs).toHaveLength(2);
    expect(m.io.errors).toHaveLength(errors + 1);
  });

  it("takes a re-emitted program as the one that failed, wherever its compile started", () => {
    // The timeout's retry, after a human message.
    const l = loop();
    l.says(reply("cube(10);"));
    l.fails(A, "timeout");
    l.humanMessage();
    l.error!.retry!.run();
    l.fails(A);
    expect(l.io.repairs).toHaveLength(1);
    l.says(reply("cube(10);"));
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, A]);
    // A compile started outside the chat.
    const m = loop();
    m.expect("sphere(5);");
    m.fails("sphere(5);");
    m.says(reply("sphere(5);"));
    expect(m.io.repairs).toHaveLength(2);
    expect(m.io.compiles).toEqual([]);
  });

  it("forgets the program that failed, and the one that was showing, when they're gone", () => {
    // A human message: the program that failed before it is a new program.
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, SOLID);
    l.humanMessage();
    l.says(reply("cube(11);"));
    l.fails(B);
    l.humanMessage();
    // The reply is the program showing, so it's skipped. A failure for it,
    // wherever it comes from, is the current program's: a repair is pending.
    l.says(reply("cube(10);"));
    l.fails(A);
    expect(l.io.repairs).toHaveLength(2);
    l.says(reply("cube(11);"));
    expect(l.io.repairs).toHaveLength(2);
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B, B]);
    // A replaced model: the program that made it is a new program too, and
    // a repair that re-emits it has re-emitted the program that failed.
    const m = loop();
    m.says(reply("cube(10);"));
    m.succeeds(A, SOLID);
    m.modelReplaced();
    m.says(reply("cube(10);"));
    m.succeeds(A, WITH_DEBRIS);
    expect(m.io.repairs).toHaveLength(1);
    const errors = m.io.errors.length;
    m.says(reply("cube(10);"));
    expect(m.io.repairs).toHaveLength(2);
    expect(m.io.errors).toHaveLength(errors);
  });

  it("counts results for the chat's current program, and no other", () => {
    const l = loop();
    l.says(reply("cube(10);"));
    l.succeeds(A, SOLID);
    l.humanMessage();
    l.says(reply("cube(11);"));
    l.fails(B);
    // The repair's reply goes back to the first program, which is showing:
    // an error, and the first program is the chat's current one.
    l.says(reply("cube(10);"));
    const errors = l.io.errors.length;
    l.fails(B);
    l.fails(B, "timeout");
    l.succeeds(B, SOLID);
    expect(l.io.repairs).toHaveLength(1);
    expect(l.io.errors).toHaveLength(errors);
    expect(l.io.shown).toHaveLength(1);
    const again = l.succeeds(A, SOLID);
    expect(l.io.accepted.at(-1)).toBe(again);
    // A reply that's skipped makes its program the current one too.
    l.humanMessage();
    l.says(reply("cube(10);"));
    expect(l.io.compiles.map((c) => c.source)).toEqual([A, B]);
    l.fails(A, "environment");
    expect(l.error?.title).toBe("The 3D compiler failed to load");
  });
});
