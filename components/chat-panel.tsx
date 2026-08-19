"use client";

import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
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

interface ChatPanelProps {
  messages: UIMessage[];
  busy: boolean;
  error: Error | undefined;
  onSend(text: string): void;
  onStop(): void;
}

export default function ChatPanel({ messages, busy, error, onSend, onStop }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

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
    <div className="flex h-full flex-col border-r border-neutral-800">
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

      <form
        className="flex items-end gap-2 border-t border-neutral-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
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
