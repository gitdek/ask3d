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
    return (
      <div className="my-1 flex justify-center">
        <span className="rounded-full bg-neutral-800/60 px-3 py-1 text-xs italic text-neutral-500">
          Auto-fixing compile errors…
        </span>
      </div>
    );
  }

  if (message.role === "user") {
    return (
      <div className="my-2 flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-sm text-white">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 max-w-none text-sm">
      <Streamdown plugins={{ code }} isAnimating={isStreaming}>
        {text}
      </Streamdown>
    </div>
  );
}
