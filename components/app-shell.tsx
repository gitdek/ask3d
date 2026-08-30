"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenscadCompiler } from "@/hooks/use-openscad-compiler";
import { downloadModel, slugify } from "@/lib/stl";
import { stlTo3mf, stlTo3mfMulti, type ColorPart } from "@/lib/threemf";
import { extractLastScadBlock } from "@/lib/scad/extract";
import { analyzeStlComponents } from "@/lib/scad/components";
import { colorPartSource, colorToHex, parseColorPlan } from "@/lib/scad/colors";
import { compileOnce } from "@/lib/scad/compile-once";
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
import {
  clearHistory,
  deleteHistoryItem,
  getHistoryBytes,
  listHistory,
  makeImageThumb,
  saveHistoryItem,
  type HistoryMeta,
} from "@/lib/history";
import ChatPanel from "./chat-panel";
import { isAutoRepairMessage, uiMessageText } from "./chat-message";
import HistoryPanel from "./history-panel";
import ViewerPanel, { type ViewerError } from "./viewer-panel";
import type { PillState } from "./status-pill";

const MAX_REPAIR_ATTEMPTS = 2;
const STATUE_TARGET_MAX_DIM_MM = 80;
const STATUE_POLL_MS = 4000;
const DISMISSED_STATUE_TASK_KEY = "ask3d:dismissed-statue-task";

export interface Suggestion {
  label: string;
  prompt: string;
  action: "chat" | "statue";
  /** Upload the suggestion refers to (statue actions run on it). */
  path: string;
}

