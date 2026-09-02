import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { AiConfigError, getModel } from "@/lib/ai/registry";
import { SYSTEM_PROMPT } from "@/lib/ai/system-prompt";

export const maxDuration = 120;

// Attached photos are downscaled to ≤512px client-side; this is generous.
const MAX_FILE_PART_CHARS = 4 * 1024 * 1024;

function isSafePart(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const part = value as { type?: unknown; url?: unknown; mediaType?: unknown };
  if (part.type !== "file") return true;
  // The client only ever sends inline images. A file part carrying an
  // http(s) URL would make the AI SDK download it from this server process
  // — a request-forgery hole for anything that can POST here.
  return (
    typeof part.url === "string" &&
    part.url.startsWith("data:image/") &&
    part.url.length <= MAX_FILE_PART_CHARS &&
    (part.mediaType === undefined ||
      (typeof part.mediaType === "string" && part.mediaType.startsWith("image/")))
  );
}

function isValidMessages(value: unknown): value is UIMessage[] {
  return (
    Array.isArray(value) &&
    value.every((m) => {
      if (m === null || typeof m !== "object") return false;
      const msg = m as { role?: unknown; parts?: unknown };
      // Only conversation roles — a forged system-role message must not
      // reach the provider.
      return (
        (msg.role === "user" || msg.role === "assistant") &&
        Array.isArray(msg.parts) &&
        msg.parts.every(isSafePart)
      );
    })
  );
}

export async function POST(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => null);
    const messages = (body as { messages?: unknown } | null)?.messages;
    if (!isValidMessages(messages)) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const result = streamText({
      model: getModel(),
      instructions: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages),
      // Stop paying for tokens the moment the user hits Stop or navigates away.
      abortSignal: req.signal,
    });
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        // Default masking would hide provider failures (invalid key, wrong
        // model id, 429) behind "An error occurred." — forward the message;
        // this is a bring-your-own-key tool, so it's the user's own error.
        onError: (error) => (error instanceof Error ? error.message : "The model call failed."),
      }),
    });
  } catch (error) {
    if (error instanceof AiConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    console.error("chat route error:", error);
    return Response.json({ error: "Chat request failed" }, { status: 500 });
  }
}
