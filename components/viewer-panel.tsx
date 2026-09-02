"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { ModelDimensions } from "./stl-mesh";
import type { PillState } from "./status-pill";
import type { ScadError } from "@/lib/scad/types";
import StatusPill from "./status-pill";
import ErrorPanel from "./error-panel";
import DownloadButton from "./download-button";
import DancingPuppy from "./dancing-puppy";

// dynamic(..., { ssr: false }) must live in a client file (throws in Server
// Components); workers/WebGL don't exist during SSR.
const StlCanvas = dynamic(() => import("./stl-canvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      Loading 3D viewer…
    </div>
  ),
});

export interface ViewerError {
  title: string;
  hint: string;
  errors: ScadError[];
  stderr: string[];
  /** Optional recovery action rendered as a button (e.g. retry with a longer timeout). */
  retry?: { label: string; run: () => void };
}

interface ViewerPanelProps {
  stl: ArrayBuffer | null;
  /** Per-color meshes for tinted preview (multi-color exports). */
  colorParts: { hex: string; stl: ArrayBuffer }[] | null;
  /** Per-color renders still running — a 3MF exported now would be single-body. */
  colorPending?: boolean;
  /** OpenSCAD warnings from the successful compile (dropped geometry, bad manifolds). */
  warnings?: ScadError[];
  pillState: PillState;
  viewerError: ViewerError | null;
  nameHint: string;
  onDownload3mf(): void;
  /** Empty the viewer and stop reload-adoption from restoring this model. */
  onClear(): void;
}

function formatMm(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

export default function ViewerPanel({
  stl,
  colorParts,
  colorPending = false,
  warnings = [],
  pillState,
  viewerError,
  nameHint,
  onDownload3mf,
  onClear,
}: ViewerPanelProps) {
  const [dims, setDims] = useState<ModelDimensions | null>(null);
  const handleDimensions = useCallback((d: ModelDimensions) => setDims(d), []);
  const waiting =
    pillState.kind === "generating" ||
    pillState.kind === "compiling" ||
    pillState.kind === "statue";
  const puppyCaption =
    pillState.kind === "statue" ? "sculpting your statue…" : "designing your model…";
  const colorCount = colorParts && colorParts.length >= 2 ? colorParts.length : 0;
  const threeMfLabel = colorPending
    ? "3MF · colors…"
    : colorCount
      ? `3MF · ${colorCount} colors`
      : "3MF";
  const threeMfTitle = colorPending
    ? "The per-color parts are still rendering — a moment, or the 3MF would be single-body"
    : colorCount
      ? `Export as 3MF with ${colorCount} color objects for the AMS`
      : "Export as 3MF (Bambu Studio's native format)";

  return (
    <div className="relative h-full min-h-[320px] bg-neutral-950">
      <StlCanvas stl={stl} colorParts={colorParts} onDimensions={handleDimensions} />

      {!stl && !viewerError && !waiting && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-xs text-center text-sm text-neutral-500">
            Describe an object in the chat and it will appear here, ready to print.
          </p>
        </div>
      )}

      {/* Long waits get a dancing Ridgeback puppy: centered when the stage
          is empty, tucked in a corner when a model is already showing. */}
      {waiting && !viewerError && (
        <div
          className={
            stl
              ? "pointer-events-none absolute bottom-16 left-4"
              : "pointer-events-none absolute inset-0 flex items-center justify-center"
          }
        >
          <DancingPuppy small={!!stl} caption={puppyCaption} />
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            {stl && dims && (
              <span className="rounded-full bg-neutral-800/80 px-3 py-1 text-xs font-medium text-neutral-200 shadow">
                {formatMm(dims.x)} × {formatMm(dims.y)} × {formatMm(dims.z)} mm
              </span>
            )}
            {stl && warnings.length > 0 && (
              <span
                title={warnings
                  .map((w) => (w.line !== undefined ? `line ${w.line}: ${w.message}` : w.message))
                  .join("\n")}
                className="pointer-events-auto cursor-help rounded-full bg-amber-900/70 px-3 py-1 text-xs font-medium text-amber-200 shadow"
              >
                ⚠ {warnings.length} compiler warning{warnings.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <StatusPill state={pillState} />
        </div>

        {viewerError && (
          <div className="flex flex-1 items-center justify-center py-4">
            <ErrorPanel
              title={viewerError.title}
              hint={viewerError.hint}
              errors={viewerError.errors}
              stderr={viewerError.stderr}
              retry={viewerError.retry}
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {stl && (
            <button
              type="button"
              onClick={onClear}
              title="Clear the viewer — a refresh won't bring this model back"
              className="pointer-events-auto rounded-lg bg-neutral-800/80 px-4 py-2 text-sm font-medium text-neutral-400 shadow transition hover:bg-neutral-700 hover:text-neutral-200"
            >
              Clear
            </button>
          )}
          {stl && (
            <button
              type="button"
              onClick={onDownload3mf}
              disabled={colorPending}
              title={threeMfTitle}
              className="pointer-events-auto rounded-lg bg-neutral-700 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-neutral-600 disabled:cursor-wait disabled:opacity-60"
            >
              {threeMfLabel}
            </button>
          )}
          <DownloadButton stl={stl} nameHint={nameHint} />
        </div>
      </div>
    </div>
  );
}
