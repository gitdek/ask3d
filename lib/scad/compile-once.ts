"use client";

import type { CompileFile, WorkerCompileResponse } from "./types";

/**
 * One-shot promise compile, independent of the interactive compiler hook —
 * used for background per-color part extraction after the main compile has
 * already succeeded. Same worker, no React state, no repair loop.
 */
export function compileOnce(
  source: string,
  files?: CompileFile[],
  timeoutMs = 90_000,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../workers/openscad-worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("color part render timed out"));
    }, timeoutMs);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };
    worker.onmessage = (event: MessageEvent<WorkerCompileResponse>) => {
      if (event.data.type === "done") {
        const model = event.data.model;
        done(() => resolve(model));
      } else {
        done(() => reject(new Error("color part failed to compile")));
      }
    };
    worker.onerror = (event) => done(() => reject(new Error(event.message || "worker error")));
    worker.postMessage({ type: "compile", source, jobId: 1, files });
  });
}
