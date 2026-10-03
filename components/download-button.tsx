"use client";

import { downloadStl, slugify } from "@/lib/stl";

interface DownloadButtonProps {
  stl: ArrayBuffer | null;
  nameHint: string;
}

/** The one button that hands you a file, so it owns the only solid fill. */
export default function DownloadButton({ stl, nameHint }: DownloadButtonProps) {
  return (
    <button
      type="button"
      disabled={!stl}
      onClick={() => stl && downloadStl(stl, slugify(nameHint))}
      className="a3d-sheen pointer-events-auto rounded-lg bg-[var(--beam-3)] px-4 py-2 text-sm font-semibold text-neutral-950 shadow-lg shadow-emerald-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-neutral-500 disabled:shadow-none"
    >
      <span className="a3d-sheen-bar" aria-hidden="true" />
      <span className="relative">Download STL</span>
    </button>
  );
}
