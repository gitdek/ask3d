"use client";

import type { PillState } from "./status-pill";
import { pillLabel } from "./status-pill";

/**
 * The app's whole loop, drawn as a rail: Describe → Code → Compile → Preview.
 *
 * It replaces a one-word status pill with something that teaches the pipeline
 * while it reports on it. Finished stages stay lit, the running stage breathes,
 * and a spark travels the segment currently being worked so the wait reads as
 * progress rather than a frozen screen.
 *
 * Statue generation is a different machine entirely (a photo goes to a local
 * diffusion model, not to OpenSCAD), so it gets its own single-node readout.
 */

const STAGES = ["Describe", "Code", "Compile", "Preview"] as const;

/** Which rail node the current state is sitting on, and how it should read. */
function railPosition(state: PillState): { active: number; failed: boolean; done: boolean } {
  switch (state.kind) {
    case "idle":
      return { active: -1, failed: false, done: false };
    case "generating":
      return { active: 1, failed: false, done: false };
    case "compiling":
      return { active: 2, failed: false, done: false };
    case "ready":
      return { active: 3, failed: false, done: true };
    case "error":
      return { active: 2, failed: true, done: false };
    case "statue":
      return { active: -1, failed: false, done: false };
  }
}

function Node({ tone, pulse }: { tone: "done" | "active" | "pending" | "failed"; pulse: boolean }) {
  const fill =
    tone === "failed"
      ? "bg-[var(--danger)]"
      : tone === "pending"
        ? "bg-white/20"
        : "bg-[var(--beam-1)]";
  return (
    <span className="relative flex h-2.5 w-2.5 items-center justify-center">
      {pulse && (
        <span className="absolute inline-flex h-4 w-4 rounded-full bg-[var(--beam-1)]/30 a3d-breathe" />
      )}
      <span className={`relative h-2 w-2 rounded-full ${fill}`} />
    </span>
  );
}

function Segment({ lit, running }: { lit: boolean; running: boolean }) {
  return (
    <span className="relative mx-1.5 h-px w-5 overflow-hidden rounded-full sm:w-8">
      <span className={`absolute inset-0 ${lit ? "bg-[var(--beam-1)]/60" : "bg-white/12"}`} />
      {running && (
        <span className="absolute inset-y-0 left-0 w-1/3 bg-[var(--beam-1)] a3d-travel" />
      )}
    </span>
  );
}

export default function PipelineRail({ state }: { state: PillState }) {
  const label = pillLabel(state);

  if (state.kind === "statue") {
    return (
      <div className="flex items-center gap-2.5 rounded-full border border-[var(--rule-strong)] bg-black/55 px-3.5 py-1.5 shadow-lg backdrop-blur">
        <span className="relative flex h-2.5 w-2.5 items-center justify-center">
          <span className="absolute inline-flex h-4 w-4 rounded-full bg-[var(--beam-2)]/35 a3d-breathe" />
          <span className="relative h-2 w-2 rounded-full bg-[var(--beam-2)]" />
        </span>
        <span className="text-xs font-medium tabular-nums text-[var(--beam-2)]">{label}</span>
      </div>
    );
  }

  const { active, failed, done } = railPosition(state);

  return (
    <div className="flex items-center gap-3 rounded-full border border-[var(--rule-strong)] bg-black/55 px-3.5 py-1.5 shadow-lg backdrop-blur">
      <div className="flex items-center">
        {STAGES.map((stage, i) => {
          const isDone = done || i < active;
          const isActive = i === active;
          const tone = failed && isActive ? "failed" : isDone ? "done" : isActive ? "active" : "pending";
          return (
            <span key={stage} className="flex items-center">
              {i > 0 && <Segment lit={done || i <= active} running={isActive && !failed} />}
              <span className="flex items-center gap-1.5">
                <Node tone={tone} pulse={isActive && !failed} />
                <span
                  className={`hidden text-[11px] tracking-wide lg:inline ${
                    isDone || isActive ? "text-neutral-200" : "text-neutral-600"
                  }`}
                >
                  {stage}
                </span>
              </span>
            </span>
          );
        })}
      </div>
      <span
        className={`border-l border-[var(--rule)] pl-3 text-xs font-medium tabular-nums ${
          failed ? "text-[var(--danger)]" : done ? "text-[var(--beam-3)]" : "text-neutral-300"
        }`}
      >
        {label}
      </span>
    </div>
  );
}
