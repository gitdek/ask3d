"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelDimensions } from "./stl-mesh";
import type { PillState } from "./status-pill";
import type { ScadError } from "@/lib/scad/types";
import PipelineRail from "./pipeline-rail";
import BlueprintEmpty from "./blueprint-empty";
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

/** Viewfinder corners — they frame the stage like a build plate. */
function PlateCorners() {
  const corner = "pointer-events-none absolute h-5 w-5 border-[var(--rule-strong)]";
  return (
    <div className="pointer-events-none absolute inset-3 hidden sm:block">
      <span className={`${corner} left-0 top-0 border-l border-t rounded-tl-md`} />
      <span className={`${corner} right-0 top-0 border-r border-t rounded-tr-md`} />
      <span className={`${corner} bottom-0 left-0 border-b border-l rounded-bl-md`} />
      <span className={`${corner} bottom-0 right-0 border-b border-r rounded-br-md`} />
    </div>
  );
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
  // Remounting a one-shot element is the cheapest way to replay an animation:
  // every new mesh gets a fresh key, so the sweep runs exactly once per model.
  const landingRef = useRef(0);
  const [landing, setLanding] = useState(0);
  useEffect(() => {
    if (stl) setLanding(++landingRef.current);
  }, [stl]);
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
    <div className="relative h-full min-h-[320px] overflow-hidden bg-[var(--background)]">
      <StlCanvas stl={stl} colorParts={colorParts} onDimensions={handleDimensions} />
      <PlateCorners />
      {landing > 0 && (
        <span
          key={landing}
          aria-hidden="true"
          className="a3d-materialize pointer-events-none absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-transparent via-[var(--beam-1)]/25 to-transparent"
        />
      )}

      {!stl && !viewerError && !waiting && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <BlueprintEmpty />
        </div>
      )}

      {/* Long waits get a dancing puppy: centered when the stage is empty,
          tucked in a corner when a model is already showing. */}
      {waiting && !viewerError && (
        <div
          className={
            stl
              ? "pointer-events-none absolute bottom-20 left-5"
              : "pointer-events-none absolute inset-0 flex items-center justify-center"
          }
        >
          <DancingPuppy small={!!stl} caption={puppyCaption} />
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {stl && dims && (
              <span className="a3d-rise whitespace-nowrap rounded-full border border-[var(--rule-strong)] bg-black/55 px-3 py-1 font-mono text-xs font-medium tabular-nums text-neutral-200 shadow-lg backdrop-blur">
                {formatMm(dims.x)} × {formatMm(dims.y)} × {formatMm(dims.z)}
                <span className="ml-1 text-neutral-500">mm</span>
              </span>
            )}
            {stl && warnings.length > 0 && (
              <span
                title={warnings
                  .map((w) => (w.line !== undefined ? `line ${w.line}: ${w.message}` : w.message))
                  .join("\n")}
                className="a3d-rise pointer-events-auto cursor-help rounded-full border border-[var(--warn)]/30 bg-[var(--warn)]/10 px-3 py-1 text-xs font-medium text-[var(--warn)] shadow-lg backdrop-blur"
              >
                ⚠ {warnings.length} compiler warning{warnings.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <PipelineRail state={pillState} />
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
              className="a3d-rise pointer-events-auto rounded-lg border border-[var(--rule)] bg-black/40 px-4 py-2 text-sm font-medium text-neutral-400 shadow-lg backdrop-blur transition hover:border-[var(--rule-strong)] hover:text-neutral-100"
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
              className={`a3d-rise pointer-events-auto rounded-lg border border-[var(--rule-strong)] bg-black/40 px-4 py-2 text-sm font-semibold text-neutral-100 shadow-lg backdrop-blur transition hover:bg-black/60 disabled:cursor-wait disabled:opacity-60 ${
                colorCount ? "a3d-ring" : ""
              }`}
            >
              {colorCount > 0 && (
                <span className="mr-2 inline-flex -space-x-1 align-middle">
                  {colorParts!.slice(0, 4).map((part, i) => (
                    <span
                      key={i}
                      className="h-2.5 w-2.5 rounded-full ring-1 ring-black/60"
                      style={{ background: part.hex }}
                    />
                  ))}
                </span>
              )}
              {threeMfLabel}
            </button>
          )}
          <DownloadButton stl={stl} nameHint={nameHint} />
        </div>
      </div>
    </div>
  );
}
