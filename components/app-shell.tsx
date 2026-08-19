"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenscadCompiler } from "@/hooks/use-openscad-compiler";
import { extractLastScadBlock } from "@/lib/scad/extract";
import { lintScad } from "@/lib/scad/lint";
import { buildRepairMessage } from "@/lib/ai/system-prompt";
import type { ScadError } from "@/lib/scad/types";
import ChatPanel from "./chat-panel";
import { isAutoRepairMessage, uiMessageText } from "./chat-message";
import ViewerPanel, { type ViewerError } from "./viewer-panel";
import type { PillState } from "./status-pill";

const MAX_REPAIR_ATTEMPTS = 2;

export default function AppShell({ providerLabel }: { providerLabel: string }) {
  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const { compile, cancel, status: compilerStatus, result, failure } = useOpenscadCompiler();

  const [stl, setStl] = useState<ArrayBuffer | null>(null);
  const [viewerError, setViewerError] = useState<ViewerError | null>(null);
  const [repairAttempt, setRepairAttempt] = useState(0);
  const repairAttemptsRef = useRef(0);
  const lastCompiledSourceRef = useRef<string | null>(null);
  const prevChatStatusRef = useRef(status);

  const beginRepairOrFail = useCallback(
    (source: string, errors: ScadError[], stderr: string[]) => {
      if (source !== lastCompiledSourceRef.current) return;
      if (repairAttemptsRef.current < MAX_REPAIR_ATTEMPTS) {
        repairAttemptsRef.current += 1;
        setRepairAttempt(repairAttemptsRef.current);
        const lines = errors.map((e) =>
          e.line !== undefined ? `Line ${e.line}: ${e.message}` : e.message,
        );
        sendMessage({ text: buildRepairMessage(lines, stderr) });
      } else {
        setViewerError({
          title: `Compile failed after ${MAX_REPAIR_ATTEMPTS} automatic fix attempts`,
          hint: "Describe what to change in the chat and I'll try a different approach.",
          errors,
          stderr,
        });
      }
    },
    [sendMessage],
  );

  // Chat stream finished → extract fence → lint → compile.
  useEffect(() => {
    const finished = prevChatStatusRef.current !== "ready" && status === "ready";
    prevChatStatusRef.current = status;
    if (!finished) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return;
    let code = extractLastScadBlock(uiMessageText(lastAssistant));
    if (!code) return;
    if (process.env.NEXT_PUBLIC_DEBUG_BREAK === "1") code += "\nthis_is_a_debug_syntax_error(";
    if (code === lastCompiledSourceRef.current) return;
    lastCompiledSourceRef.current = code;
    setViewerError(null);
    const lintErrors = lintScad(code);
    if (lintErrors.length > 0) beginRepairOrFail(code, lintErrors, []);
    else compile(code);
  }, [status, messages, beginRepairOrFail, compile]);

  // Compile success → show model, reset the repair counter.
  useEffect(() => {
    if (!result || result.source !== lastCompiledSourceRef.current) return;
    setStl(result.stl);
    repairAttemptsRef.current = 0;
    setRepairAttempt(0);
  }, [result]);

  // Compile failure → auto-repair (compile errors) or surface (timeouts —
  // the model is too heavy, not wrong; repairing would burn rounds).
  useEffect(() => {
    if (!failure || failure.source !== lastCompiledSourceRef.current) return;
    if (failure.kind === "timeout") {
      setViewerError({
        title: "Render timed out after 60 seconds",
        hint: "This model is too heavy for the in-browser compiler. Ask for a simpler shape or lower detail.",
        errors: failure.errors,
        stderr: failure.stderr,
      });
    } else {
      beginRepairOrFail(failure.source, failure.errors, failure.stderr);
    }
  }, [failure, beginRepairOrFail]);

  // A fresh human message resets the repair counter and supersedes any
  // in-flight compile.
  const handleSend = useCallback(
    (text: string) => {
      repairAttemptsRef.current = 0;
      setRepairAttempt(0);
      cancel();
      sendMessage({ text });
    },
    [cancel, sendMessage],
  );

  // Dev-only debug harness: compile arbitrary source from the console and
  // inspect the last failure.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const debugWindow = window as unknown as Record<string, unknown>;
    debugWindow.__ask3dCompile = (source: string) => {
      lastCompiledSourceRef.current = source;
      setViewerError(null);
      compile(source);
    };
    debugWindow.__ask3dLastFailure = failure;
  }, [compile, failure]);

  const chatBusy = status === "submitted" || status === "streaming";
  let pillState: PillState;
  if (chatBusy) pillState = { kind: "generating", repairAttempt };
  else if (compilerStatus === "compiling") pillState = { kind: "compiling" };
  else if (viewerError || error) pillState = { kind: "error" };
  else if (stl) pillState = { kind: "ready" };
  else pillState = { kind: "idle" };

  const firstUserMessage = messages.find((m) => m.role === "user" && !isAutoRepairMessage(m));
  const nameHint = firstUserMessage ? uiMessageText(firstUserMessage) : "model";

  return (
    <div className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-bold tracking-widest">
          ask<span className="text-blue-500">3d</span>
        </h1>
        <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
          {providerLabel}
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col-reverse md:grid md:grid-cols-[minmax(360px,40%)_1fr]">
        <div className="min-h-0 flex-1 md:h-full">
          <ChatPanel
            messages={messages}
            busy={chatBusy}
            error={error}
            onSend={handleSend}
            onStop={stop}
          />
        </div>
        <div className="min-h-0 flex-1 md:h-full">
          <ViewerPanel stl={stl} pillState={pillState} viewerError={viewerError} nameHint={nameHint} />
        </div>
      </main>
    </div>
  );
}
