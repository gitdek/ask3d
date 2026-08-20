"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOpenscadCompiler } from "@/hooks/use-openscad-compiler";
import { extractLastScadBlock } from "@/lib/scad/extract";
import { lintScad } from "@/lib/scad/lint";
import { buildRepairMessage } from "@/lib/ai/system-prompt";
import type { CompileFile, ScadError } from "@/lib/scad/types";
import { describeUpload, processUpload, type UploadedAsset } from "@/lib/uploads";
import ChatPanel from "./chat-panel";
import { isAutoRepairMessage, uiMessageText } from "./chat-message";
import ViewerPanel, { type ViewerError } from "./viewer-panel";
import type { PillState } from "./status-pill";

const MAX_REPAIR_ATTEMPTS = 2;

function compileFilesOf(uploads: UploadedAsset[]): CompileFile[] {
  return uploads
    .filter((u) => u.compileData !== undefined)
    .map((u) => ({ path: u.path, data: u.compileData! }));
}

function allowedPathsOf(uploads: UploadedAsset[]): string[] {
  return uploads.filter((u) => u.compileData !== undefined).map((u) => u.path);
}

export default function AppShell({ providerLabel }: { providerLabel: string }) {
  const { messages, sendMessage, status, stop, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const { compile, cancel, status: compilerStatus, result, failure } = useOpenscadCompiler();

  const [stl, setStl] = useState<ArrayBuffer | null>(null);
  const [viewerError, setViewerError] = useState<ViewerError | null>(null);
  const [uploads, setUploads] = useState<UploadedAsset[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadsRef = useRef<UploadedAsset[]>([]);
  // Paths added since the last send — their descriptions (and image parts)
  // ride along on the next message, once.
  const unannouncedRef = useRef<Set<string>>(new Set());
  const [repairAttempt, setRepairAttempt] = useState(0);
  const repairAttemptsRef = useRef(0);
  const lastCompiledSourceRef = useRef<string | null>(null);
  const lastSuccessfulSourceRef = useRef<string | null>(null);
  // Errors that triggered the in-flight repair round — consumed when the
  // repair reply re-emits identical code or contains no code at all.
  const pendingRepairRef = useRef<{ errors: ScadError[]; stderr: string[] } | null>(null);
  const prevChatStatusRef = useRef(status);

  const beginRepairOrFail = useCallback(
    (source: string, errors: ScadError[], stderr: string[]) => {
      if (source !== lastCompiledSourceRef.current) return;
      if (repairAttemptsRef.current < MAX_REPAIR_ATTEMPTS) {
        repairAttemptsRef.current += 1;
        setRepairAttempt(repairAttemptsRef.current);
        pendingRepairRef.current = { errors, stderr };
        const lines = errors.map((e) =>
          e.line !== undefined ? `Line ${e.line}: ${e.message}` : e.message,
        );
        sendMessage({ text: buildRepairMessage(lines, stderr) });
      } else {
        pendingRepairRef.current = null;
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
    if (!code) {
      // Mid-repair, a reply without code (prose apology, truncated fence) is
      // itself a failure — surface the stored errors instead of going silent.
      if (repairAttemptsRef.current > 0 && pendingRepairRef.current) {
        setViewerError({
          title: "The automatic fix attempt didn't produce code",
          hint: "Describe what to change in the chat and I'll try a different approach.",
          errors: pendingRepairRef.current.errors,
          stderr: pendingRepairRef.current.stderr,
        });
        repairAttemptsRef.current = 0;
        setRepairAttempt(0);
        pendingRepairRef.current = null;
      }
      return;
    }
    if (process.env.NEXT_PUBLIC_DEBUG_BREAK === "1") code += "\nthis_is_a_debug_syntax_error(";
    // Unchanged code that already compiled successfully: nothing to do.
    if (code === lastSuccessfulSourceRef.current) return;
    // The model re-emitted the failing program verbatim: count it as another
    // failed round (or exhaust) rather than silently stalling the loop.
    if (code === lastCompiledSourceRef.current && pendingRepairRef.current) {
      const pending = pendingRepairRef.current;
      beginRepairOrFail(code, pending.errors, pending.stderr);
      return;
    }
    lastCompiledSourceRef.current = code;
    setViewerError(null);
    pendingRepairRef.current = null;
    const lintErrors = lintScad(code, allowedPathsOf(uploadsRef.current));
    if (lintErrors.length > 0) beginRepairOrFail(code, lintErrors, []);
    else compile(code, compileFilesOf(uploadsRef.current));
  }, [status, messages, beginRepairOrFail, compile]);

  // Compile success → show model, reset the repair counter.
  useEffect(() => {
    if (!result || result.source !== lastCompiledSourceRef.current) return;
    setStl(result.stl);
    lastSuccessfulSourceRef.current = result.source;
    repairAttemptsRef.current = 0;
    setRepairAttempt(0);
    pendingRepairRef.current = null;
  }, [result]);

  // Compile failure → auto-repair (code faults) or surface directly:
  // timeouts mean the model is too heavy, environment failures mean the
  // compiler never loaded — neither is fixable by rewriting code.
  useEffect(() => {
    if (!failure || failure.source !== lastCompiledSourceRef.current) return;
    if (failure.kind === "timeout") {
      setViewerError({
        title: "Render timed out after 60 seconds",
        hint: "This model is too heavy for the in-browser compiler. Ask for a simpler shape or lower detail.",
        errors: failure.errors,
        stderr: failure.stderr,
      });
    } else if (failure.kind === "environment") {
      setViewerError({
        title: "The 3D compiler failed to load",
        hint: "This is an environment problem, not a model problem — check your connection and that /openscad assets are served, then reload the page.",
        errors: failure.errors,
        stderr: failure.stderr,
      });
    } else {
      beginRepairOrFail(failure.source, failure.errors, failure.stderr);
    }
  }, [failure, beginRepairOrFail]);

  // A fresh human message resets the repair counter and supersedes any
  // in-flight compile; nulling the source ref makes any late-landing stale
  // result or failure fail its staleness guard. Files attached since the
  // last send ride along: their descriptions in the text, photos as image
  // parts so the model can see them.
  const handleSend = useCallback(
    (text: string) => {
      repairAttemptsRef.current = 0;
      setRepairAttempt(0);
      pendingRepairRef.current = null;
      lastCompiledSourceRef.current = null;
      cancel();
      const fresh = uploadsRef.current.filter((u) => unannouncedRef.current.has(u.path));
      unannouncedRef.current.clear();
      let fullText = text;
      if (fresh.length > 0) {
        fullText += `\n\n[attached files]\n${fresh.map(describeUpload).join("\n")}`;
      }
      const imageParts: FileUIPart[] = fresh
        .filter((u) => u.imageDataUrl !== undefined)
        .map((u) => ({
          type: "file",
          mediaType: "image/jpeg",
          filename: u.name,
          url: u.imageDataUrl!,
        }));
      if (imageParts.length > 0) sendMessage({ text: fullText, files: imageParts });
      else sendMessage({ text: fullText });
    },
    [cancel, sendMessage],
  );

  const handleAttach = useCallback(async (files: File[]) => {
    setUploadError(null);
    for (const file of files) {
      try {
        const taken = new Set(uploadsRef.current.map((u) => u.path));
        const asset = await processUpload(file, taken);
        uploadsRef.current = [...uploadsRef.current, asset];
        unannouncedRef.current.add(asset.path);
        setUploads(uploadsRef.current);
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : String(error));
      }
    }
  }, []);

  const handleRemoveUpload = useCallback((path: string) => {
    uploadsRef.current = uploadsRef.current.filter((u) => u.path !== path);
    unannouncedRef.current.delete(path);
    setUploads(uploadsRef.current);
  }, []);

  // Dev-only debug harness: compile arbitrary source from the console and
  // inspect the last failure.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const debugWindow = window as unknown as Record<string, unknown>;
    debugWindow.__ask3dCompile = (source: string, files?: CompileFile[]) => {
      lastCompiledSourceRef.current = source;
      setViewerError(null);
      compile(source, files);
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
            uploads={uploads}
            uploadError={uploadError}
            onSend={handleSend}
            onStop={stop}
            onAttach={handleAttach}
            onRemoveUpload={handleRemoveUpload}
          />
        </div>
        <div className="min-h-0 flex-1 md:h-full">
          <ViewerPanel stl={stl} pillState={pillState} viewerError={viewerError} nameHint={nameHint} />
        </div>
      </main>
    </div>
  );
}
