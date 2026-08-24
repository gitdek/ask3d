"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import type { UIMessage } from "ai";
import type { UploadedAsset } from "@/lib/uploads";
import type { StatueProgress, Suggestion } from "./app-shell";
import ChatMessage from "./chat-message";

const EXAMPLE_PROMPTS = [
  "a phone stand at a 60° angle",
  "a hexagonal planter, 80mm wide",
  "a cable clip for a 5mm cable",
];

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
      className="relative flex h-full flex-col border-r border-neutral-800"
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
      {dragActive && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-sky-500/70 bg-sky-950/40">
          <p className="text-sm font-medium text-sky-200">
            Drop photos, STL, or OpenSCAD files to attach
          </p>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="mt-8 space-y-3 text-center">
            <p className="text-sm text-neutral-400">
              Describe an object and I&apos;ll design it for 3D printing.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => onSend(prompt)}
                  className="rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:border-neutral-500 hover:text-white"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
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
        <div className="border-t border-neutral-800 px-3 py-2">
          {uploads.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {uploads.map((u) => (
                <span
                  key={u.path}
                  className="inline-flex items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300"
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
        <div className="flex flex-wrap gap-1.5 border-t border-neutral-800/60 px-3 py-2">
          {suggestions.map((s) => (
            <button
              key={`${s.action}:${s.label}`}
              type="button"
              disabled={busy || statueProgress !== null}
              onClick={() => onSuggestion(s)}
              className={`rounded-full border px-3 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                s.action === "statue"
                  ? "border-purple-700/70 text-purple-300 hover:border-purple-500 hover:text-purple-100"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500 hover:text-white"
              }`}
            >
              {s.action === "statue" ? "🗿 " : "✨ "}
              {s.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-2 border-t border-neutral-800 p-3"
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
          title="Attach an STL, OpenSCAD file, or photo"
          className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 transition hover:border-neutral-500 hover:text-white"
        >
          +
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
          className="min-h-[3rem] flex-1 resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg bg-neutral-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-600"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
