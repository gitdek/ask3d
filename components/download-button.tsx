"use client";

import { downloadStl, slugify } from "@/lib/stl";

interface DownloadButtonProps {
  stl: ArrayBuffer | null;
  nameHint: string;
}

export default function DownloadButton({ stl, nameHint }: DownloadButtonProps) {
  return (
    <button
      type="button"
      disabled={!stl}
      onClick={() => stl && downloadStl(stl, slugify(nameHint))}
      className="pointer-events-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
    >
      Download STL
    </button>
  );
}
