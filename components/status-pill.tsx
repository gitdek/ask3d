"use client";

export type PillState =
  | { kind: "idle" }
  | { kind: "generating"; repairAttempt: number }
  | { kind: "compiling" }
  | { kind: "ready" }
  | { kind: "error" };

const STYLES: Record<PillState["kind"], string> = {
  idle: "bg-neutral-700/70 text-neutral-300",
  generating: "bg-blue-600/80 text-white animate-pulse",
  compiling: "bg-amber-600/80 text-white animate-pulse",
  ready: "bg-emerald-600/80 text-white",
  error: "bg-red-600/80 text-white",
};

function label(state: PillState): string {
  switch (state.kind) {
    case "idle":
      return "Idle";
    case "generating":
      return state.repairAttempt > 0 ? `Fixing errors (${state.repairAttempt}/2)…` : "Generating…";
    case "compiling":
      return "Compiling…";
    case "ready":
      return "Ready";
    case "error":
      return "Error";
  }
}

export default function StatusPill({ state }: { state: PillState }) {
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium shadow ${STYLES[state.kind]}`}>
      {label(state)}
    </span>
  );
}
