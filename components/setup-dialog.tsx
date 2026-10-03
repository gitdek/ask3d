"use client";

import { useEffect, useState } from "react";
import { PROVIDER_INFO, PROVIDERS, SUGGESTED_MODEL, type ProviderId } from "@/lib/ai/config";
import BrandMark from "./brand-mark";

/**
 * First-run setup. The app needs exactly one API key and nothing else, so
 * asking for it in the interface beats sending someone off to hand-edit a
 * dotfile they have to learn the name of first.
 *
 * Saving writes .env.local *and* applies the key to the running server, so the
 * next message works without a restart.
 */
export default function SetupDialog({
  open,
  onClose,
  initialProvider,
  dismissable,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initialProvider: ProviderId;
  /** The first-run dialog has nothing behind it worth seeing, so it stays put. */
  dismissable: boolean;
  onSaved: (provider: string, model: string) => void;
}) {
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(SUGGESTED_MODEL[initialProvider]);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  const pick = (id: ProviderId) => {
    setProvider(id);
    setModel(SUGGESTED_MODEL[id]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey, model }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not save that key.");
        return;
      }
      onSaved(data.provider, data.model);
      onClose();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        onClick={dismissable ? onClose : undefined}
      />
      <div className="a3d-rise a3d-grain relative w-full max-w-lg overflow-hidden rounded-2xl border border-[var(--rule-strong)] bg-[var(--panel)] shadow-2xl">
        <div className="a3d-grid absolute inset-0 opacity-40" />

        <div className="relative p-6">
          <div className="flex items-start gap-3">
            <BrandMark size={34} />
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-neutral-100">
                {dismissable ? "Model settings" : "One key and you're printing"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-neutral-400">
                ask3d needs a single API key to write OpenSCAD. The compiler, the preview and the
                exports all run on your machine.
              </p>
            </div>
            {dismissable && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="rounded px-1.5 text-neutral-500 transition hover:text-neutral-200"
              >
                ✕
              </button>
            )}
          </div>

          <div className="mt-5 grid gap-2">
            {PROVIDERS.map((id) => {
              const info = PROVIDER_INFO[id];
              const active = provider === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => pick(id)}
                  className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition ${
                    active
                      ? "border-[var(--beam-1)]/60 bg-[var(--beam-1)]/[0.08]"
                      : "border-[var(--rule)] hover:border-[var(--rule-strong)]"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${active ? "bg-[var(--beam-1)]" : "bg-white/15"}`}
                    />
                    <span>
                      <span className="block text-sm text-neutral-200">{info.label}</span>
                      <span className="block text-[11px] text-neutral-500">{info.note}</span>
                    </span>
                  </span>
                  <a
                    href={info.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0 text-[11px] text-[var(--beam-1)] underline-offset-2 hover:underline"
                  >
                    get a key ↗
                  </a>
                </button>
              );
            })}
          </div>

          <label className="mt-5 block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              API key
            </span>
            <span className="mt-1.5 flex gap-2">
              <input
                type={reveal ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && apiKey.trim() && !busy && void save()}
                placeholder="paste it here"
                autoFocus
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-[var(--rule)] bg-black/40 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-[var(--beam-1)]/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className="shrink-0 rounded-lg border border-[var(--rule)] px-3 text-xs text-neutral-400 transition hover:text-neutral-100"
              >
                {reveal ? "hide" : "show"}
              </button>
            </span>
          </label>

          <label className="mt-3 block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              Model
            </span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              spellCheck={false}
              className="mt-1.5 w-full rounded-lg border border-[var(--rule)] bg-black/40 px-3 py-2 font-mono text-sm text-neutral-100 focus:border-[var(--beam-1)]/60 focus:outline-none"
            />
          </label>

          {error && (
            <p className="mt-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-xs text-[var(--danger)]">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void save()}
            disabled={!apiKey.trim() || busy}
            className="a3d-sheen mt-5 w-full rounded-lg bg-gradient-to-br from-[var(--beam-1)] to-[var(--beam-2)] px-4 py-2.5 text-sm font-semibold text-neutral-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-none disabled:bg-white/10 disabled:text-neutral-500"
          >
            <span className="a3d-sheen-bar" aria-hidden="true" />
            <span className="relative">{busy ? "Saving…" : "Save and start building"}</span>
          </button>

          <p className="mt-3 text-[11px] leading-relaxed text-neutral-600">
            Saved to <code className="text-neutral-500">.env.local</code> and applied immediately —
            no restart. Turning photos into 3D models is optional and needs a separate local
            install; see <code className="text-neutral-500">statue-service/README.md</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
