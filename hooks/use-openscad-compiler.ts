"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseScadErrors } from "@/lib/scad/errors";
import type {
  CompileFailure,
  CompileSuccess,
  CompilerStatus,
  WorkerCompileResponse,
} from "@/lib/scad/types";

const COMPILE_TIMEOUT_MS = 60_000;

/**
 * Owns the openscad-wasm Web Worker lifecycle. A fresh worker per compile
 * (callMain is one-shot); cancellation and timeout are both
 * worker.terminate(). Results carry their source so consumers can discard
 * stale ones.
 */
export function useOpenscadCompiler() {
  const [status, setStatus] = useState<CompilerStatus>("idle");
  const [result, setResult] = useState<CompileSuccess | null>(null);
  const [failure, setFailure] = useState<CompileFailure | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobIdRef = useRef(0);

  const teardown = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const compile = useCallback(
    (source: string) => {
      teardown();
      const jobId = ++jobIdRef.current;
      const worker = new Worker(new URL("../workers/openscad-worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;
      setStatus("compiling");
      setFailure(null);

      worker.onmessage = (event: MessageEvent<WorkerCompileResponse>) => {
        if (event.data.jobId !== jobId || jobId !== jobIdRef.current) return;
        teardown();
        if (event.data.type === "done") {
          setResult({ source, stl: event.data.stl, stderr: event.data.stderr });
          setStatus("done");
        } else {
          setFailure({
            source,
            errors: parseScadErrors(event.data.stderr, event.data.exitCode),
            stderr: event.data.stderr,
            // The worker posts exitCode null only when the compiler itself
            // failed to start (wasm fetch/instantiation) — not a code fault.
            kind: event.data.exitCode === null ? "environment" : "compile",
          });
          setStatus("error");
        }
      };

      worker.onerror = (event) => {
        if (jobId !== jobIdRef.current) return;
        teardown();
        setFailure({
          source,
          errors: [{ message: event.message || "The compiler worker failed to load" }],
          stderr: [],
          kind: "environment",
        });
        setStatus("error");
      };

      timeoutRef.current = setTimeout(() => {
        if (jobId !== jobIdRef.current) return;
        teardown();
        setFailure({
          source,
          errors: [{ message: "Render timed out after 60 seconds" }],
          stderr: [],
          kind: "timeout",
        });
        setStatus("timeout");
      }, COMPILE_TIMEOUT_MS);

      worker.postMessage({ type: "compile", source, jobId });
    },
    [teardown],
  );

  const cancel = useCallback(() => {
    jobIdRef.current++;
    teardown();
    // Clear any committed failure so a superseded compile can't fire a
    // stale auto-repair after the user has already moved on.
    setFailure(null);
    setStatus("idle");
  }, [teardown]);

  useEffect(() => teardown, [teardown]);

  return { status, compile, cancel, result, failure };
}
