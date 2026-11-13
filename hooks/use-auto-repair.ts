"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerError } from "../components/viewer-panel";
import { buildRepairMessage } from "../lib/ai/system-prompt";
import { analyzeStlComponents } from "../lib/scad/components";
import { extractLastScadBlock } from "../lib/scad/extract";
import type { CompileFailure, CompileSuccess, ScadError } from "../lib/scad/types";

export const MAX_REPAIR_ATTEMPTS = 2;

type ChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface AutoRepairOptions {
  /** The chat's status, as it reports it. */
  status: ChatStatus;
  /** The text of the chat's last assistant message, or null before there is one. */
  reply: string | null;
  /** The compiler's latest result and failure. */
  result: CompileSuccess | null;
  failure: CompileFailure | null;
  /** Starts a compile of a program, with the files attached now. */
  compile: (source: string, options?: { timeoutMs?: number }) => void;
  /** Cancels the compile in flight. */
  cancel: () => void;
  /** Lints a program before it compiles. */
  lint: (source: string) => ScadError[];
  /** Sends an automatic repair message into the chat. */
  sendRepair: (text: string) => void;
  /** Shows an error in the viewer, or clears it with null. */
  showError: (error: ViewerError | null) => void;
  /** A program compiled to geometry: show it, whatever is decided next. */
  onModel: (result: CompileSuccess) => void;
  /** The model shown is the request's answer: color it and save it. */
  onAccepted: (result: CompileSuccess) => void;
}

/**
 * Owns the loop that takes a chat reply's program to a model in the viewer:
 * lint, compile, and up to MAX_REPAIR_ATTEMPTS automatic repair messages for
 * one human message when the program, or the geometry it makes, is at fault.
 */
