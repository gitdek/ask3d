"use client";

import type { ScadError } from "@/lib/scad/types";

interface ErrorPanelProps {
  title: string;
  hint: string;
  errors: ScadError[];
  stderr: string[];
  retry?: { label: string; run: () => void };
}

export default function ErrorPanel({ title, hint, errors, stderr, retry }: ErrorPanelProps) {
  return (
    <div className="pointer-events-auto max-h-[70%] w-full max-w-md overflow-y-auto rounded-xl border border-red-800/60 bg-neutral-900/95 p-4 text-sm shadow-xl">
      <p className="font-semibold text-red-400">{title}</p>
      <ul className="mt-2 space-y-1 text-neutral-300">
        {errors.map((err, i) => (
          <li key={i} className="whitespace-pre-wrap">
            {err.line !== undefined ? `Line ${err.line}: ` : ""}
            {err.message}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-neutral-400">{hint}</p>
      {retry && (
        <button
          type="button"
          onClick={retry.run}
          className="mt-3 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-500"
        >
          {retry.label}
        </button>
      )}
      {stderr.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-300">
            Raw compiler output
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/50 p-2 text-xs text-neutral-400">
            {stderr.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