/** Instant generic suggestions shown while the model looks at the photo. */
function staticSuggestions(asset: UploadedAsset): Suggestion[] {
  if (asset.kind === "image") {
    return [
      { label: "Make a 3D statue of this", prompt: "", action: "statue", path: asset.path },
      {
        label: "Relief plaque of this photo",
        prompt: "a relief plaque of this photo, 100mm wide, with a hanging hole",
        action: "chat",
        path: asset.path,
      },
      {
        label: "Lithophane night-light panel",
        prompt: "a lithophane panel of this photo, 90mm wide, in a simple stand",
        action: "chat",
        path: asset.path,
      },
    ];
  }
  if (asset.kind === "mesh") {
    return [
      {
        label: "Mount it on a pedestal",
        prompt: "mount the uploaded model on a round pedestal, 15mm tall, with a smooth chamfer",
        action: "chat",
        path: asset.path,
      },
      {
        label: "Scale it to 60mm",
        prompt: "scale the uploaded model so its largest dimension is 60mm and center it on the plate",
        action: "chat",
        path: asset.path,
      },
    ];
  }
  return [
    {
      label: "Improve this design",
      prompt: "review the uploaded OpenSCAD file and rebuild it cleaner and more printable",
      action: "chat",
      path: asset.path,
    },
  ];
}

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryMeta[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  // Which upload the current suggestions belong to — a newer attachment or
  // a removal invalidates in-flight suggestion fetches for older ones.
  const suggestionsPathRef = useRef<string | null>(null);
  const nameHintRef = useRef("model");

  const refreshHistory = useCallback(async () => {
    try {
      setHistoryItems(await listHistory());
    } catch {
      // IndexedDB unavailable — the library just shows empty
    }
  }, []);

  // Persist to the library, best-effort: quota or private-mode failures
  // must never break the action that triggered the save.
  const captureHistory = useCallback(
    (item: Omit<HistoryMeta, "id" | "createdAt" | "size">, bytes: ArrayBuffer) => {
      void saveHistoryItem(item, bytes)
        .then(refreshHistory)
        .catch((error) => console.warn("library save failed:", error));
    },
    [refreshHistory],
  );
  const statueRunningRef = useRef(false);
  // The sidecar task behind the model currently in the viewer — recorded so
  // "Clear" can dismiss it and reload-adoption won't resurrect it.
  const lastStatueTaskIdRef = useRef<string | null>(null);
  // Per-color STLs for multi-color 3MF export and tinted preview
  // (lib/scad/colors.ts) — built in the background after a
  // color-structured compile succeeds. State drives the viewer; the ref
  // mirror keeps the download callback dependency-free.
  const [colorParts, setColorParts] = useState<ColorPart[] | null>(null);
  const colorPartsRef = useRef<ColorPart[] | null>(null);
  const applyColorParts = useCallback((parts: ColorPart[] | null) => {
    colorPartsRef.current = parts;
    setColorParts(parts);
  }, []);
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

  // Compile success → show model, reset the repair counter. But first, a
  // geometry sanity check: a difference() that slices clean through a part
  // compiles fine yet leaves severed fragments floating in the air (they
  // print as loose debris). Detect that and run it through the same
  // auto-repair loop as a compile error.
  useEffect(() => {
    if (!result || result.source !== lastCompiledSourceRef.current) return;
    setStl(result.stl); // show what compiled either way
    const report = analyzeStlComponents(result.stl);
    if (report.debrisCount > 0 && repairAttemptsRef.current < MAX_REPAIR_ATTEMPTS) {
      beginRepairOrFail(
        result.source,
        [
          {
            message:
              `The model compiled but has ${report.debrisCount} small disconnected piece(s) floating in the air ` +
              `(${report.componentCount} separate solids total) — likely a cut that sliced clean through the part, ` +
              `or a feature positioned without overlap. Every piece must overlap its neighbours by at least 0.2mm ` +
              `and union into connected geometry. Rewrite the program so the result is connected (or has only ` +
              `deliberate, plate-touching separate parts).`,
          },
        ],
        [],
      );
      return;
    }
    lastSuccessfulSourceRef.current = result.source;
    repairAttemptsRef.current = 0;
    setRepairAttempt(0);
    pendingRepairRef.current = null;
    // Multi-color: a color-structured program gets its parts re-rendered
    // one by one in the background; when they're all in, the viewer tints
    // them and the 3MF exports per-color objects for AMS mapping.
    applyColorParts(null);
    const colorPlan = parseColorPlan(result.source);
    if (colorPlan) {
      const src = result.source;
      void (async () => {
        const parts: ColorPart[] = [];
        for (let k = 1; k <= colorPlan.length; k++) {
          try {
            const stl = await compileOnce(colorPartSource(src, k), compileFilesOf(uploadsRef.current));
            if (stl.byteLength >= 84 + 50) {
              parts.push({ name: colorPlan[k - 1], hex: colorToHex(colorPlan[k - 1]), stl });
            }
          } catch (error) {
            console.warn(`[multi-color] part ${k} render failed:`, error);
          }
        }
        if (lastCompiledSourceRef.current === src && parts.length >= 2) {
          applyColorParts(parts);
          console.info(`[multi-color] ${parts.length} color parts ready — 3MF will export per-color objects`);
        }
      })();
    }
    // Refinements of the same request upsert one library entry, so
    // iteration keeps the final version — along with the prompt that made
    // it and the OpenSCAD source it compiled from.
    captureHistory(
      {
        kind: "compiled",
        name: `${slugify(nameHintRef.current)}.stl`,
        mime: "model/stl",
        prompt: nameHintRef.current,
        scad: result.source,
      },
      result.stl,
    );
  }, [result, captureHistory, beginRepairOrFail]);

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
  // client-side — works for compiled models and statues alike. When the
  // model was color-structured (see lib/scad/colors.ts) and the per-color
  // parts finished rendering, export one object per color so the AMS can
  // map filaments automatically.
  const handleDownload3mf = useCallback(
    (nameHint: string, buffer: ArrayBuffer) => {
      try {
        const parts = colorPartsRef.current;
        const threeMf =
          parts && parts.length >= 2
            ? stlTo3mfMulti(parts, slugify(nameHint))
            : stlTo3mf(buffer, slugify(nameHint));
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

  const handleAttach = useCallback(
    async (files: File[], captureToLibrary = true) => {
      setUploadError(null);
      for (const file of files) {
        try {
          const taken = new Set(uploadsRef.current.map((u) => u.path));
          const asset = await processUpload(file, taken);
          uploadsRef.current = [...uploadsRef.current, asset];
          unannouncedRef.current.add(asset.path);
          setUploads(uploadsRef.current);
          // Suggestions: instant generic set, then photo-specific ones from
          // the multimodal model (it sees the actual subject) when they land.
          suggestionsPathRef.current = asset.path;
          setSuggestions(staticSuggestions(asset));
          if (asset.kind === "image" && asset.imageDataUrl) {
            const forPath = asset.path;
            void fetch("/api/suggest", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ image: asset.imageDataUrl }),
            })
              .then((r) => (r.ok ? r.json() : null))
              .then((data: { suggestions?: Omit<Suggestion, "path">[] } | null) => {
                if (!data?.suggestions?.length || suggestionsPathRef.current !== forPath) return;
                setSuggestions(data.suggestions.slice(0, 3).map((s) => ({ ...s, path: forPath })));
              })
              .catch(() => {}); // generic suggestions stay
          }
          if (captureToLibrary) {
            // Best-effort from here on: the chip is committed, so a failed
            // library snapshot must not report the attach as failed.
            try {
              const bytes = await file.arrayBuffer();
              const thumb =
                asset.kind === "image" ? (await makeImageThumb(file)) ?? undefined : undefined;
              captureHistory(
                { kind: asset.kind, name: file.name, mime: file.type || "", thumb },
                bytes,
              );
            } catch (error) {
              console.warn("library snapshot failed:", error);
            }
          }
        } catch (error) {
          setUploadError(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [captureHistory],
  );

  const handleRemoveUpload = useCallback((path: string) => {
    uploadsRef.current = uploadsRef.current.filter((u) => u.path !== path);
    unannouncedRef.current.delete(path);
    if (suggestionsPathRef.current === path) {
      suggestionsPathRef.current = null;
      setSuggestions(null);
    }
    setUploads(uploadsRef.current);
  }, []);

  // Poll a sidecar task to completion, convert the model, and register the
  // statue as a preview + uploaded mesh. Shared by fresh generations and
  // adopted (post-reload) tasks.
  const adoptStatueTask = useCallback(
    async (taskId: string, baseName: string, chipPath: string | null) => {
      lastStatueTaskIdRef.current = taskId;
      let modelFormat: "glb" | "obj" | "stl" = "glb";
      let genNote: string | undefined;
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
          // Provenance for the library: enough to reproduce this exact statue.
          genNote =
            [
              s.engine,
              s.seed != null ? `seed ${s.seed}` : null,
              s.octree ? `octree ${s.octree}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined;
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
      applyColorParts(null);
      setStl(statueStl);
      captureHistory(
        { kind: "statue", name: `${baseName}-statue.stl`, mime: "model/stl", dims, note: genNote },
        statueStl,
      );
    },
    [captureHistory, applyColorParts],
  );

  // A statue task keeps running on the sidecar through page reloads —
  // adopt a running (or freshly finished) task instead of orphaning it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const latest = await fetchLatestStatueTask();
      if (cancelled || !latest || statueRunningRef.current) return;
      // A task the user explicitly cleared stays gone across reloads.
      let dismissed: string | null = null;
      try {
        dismissed = localStorage.getItem(DISMISSED_STATUE_TASK_KEY);
      } catch {
        // localStorage unavailable (private mode) — adoption just re-runs
      }
      if (latest.id === dismissed) return;
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

  // Library: restore puts an item back exactly as if freshly attached —
  // models additionally load straight into the viewer. No re-capture (the
  // item is already in the library) and no concurrent restores (double
  // clicks would race handleAttach into duplicate /uploads/ paths).
  const restoringRef = useRef(false);
  const handleRestoreHistory = useCallback(
    async (item: HistoryMeta) => {
      if (restoringRef.current) return;
      restoringRef.current = true;
      setHistoryOpen(false);
      try {
        const bytes = await getHistoryBytes(item.id).catch(() => null);
        if (!bytes) {
          setUploadError("That library item's data is missing — it may have been evicted.");
          return;
        }
        const isModel = item.kind === "statue" || item.kind === "compiled" || item.kind === "mesh";
        const name = isModel && !/\.stl$/i.test(item.name) ? `${item.name}.stl` : item.name;
        await handleAttach([new File([bytes], name, { type: item.mime || undefined })], false);
        if (isModel) {
          setViewerError(null);
          applyColorParts(null);
          setStl(bytes);
        }
      } finally {
        restoringRef.current = false;
      }
    },
    [handleAttach],
  );

  const handleDeleteHistory = useCallback(
    (id: string) => {
      void deleteHistoryItem(id).then(refreshHistory).catch(() => {});
    },
    [refreshHistory],
  );

  const handleClearHistory = useCallback(() => {
    void clearHistory().then(refreshHistory).catch(() => {});
  }, [refreshHistory]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  // "Clear" in the viewer: empty it and remember the statue task behind the
  // model so reload-adoption doesn't resurrect it. A generation still in
  // flight is unaffected — it delivers (and re-arms adoption) when done.
  const handleClearModel = useCallback(() => {
    setStl(null);
    setViewerError(null);
    applyColorParts(null);
    if (lastStatueTaskIdRef.current) {
      try {
        localStorage.setItem(DISMISSED_STATUE_TASK_KEY, lastStatueTaskIdRef.current);
      } catch {
        // localStorage unavailable — clear still works for this session
      }
    }
  }, []);

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

      // Multi-photo engine: send every attached photo in chip order,
      // starting from the clicked one. Slot order is Hunyuan-canonical
      // (front, left, back, right) — see createStatueTask.
      const images =
        statueEngine === "hunyuan-space" || statueEngine === "hunyuan"
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

  const handleSuggestion = useCallback(
    (s: Suggestion) => {
      setSuggestions(null);
      suggestionsPathRef.current = null;
      if (s.action === "statue") void handleMakeStatue(s.path);
      else if (s.prompt) handleSend(s.prompt);
    },
    [handleMakeStatue, handleSend],
  );

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
  // Sent messages carry an appended "[attached files]" block — strip it so
  // filenames and library prompts show only what the user actually typed.
  const userText = (m: UIMessage | undefined) =>
    m ? uiMessageText(m).split("\n\n[attached files]")[0].trim() || "model" : "model";
  const nameHint = userText(firstUserMessage);
  // Library entries are named by the LATEST request, not the session's
  // first — otherwise a second unrelated model in the same chat would
  // upsert-overwrite the first one's entry under the wrong name.
  const lastUserMessage = messages.findLast((m) => m.role === "user" && !isAutoRepairMessage(m));
  nameHintRef.current = userText(lastUserMessage);

  return (
    <div className="relative flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-2">
        <h1 className="text-sm font-bold tracking-widest">
          ask<span className="text-blue-500">3d</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            title="Past photos and models, kept across reloads"
            className={`rounded px-2 py-0.5 text-xs transition ${
              historyOpen
                ? "bg-neutral-600 text-white"
                : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
            }`}
          >
            Library{historyItems.length > 0 && ` · ${historyItems.length}`}
          </button>
          <select
            value={statueEngine}
            onChange={(e) => setStatueEngine(e.target.value as StatueEngine)}
            title="Which engine generates photo statues"
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 focus:outline-none"
          >
            <option value="hunyuan">statues: local · unlimited · 1–4 photos</option>
            <option value="space">statues: cloud · best, ~2/day</option>
            <option value="hunyuan-space">statues: cloud · multi-photo</option>
          </select>
          <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
            {providerLabel}
          </span>
        </div>
      </header>
      {historyOpen && (
        <HistoryPanel
          items={historyItems}
          onRestore={handleRestoreHistory}
          onDelete={handleDeleteHistory}
          onClearAll={handleClearHistory}
          onClose={() => setHistoryOpen(false)}
        />
      )}
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
            suggestions={suggestions}
            onSuggestion={handleSuggestion}
          />
        </div>
        <div className="min-h-0 flex-1 md:h-full">
          <ViewerPanel
            stl={stl}
            colorParts={colorParts}
            pillState={pillState}
            viewerError={viewerError}
            nameHint={nameHint}
            onDownload3mf={() => stl && handleDownload3mf(nameHint, stl)}
            onClear={handleClearModel}
          />
        </div>
      </main>
    </div>
  );
}
