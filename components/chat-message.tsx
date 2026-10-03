"use client";

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import type { UIMessage } from "ai";
import { AUTO_REPAIR_PREFIX } from "@/lib/ai/system-prompt";

export function uiMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function isAutoRepairMessage(message: UIMessage): boolean {
  return message.role === "user" && uiMessageText(message).startsWith(AUTO_REPAIR_PREFIX);
}

interface ChatMessageProps {
  message: UIMessage;
  isStreaming: boolean;
}

export default function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const text = uiMessageText(message);

  if (isAutoRepairMessage(message)) {
    // Expandable so the exact payload sent to the model is always inspectable.
    return (
      <div className="a3d-rise my-1 flex justify-center">
        <details className="max-w-[90%]">
          <summary className="cursor-pointer rounded-full border border-[var(--warn)]/25 bg-[var(--warn)]/10 px-3 py-1 text-xs italic text-[var(--warn)]/80 transition hover:text-[var(--warn)]">
            Auto-fixing compile errors…
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-2 text-xs text-neutral-500">
            {text}
          </pre>
        </details>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="a3d-rise my-2 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-gradient-to-br from-[var(--beam-1)] to-[var(--beam-2)] px-4 py-2 text-sm font-medium text-neutral-950 shadow-lg shadow-cyan-500/10">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="a3d-rise my-2 max-w-none text-sm">
      <Streamdown plugins={{ code }} isAnimating={isStreaming}>
        {text}
      </Streamdown>
    </div>
  );
}
