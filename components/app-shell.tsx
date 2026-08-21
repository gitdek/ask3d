"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenscadCompiler } from "@/hooks/use-openscad-compiler";
import { downloadModel, slugify } from "@/lib/stl";
import { stlTo3mf } from "@/lib/threemf";
import { extractLastScadBlock } from "@/lib/scad/extract";
import { lintScad } from "@/lib/scad/lint";
import { buildRepairMessage } from "@/lib/ai/system-prompt";
import type { CompileFile, ScadError } from "@/lib/scad/types";
import { describeUpload, processUpload, uploadPath, type UploadedAsset } from "@/lib/uploads";
import {
  createStatueTask,
  fetchLatestStatueTask,
  fetchStatueModel,
  modelToPrintableStl,
  pollStatueTask,
  statueHealth,
  type StatueEngine,
} from "@/lib/statue";
import ChatPanel from "./chat-panel";
import { isAutoRepairMessage, uiMessageText } from "./chat-message";
import ViewerPanel, { type ViewerError } from "./viewer-panel";
import type { PillState } from "./status-pill";

const MAX_REPAIR_ATTEMPTS = 2;
const STATUE_TARGET_MAX_DIM_MM = 80;
const STATUE_POLL_MS = 4000;

export interface StatueProgress {
  uploadPath: string;
  phase: "starting" | "generating" | "converting";
  detail: string;
  elapsedSeconds: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attached photos are data URLs re-sent with the whole history every turn;
 * keep file parts only on the most recent message that has any, so old
 * images stop inflating request payloads.
 */
function trimOldImageParts(messages: UIMessage[]): UIMessage[] {
  let lastWithFiles = -1;
  messages.forEach((m, i) => {
    if (m.parts.some((p) => p.type === "file")) lastWithFiles = i;
  });
  return messages.map((m, i) =>
    i === lastWithFiles || !m.parts.some((p) => p.type === "file")
      ? m
      : { ...m, parts: m.parts.filter((p) => p.type !== "file") },
  );
}

function compileFilesOf(uploads: UploadedAsset[]): CompileFile[] {
  return uploads
    .filter((u) => u.compileData !== undefined)
    .map((u) => ({ path: u.path, data: u.compileData! }));
}

function allowedPathsOf(uploads: UploadedAsset[]): string[] {
  return uploads.filter((u) => u.compileData !== undefined).map((u) => u.path);
}

export default function AppShell({ providerLabel }: { providerLabel: string }) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { messages: trimOldImageParts(messages) },
        }),
      }),
    [],
  );
  const { messages, sendMessage, status, stop, error } = useChat({ transport });
  const { compile, cancel, status: compilerStatus, result, failure } = useOpenscadCompiler();

  const [stl, setStl] = useState<ArrayBuffer | null>(null);
  const [viewerError, setViewerError] = useState<ViewerError | null>(null);
  const [uploads, setUploads] = useState<UploadedAsset[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [statueProgress, setStatueProgress] = useState<StatueProgress | null>(null);
  const [statueEngine, setStatueEngine] = useState<StatueEngine>("hunyuan");
  const statueRunningRef = useRef(false);
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
      const source = failure.source;
      setViewerError({
        title: "Render timed out",
        hint: "This model is heavy for the in-browser compiler. Retry with more time, or ask for a simpler shape / lower detail.",
        errors: failure.errors,
        stderr: failure.stderr,
        retry: {
          label: "Retry with a 5-minute limit",
          run: () => {
            setViewerError(null);
            compile(source, compileFilesOf(uploadsRef.current), { timeoutMs: 300_000 });
          },
        },
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
  }, [failure, beginRepairOrFail, compile]);

  // Convert the current preview STL to 3MF (Bambu Studio's native format)
  // client-side — works for compiled models and statues alike.
  const handleDownload3mf = useCallback(
    (nameHint: string, buffer: ArrayBuffer) => {
      try {
        const threeMf = stlTo3mf(buffer, slugify(nameHint));
        downloadModel(threeMf.buffer as ArrayBuffer, slugify(nameHint), "3mf");
      } catch (err) {
        setUploadError(`3MF export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [],
  );

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

  // Poll a sidecar task to completion, convert the model, and register the
  // statue as a preview + uploaded mesh. Shared by fresh generations and
  // adopted (post-reload) tasks.
  const adoptStatueTask = useCallback(
    async (taskId: string, baseName: string, chipPath: string | null) => {
      let modelFormat: "glb" | "obj" | "stl" = "glb";
      for (;;) {
        await sleep(STATUE_POLL_MS);
        const s = await pollStatueTask(taskId);
        setStatueProgress({
          uploadPath: chipPath ?? "",
          phase: "generating",
          detail: s.detail || s.status,
          elapsedSeconds: s.elapsed_seconds,
        });
        if (s.status === "succeeded") {
          modelFormat = s.model_format ?? "glb";
          break;
        }
        if (s.status === "failed") throw new Error(s.error || "generation failed");
      }

      setStatueProgress({
        uploadPath: chipPath ?? "",
        phase: "converting",
        detail: "converting to STL…",
        elapsedSeconds: 0,
      });
      const modelBuffer = await fetchStatueModel(taskId);
      const { stl: statueStl, dims } = await modelToPrintableStl(
        modelBuffer,
        modelFormat,
        STATUE_TARGET_MAX_DIM_MM,
      );
      const statuePath = uploadPath(
        `${baseName}-statue`,
        "stl",
        new Set(uploadsRef.current.map((u) => u.path)),
      );
      const statueAsset: UploadedAsset = {
        name: `${baseName}-statue.stl`,
        path: statuePath,
        kind: "mesh",
        compileData: statueStl,
        dims,
      };
      uploadsRef.current = [...uploadsRef.current, statueAsset];
      unannouncedRef.current.add(statuePath);
      setUploads(uploadsRef.current);
      setViewerError(null);
      setStl(statueStl);
    },
    [],
  );

  // A statue task keeps running on the sidecar through page reloads —
  // adopt a running (or freshly finished) task instead of orphaning it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const latest = await fetchLatestStatueTask();
      if (cancelled || !latest || statueRunningRef.current) return;
      const active = latest.status === "queued" || latest.status === "running";
      const fresh = latest.status === "succeeded" && latest.age_seconds < 600;
      if (!active && !fresh) return;
      statueRunningRef.current = true;
      setStatueProgress({
        uploadPath: "",
        phase: "generating",
        detail: "reconnected to a statue in progress…",
        elapsedSeconds: 0,
      });
      try {
        await adoptStatueTask(latest.id, "recovered", null);
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : String(error));
      } finally {
        statueRunningRef.current = false;
        setStatueProgress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptStatueTask]);

  // Photo → local TRELLIS.2 sidecar → GLB → printable STL → preview + a new
  // mesh upload the chat can build around via import().
  const handleMakeStatue = useCallback(async (path: string) => {
    const asset = uploadsRef.current.find((u) => u.path === path);
    if (!asset || asset.kind !== "image" || !asset.file || statueRunningRef.current) return;
    setUploadError(null);
    statueRunningRef.current = true;
    setStatueProgress({ uploadPath: path, phase: "starting", detail: "contacting statue service…", elapsedSeconds: 0 });
    try {
      const health = await statueHealth();
      if (!health) {
        throw new Error(
          "The statue service is not running. Start it in a terminal:  uv run statue-service/server.py",
        );
      }
      const engineReady =
        statueEngine === "hunyuan" ? health.engines?.hunyuan : health.engines?.space;
      if (!engineReady) {
        throw new Error(
          statueEngine === "hunyuan"
            ? "The local engine is not set up — see the hunyuan-mlx section of the statue-service README."
            : "Cloud engines need the trellis-mac venv + a Hugging Face login (see statue-service README).",
        );
      }
      if (health.busy) throw new Error("The statue service is already generating a model.");

      // Multi-photo engine: send every attached photo in chip order
      // (front, back, left, right), starting from the clicked one.
      const images =
        statueEngine === "hunyuan-space"
          ? [
              asset.file,
              ...uploadsRef.current
                .filter((u) => u.kind === "image" && u.path !== path && u.file)
                .map((u) => u.file!)
                .slice(0, 3),
            ]
          : [asset.file];
      const taskId = await createStatueTask(images, statueEngine);
      await adoptStatueTask(taskId, asset.name.replace(/\.[^.]*$/, ""), path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUploadError(
        /ZeroGPU quota/i.test(message)
          ? "Today's free GPU quota for statue generation is used up (about 2 statues/day on a free Hugging Face account). It resets 24 hours after the first generation — try again later."
          : /already being generated/i.test(message)
            ? "A statue is already generating — it keeps running even across page reloads, and the app reconnects to it automatically. Give it a minute or two."
            : message,
      );
    } finally {
      statueRunningRef.current = false;
      setStatueProgress(null);
    }
  }, [statueEngine]);

  // Dev-only debug harness: compile arbitrary source from the console and
  // inspect the last failure.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const debugWindow = window as unknown as Record<string, unknown>;
    debugWindow.__ask3dCompile = (source: string, files?: CompileFile[]) => {
      lastCompiledSourceRef.current = source;
      setViewerError(null);
      compile(source, files ?? compileFilesOf(uploadsRef.current));
    };
    debugWindow.__ask3dLastResult = result
      ? { bytes: result.stl.byteLength, stderr: result.stderr }
      : null;
    debugWindow.__ask3dTo3mf = () => {
      const current = stl;
      if (!current) return "no model in the viewer";
      return `3mf: ${stlTo3mf(current, "debug").byteLength} bytes`;
    };
    debugWindow.__ask3dLastFailure = failure;
    debugWindow.__ask3dLastAssistantText = (() => {
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      return last ? uiMessageText(last) : null;
    })();
  }, [compile, failure, stl, result, messages]);

  const chatBusy = status === "submitted" || status === "streaming";
  let pillState: PillState;
  if (chatBusy) pillState = { kind: "generating", repairAttempt };
  else if (compilerStatus === "compiling") pillState = { kind: "compiling" };
  else if (statueProgress) pillState = { kind: "statue", elapsedSeconds: statueProgress.elapsedSeconds };
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
        <div className="flex items-center gap-2">
          <select
            value={statueEngine}
            onChange={(e) => setStatueEngine(e.target.value as StatueEngine)}
            title="Which engine generates photo statues"
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 focus:outline-none"
          >
            <option value="hunyuan">statues: local · unlimited</option>
            <option value="space">statues: cloud · best, ~2/day</option>
            <option value="hunyuan-space">statues: cloud · multi-photo</option>
          </select>
          <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
            {providerLabel}
          </span>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col-reverse md:grid md:grid-cols-[minmax(360px,40%)_1fr]">
        <div className="min-h-0 flex-1 md:h-full">
          <ChatPanel
            messages={messages}
            busy={chatBusy}
            error={error}
            uploads={uploads}
            uploadError={uploadError}
            statueProgress={statueProgress}
            onSend={handleSend}
            onStop={stop}
            onAttach={handleAttach}
            onRemoveUpload={handleRemoveUpload}
            onMakeStatue={handleMakeStatue}
          />
        </div>
        <div className="min-h-0 flex-1 md:h-full">
          <ViewerPanel
            stl={stl}
            pillState={pillState}
            viewerError={viewerError}
            nameHint={nameHint}
            onDownload3mf={() => stl && handleDownload3mf(nameHint, stl)}
          />
        </div>
      </main>
    </div>
  );
}
