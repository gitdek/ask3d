"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type { UIMessage } from "ai";
import type { UploadedAsset } from "@/lib/uploads";
import type { StatueProgress, Suggestion } from "./app-shell";
import ChatMessage from "./chat-message";
import WireframeDrift from "./wireframe-drift";
import ExamplePrompts from "./example-prompts";

/** The route returns {"error": "..."} JSON; show just the message. */
function humanizeChatError(message: string): string {
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return parsed.error;
    }
  } catch {
    // not JSON — show as-is
  }
  return message;
}

const KIND_ICON: Record<UploadedAsset["kind"], string> = {
  mesh: "▲",
  image: "◧",
  scad: "❮❯",
};

interface ChatPanelProps {
  messages: UIMessage[];
  busy: boolean;
  error: Error | undefined;
  uploads: UploadedAsset[];
  uploadError: string | null;
  statueProgress: StatueProgress | null;
  onSend(text: string): void;
  onStop(): void;
  onAttach(files: File[]): void;
  onRemoveUpload(path: string): void;
  onMakeStatue(path: string): void;
  suggestions: Suggestion[] | null;
  onSuggestion(s: Suggestion): void;
}

export default function ChatPanel({
  messages,
  busy,
  error,
  uploads,
  uploadError,
  statueProgress,
  onSend,
  onStop,
  onAttach,
  onRemoveUpload,
  onMakeStatue,
  suggestions,
  onSuggestion,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Enter/leave fire for every child crossed; a depth counter keeps the
  // overlay stable until the drag actually exits the panel.
  const dragDepthRef = useRef(0);

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    onSend(text);
  };

  return (
    <div
      className="a3d-aurora a3d-grain relative flex h-full flex-col overflow-hidden border-r border-[var(--rule)] bg-[var(--panel)]"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        if (hasFiles(e)) e.preventDefault(); // required to allow the drop
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepthRef.current -= 1;
        if (dragDepthRef.current <= 0) {
          dragDepthRef.current = 0;
          setDragActive(false);
        }
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onAttach(files);
      }}
    >
      <WireframeDrift />
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--beam-1)]/60 bg-[var(--beam-1)]/[0.07] backdrop-blur-sm">
          <p className="a3d-breathe text-sm font-medium text-[var(--beam-1)]">
            Drop photos, STL, or OpenSCAD files to attach
          </p>
        </div>
      )}
      <div className="a3d-scroll relative z-10 min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <ExamplePrompts onPick={onSend} onPickPhoto={() => fileInputRef.current?.click()} />
        )}
        {messages.map((message, i) => (
          <ChatMessage
            key={message.id}
            message={message}
            isStreaming={busy && i === messages.length - 1 && message.role === "assistant"}
          />
        ))}
        {error && (
          <div className="my-2 rounded-lg border border-red-800/60 bg-red-950/40 p-3 text-xs text-red-300">
            <p className="font-semibold">The model request failed.</p>
            <p className="mt-1 whitespace-pre-wrap">{humanizeChatError(error.message)}</p>
            <p className="mt-1 text-red-400/80">
              You may be rate limited — wait a moment and try again, or switch provider in .env.local.
            </p>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {(uploads.length > 0 || uploadError) && (
        <div className="relative z-10 border-t border-[var(--rule)] px-3 py-2">
          {uploads.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {uploads.map((u) => (
                <span
                  key={u.path}
                  className="a3d-rise inline-flex items-center gap-1.5 rounded-full border border-[var(--rule)] bg-[var(--panel-raised)] px-2.5 py-1 text-xs text-neutral-300"
                  title={u.path}
                >
                  <span className="text-neutral-500">{KIND_ICON[u.kind]}</span>
                  {u.name}
                  {u.dims && (
                    <span className="text-neutral-500">
                      {u.dims.x.toFixed(0)}×{u.dims.y.toFixed(0)}×{u.dims.z.toFixed(0)}mm
                    </span>
                  )}
                  {u.kind === "image" &&
                    (statueProgress?.uploadPath === u.path ? (
                      <span className="animate-pulse text-purple-400">
                        {statueProgress.phase === "converting"
                          ? "converting…"
                          : `sculpting ${Math.floor(statueProgress.elapsedSeconds / 60)}:${String(statueProgress.elapsedSeconds % 60).padStart(2, "0")}`}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={statueProgress !== null}
                        onClick={() => onMakeStatue(u.path)}
                        title="Generate a 3D statue from this photo (local TRELLIS.2, ~5 min)"
                        className="rounded bg-purple-700/60 px-1.5 py-0.5 text-purple-200 transition hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        statue
                      </button>
                    ))}
                  <button
                    type="button"
                    aria-label={`Remove ${u.name}`}
                    onClick={() => onRemoveUpload(u.path)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {uploadError && <p className="mt-1 text-xs text-red-400">{uploadError}</p>}
        </div>
      )}

      {suggestions && suggestions.length > 0 && (
        <div className="relative z-10 flex flex-wrap gap-1.5 border-t border-[var(--rule)] px-3 py-2">
          {suggestions.map((s) => (
            <button
              key={`${s.action}:${s.label}`}
              type="button"
              disabled={busy || statueProgress !== null}
              onClick={() => onSuggestion(s)}
              className={`a3d-rise rounded-full border px-3 py-1 text-xs transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 ${
                s.action === "statue"
                  ? "border-[var(--beam-2)]/50 text-[var(--beam-2)] hover:border-[var(--beam-2)] hover:bg-[var(--beam-2)]/10"
                  : "border-[var(--rule)] text-neutral-300 hover:border-[var(--beam-1)]/50 hover:text-[var(--beam-1)]"
              }`}
            >
              {s.action === "statue" ? "🗿 " : "✨ "}
              {s.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="relative z-10 flex items-end gap-2 border-t border-[var(--rule)] bg-[var(--panel)]/60 p-3 backdrop-blur"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".stl,.scad,image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onAttach(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Attach a photo to sculpt in 3D, or an STL / OpenSCAD file to build on"
          className="group flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--rule)] px-2.5 py-2 text-sm text-neutral-400 transition hover:border-[var(--beam-2)]/60 hover:text-[var(--beam-2)]"
        >
          <svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" />
            <circle cx="7" cy="8" r="1.4" />
            <path d="M3.5 14 L8 9.5 L11 12.5 L13 10.5 L16.5 14" />
          </svg>
          <span className="hidden text-xs sm:inline">Photo</span>
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="Describe an object… (Enter to send)"
          className="a3d-scroll min-h-[3rem] flex-1 resize-none rounded-lg border border-[var(--rule)] bg-black/40 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 transition focus:border-[var(--beam-1)]/60 focus:outline-none focus:ring-1 focus:ring-[var(--beam-1)]/25"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-[var(--rule-strong)] bg-black/40 px-4 py-2 text-sm font-semibold text-neutral-200 transition hover:bg-black/70"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="a3d-sheen rounded-lg bg-gradient-to-br from-[var(--beam-1)] to-[var(--beam-2)] px-4 py-2 text-sm font-semibold text-neutral-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-none disabled:bg-white/10 disabled:text-neutral-500 disabled:shadow-none"
          >
            <span className="a3d-sheen-bar" aria-hidden="true" />
            <span className="relative">Send</span>
          </button>
        )}
      </form>
    </div>
  );
}