export function useAutoRepair({
  status,
  reply,
  result,
  failure,
  compile,
  cancel,
  lint,
  sendRepair,
  showError,
  onModel,
  onAccepted,
}: AutoRepairOptions) {
  const [attempt, setAttempt] = useState(0);
  const repairAttemptsRef = useRef(0);
  const lastCompiledSourceRef = useRef<string | null>(null);
  const lastSuccessfulSourceRef = useRef<string | null>(null);
  // Errors that triggered the in-flight repair round — consumed when the
  // repair reply re-emits identical code or contains no code at all.
  const pendingRepairRef = useRef<{ errors: ScadError[]; stderr: string[] } | null>(null);
  // Each compile result/failure is handled exactly once: the effects below
  // re-fire on dependency identity churn, and a second pass would send a
  // second repair message, re-save the library entry, or wipe finished
  // color parts.
  const handledResultRef = useRef<CompileSuccess | null>(null);
  const handledFailureRef = useRef<CompileFailure | null>(null);
  const prevChatStatusRef = useRef(status);

  const beginRepairOrFail = useCallback(
    (source: string, errors: ScadError[], stderr: string[]) => {
      if (source !== lastCompiledSourceRef.current) return;
      if (repairAttemptsRef.current < MAX_REPAIR_ATTEMPTS) {
        repairAttemptsRef.current += 1;
        setAttempt(repairAttemptsRef.current);
        pendingRepairRef.current = { errors, stderr };
        const lines = errors.map((e) =>
          e.line !== undefined ? `Line ${e.line}: ${e.message}` : e.message,
        );
        sendRepair(buildRepairMessage(lines, stderr));
      } else {
        pendingRepairRef.current = null;
        showError({
          title: `Compile failed after ${MAX_REPAIR_ATTEMPTS} automatic fix attempts`,
          hint: "Describe what to change in the chat and I'll try a different approach.",
          errors,
          stderr,
        });
      }
    },
    [sendRepair, showError],
  );

  // Chat stream finished → extract fence → lint → compile.
  useEffect(() => {
    const finished = prevChatStatusRef.current !== "ready" && status === "ready";
    prevChatStatusRef.current = status;
    if (!finished) return;
    if (reply === null) return;
    let code = extractLastScadBlock(reply);
    if (!code) {
      // Mid-repair, a reply without code (prose apology, truncated fence) is
      // itself a failure — surface the stored errors instead of going silent.
      if (repairAttemptsRef.current > 0 && pendingRepairRef.current) {
        showError({
          title: "The automatic fix attempt didn't produce code",
          hint: "Describe what to change in the chat and I'll try a different approach.",
          errors: pendingRepairRef.current.errors,
          stderr: pendingRepairRef.current.stderr,
        });
        repairAttemptsRef.current = 0;
        setAttempt(0);
        pendingRepairRef.current = null;
      }
      return;
    }
    if (process.env.NEXT_PUBLIC_DEBUG_BREAK === "1") code += "\nthis_is_a_debug_syntax_error(";
    // Unchanged code that already compiled successfully: nothing to do.
    if (code === lastSuccessfulSourceRef.current) return;
    // The model re-emitted the failing program verbatim: count it as another
    // failed round (or exhaust) rather than silently stalling the loop.
    if (code === lastCompiledSourceRef.current && pendingRepairRef.current) {
      const pending = pendingRepairRef.current;
      beginRepairOrFail(code, pending.errors, pending.stderr);
      return;
    }
    lastCompiledSourceRef.current = code;
    showError(null);
    pendingRepairRef.current = null;
    const lintErrors = lint(code);
    if (lintErrors.length > 0) beginRepairOrFail(code, lintErrors, []);
    else compile(code);
  }, [status, reply, beginRepairOrFail, compile, lint, showError]);

  // Compile success → show model, reset the repair counter. But first, a
  // geometry sanity check: a difference() that slices clean through a part
  // compiles fine yet leaves severed fragments floating in the air (they
  // print as loose debris). Detect that and run it through the same
  // auto-repair loop as a compile error.
  useEffect(() => {
    if (!result || result.source !== lastCompiledSourceRef.current) return;
    if (handledResultRef.current === result) return;
    handledResultRef.current = result;
    // Empty output compiles "successfully" when nothing is instantiated at
    // the top level (e.g. the model left its module calls in a comment or
    // outside the code fence) — repairable, and worthless to display.
    if ((result.stl.byteLength - 84) / 50 <= 0) {
      beginRepairOrFail(
        result.source,
        [
          {
            message:
              "The program compiled but produced NO geometry. Make sure the modules are actually " +
              "instantiated at the top level of the program — as real statements, not inside a comment.",
          },
        ],
        [],
      );
      return;
    }
    onModel(result); // show what compiled either way
    const report = analyzeStlComponents(result.stl);
    if (report.debrisCount > 0 && repairAttemptsRef.current < MAX_REPAIR_ATTEMPTS) {
      beginRepairOrFail(
        result.source,
        [
          {
            message:
              `The model compiled but has ${report.debrisCount} small disconnected piece(s) floating in the air ` +
              `(${report.componentCount} separate solids total) — likely a cut that sliced clean through the part, ` +
              `or a feature positioned without overlap. Every piece must overlap its neighbours by at least 0.2mm ` +
              `and union into connected geometry. Rewrite the program so the result is connected (or has only ` +
              `deliberate, plate-touching separate parts).`,
          },
        ],
        [],
      );
      return;
    }
    lastSuccessfulSourceRef.current = result.source;
    repairAttemptsRef.current = 0;
    setAttempt(0);
    pendingRepairRef.current = null;
    onAccepted(result);
  }, [result, beginRepairOrFail, onModel, onAccepted]);

  // Compile failure → auto-repair (code faults) or surface directly:
  // timeouts mean the model is too heavy, environment failures mean the
  // compiler never loaded — neither is fixable by rewriting code.
  useEffect(() => {
    if (!failure || failure.source !== lastCompiledSourceRef.current) return;
    if (handledFailureRef.current === failure) return;
    handledFailureRef.current = failure;
    if (failure.kind === "timeout") {
      const source = failure.source;
      showError({
        title: "Render timed out",
        hint: "This model is heavy for the in-browser compiler. Retry with more time, or ask for a simpler shape / lower detail.",
        errors: failure.errors,
        stderr: failure.stderr,
        retry: {
          label: "Retry with a 5-minute limit",
          run: () => {
            showError(null);
            // Re-arm the staleness guard: a chat message sent since the
            // timeout nulled it, and the retry's result would be discarded.
            lastCompiledSourceRef.current = source;
            compile(source, { timeoutMs: 300_000 });
          },
        },
      });
    } else if (failure.kind === "environment") {
      showError({
        title: "The 3D compiler failed to load",
        hint: "This is an environment problem, not a model problem — check your connection and that /openscad assets are served, then reload the page.",
        errors: failure.errors,
        stderr: failure.stderr,
      });
    } else {
      beginRepairOrFail(failure.source, failure.errors, failure.stderr);
    }
  }, [failure, beginRepairOrFail, compile, showError]);

  // A fresh human message resets the repair counter and supersedes any
  // in-flight compile; nulling the source ref makes any late-landing stale
  // result or failure fail its staleness guard.
  const reset = useCallback(() => {
    repairAttemptsRef.current = 0;
    setAttempt(0);
    pendingRepairRef.current = null;
    lastCompiledSourceRef.current = null;
    cancel();
  }, [cancel]);

  // A statue, library restore, or Clear replaced whatever the viewer shows.
  // Forgetting the last successful source matters: a later reply that
  // re-emits that same program must compile again, not be skipped as
  // "already showing".
  const modelReplaced = useCallback(() => {
    lastSuccessfulSourceRef.current = null;
  }, []);

  // A compile started outside the chat: its result is the one to take.
  const expect = useCallback((source: string) => {
    lastCompiledSourceRef.current = source;
  }, []);

  return { attempt, reset, modelReplaced, expect };
}
