"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { ModelDimensions } from "./stl-mesh";
import type { PillState } from "./status-pill";
import type { ScadError } from "@/lib/scad/types";
import StatusPill from "./status-pill";
import ErrorPanel from "./error-panel";
import DownloadButton from "./download-button";

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
  pillState,
  viewerError,
  nameHint,
  onDownload3mf,
  onClear,
}: ViewerPanelProps) {
  const [dims, setDims] = useState<ModelDimensions | null>(null);
  const handleDimensions = useCallback((d: ModelDimensions) => setDims(d), []);

  return (
    <div className="relative h-full min-h-[320px] bg-neutral-950">
      <StlCanvas stl={stl} onDimensions={handleDimensions} />

      {!stl && !viewerError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-xs text-center text-sm text-neutral-500">
            Describe an object in the chat and it will appear here, ready to print.
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        <div className="flex items-start justify-between">
          {stl && dims ? (
            <span className="rounded-full bg-neutral-800/80 px-3 py-1 text-xs font-medium text-neutral-200 shadow">
              {formatMm(dims.x)} × {formatMm(dims.y)} × {formatMm(dims.z)} mm
            </span>
          ) : (
            <span />
          )}
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
              title="Export as 3MF (Bambu Studio's native format)"
              className="pointer-events-auto rounded-lg bg-neutral-700 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-neutral-600"
            >
              3MF
            </button>
          )}
          <DownloadButton stl={stl} nameHint={nameHint} />
        </div>
      </div>
    </div>
  );
}
