"use client";

import { useState } from "react";
import type { HistoryMeta } from "@/lib/history";

interface HistoryPanelProps {
  items: HistoryMeta[];
  onRestore(item: HistoryMeta): void;
  onDelete(id: string): void;
  onClearAll(): void;
  onClose(): void;
}

const KIND_LABEL: Record<HistoryMeta["kind"], string> = {
  image: "photo",
  mesh: "mesh",
  scad: "OpenSCAD",
  statue: "statue",
  compiled: "model",
};

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatMm(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

export default function HistoryPanel({
  items,
  onRestore,
  onDelete,
  onClearAll,
  onClose,
}: HistoryPanelProps) {
  // Two-step Clear all: one mis-click must not wipe the only copy of
  // generated models. Resets when the panel closes (it unmounts).
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <div className="absolute right-2 top-12 z-30 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-sm font-semibold text-neutral-200">
          Library
          <span className="ml-2 text-xs font-normal text-neutral-500">
            {items.length ? `${items.length} item${items.length > 1 ? "s" : ""}` : "empty"}
          </span>
        </span>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => (confirmingClear ? onClearAll() : setConfirmingClear(true))}
              onBlur={() => setConfirmingClear(false)}
              className={`text-xs transition ${
                confirmingClear
                  ? "font-semibold text-red-400"
                  : "text-neutral-500 hover:text-red-400"
              }`}
            >
              {confirmingClear ? `Really delete ${items.length}?` : "Clear all"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close library"
            className="rounded px-1.5 text-sm text-neutral-400 transition hover:text-white"
          >
            ✕
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-neutral-500">
          Photos you attach and models you generate will be kept here, across reloads.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {items.map((item) => (
            <li key={item.id} className="group flex items-center gap-2 rounded-lg p-1.5 transition hover:bg-neutral-800">
              <button
                type="button"
                onClick={() => onRestore(item)}
                title={`Restore ${item.name}`}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                {item.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element -- small data-URL thumbnail
                  <img
                    src={item.thumb}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-lg">
                    {item.kind === "image" ? "🖼️" : item.kind === "scad" ? "📐" : "🗿"}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-neutral-200">
                    {item.name}
                  </span>
                  <span className="block text-[11px] text-neutral-500">
                    {KIND_LABEL[item.kind]} · {timeAgo(item.createdAt)}
                    {item.dims &&
                      ` · ${formatMm(item.dims.x)}×${formatMm(item.dims.y)}×${formatMm(item.dims.z)}mm`}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(item.id)}
                aria-label={`Delete ${item.name} from library`}
                className="shrink-0 rounded px-1.5 text-sm text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
