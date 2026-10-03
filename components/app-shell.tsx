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
import { parseScadWarnings } from "@/lib/scad/errors";
import { buildRepairMessage } from "@/lib/ai/system-prompt";
import type { CompileFile, ScadError } from "@/lib/scad/types";
import { describeUpload, meshAsset, processUpload, uploadPath, type UploadedAsset } from "@/lib/uploads";
import {
  createStatueTask,
  fetchLatestStatueTask,
  fetchStatueModel,
  modelToPrintableStl,
  pollStatueTask,
  statueHealth,
  type StatueEngine,
  type StatueTaskStatus,
} from "@/lib/statue";
import {
  clearHistory,
  deleteHistoryItem,
  getHistoryBytes,
  listHistory,
  makeImageThumb,
  migrateLocalLibrary,
  saveHistoryItem,
  type HistoryMeta,
} from "@/lib/history";
import BrandMark from "./brand-mark";
import SetupDialog from "./setup-dialog";
import { type ProviderId } from "@/lib/ai/config";
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
  /**
   * Re-attach the upload's images to this message. A chip clicked long after
   * the upload was announced would otherwise ask the model to match colours
   * against pictures it can no longer see.
   */
  reannounce?: boolean;
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
      ...(asset.sourcePhotoUrl
        ? [
            {
              label: "Colour it like the photo",
              prompt:
                "colour this model to match the photo it was sculpted from. Use the attached views to locate each feature, group the geometry into 2-4 printable colour regions, and pick the closest supported colour name for each.",
              action: "chat" as const,
              path: asset.path,
              reannounce: true,
            },
          ]
        : []),
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

export default function AppShell({
  providerLabel,
  configured,
  provider,
}: {
  providerLabel: string;
  configured: boolean;
  provider: ProviderId;
}) {
  // A missing key is the one thing that stops the app working at all, so the
  // dialog opens itself on first run and cannot be dismissed until it is set.
  const [isConfigured, setIsConfigured] = useState(configured);
  const [setupOpen, setSetupOpen] = useState(!configured);
  const [modelLabel, setModelLabel] = useState(providerLabel);
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
        .catch((error: unknown) => {
          // Console-only meant a model could fail to save and the only sign
          // was its absence from a shelf nobody checks straight away.
          console.warn("library save failed:", error);
          setUploadError(
            `${item.name} wasn't saved to the library (${error instanceof Error ? error.message : String(error)}). It's still in the viewer — download it before you clear.`,
          );
        });
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
  // Why the colors didn't take. A color group whose mask misses the geometry
  // renders empty, which used to leave a grey model and a plain "3MF" button
  // with the reason only in the console — the one place nobody looks.
  const [colorIssue, setColorIssue] = useState<string | null>(null);
  const applyColorParts = useCallback((parts: ColorPart[] | null) => {
    colorPartsRef.current = parts;
    setColorParts(parts);
    // Every path that resets the viewer's colors comes through here, so this
    // is the one place a stale explanation has to be dropped.
    setColorIssue(null);
  }, []);
  // Each compile result/failure is handled exactly once: the effects below
  // re-fire on dependency identity churn, and a second pass would send a
  // second repair message, re-save the library entry, or wipe finished
  // color parts.
  const handledResultRef = useRef<typeof result>(null);
  const handledFailureRef = useRef<typeof failure>(null);
  // Bumped whenever the viewer's model is replaced (compile, statue,
  // library restore, Clear) so background work started for an earlier
  // model — the per-color renders — can tell it has gone stale.
  const viewerGenRef = useRef(0);
  const [colorPending, setColorPending] = useState(false);
  const [warnings, setWarnings] = useState<ScadError[]>([]);
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

  // A statue, library restore, or Clear replaces whatever the viewer shows.
  // Forgetting the last successful source matters: a later reply that
  // re-emits that same program must compile again, not be skipped as
  // "already showing".
  const replaceViewerModel = useCallback(
    (bytes: ArrayBuffer | null) => {
      viewerGenRef.current += 1;
      lastSuccessfulSourceRef.current = null;
      applyColorParts(null);
      setColorPending(false);
      setWarnings([]);
      setViewerError(null);
      setStl(bytes);
    },
    [applyColorParts],
  );

  /**
   * Re-render each color group of a color-structured program in the
   * background, then tint the viewer and arm the per-color 3MF export.
   * Used after a compile and after a library restore — the library keeps
   * the source, so a restored model can get its colors back without the
   * chat that made it. The viewer generation captured here tells a slow
   * build to stand down if the model was replaced meanwhile.
   */
  const buildColorParts = useCallback(
    (source: string) => {
      const colorPlan = parseColorPlan(source);
      if (!colorPlan) return;
      const gen = viewerGenRef.current;
      setColorPending(true);
      void (async () => {
        const parts: ColorPart[] = [];
        const empty: string[] = [];
        for (let k = 1; k <= colorPlan.length; k++) {
          if (viewerGenRef.current !== gen) return;
          const name = colorPlan[k - 1];
          try {
            const stl = await compileOnce(
              colorPartSource(source, k),
              compileFilesOf(uploadsRef.current),
            );
            if (stl.byteLength >= 84 + 50) {
              parts.push({ name, hex: colorToHex(name), stl });
            } else {
              empty.push(name);
            }
          } catch (error) {
            // Overwhelmingly this is "Current top level object is empty":
            // the group's mask doesn't intersect the geometry. Common on an
            // imported mesh, whose interior the model cannot see.
            empty.push(name);
            console.warn(`[multi-color] part ${k} (${name}) render failed:`, error);
          }
        }
        if (viewerGenRef.current !== gen) return;
        setColorPending(false);
        if (parts.length >= 2) {
          applyColorParts(parts);
          if (empty.length) {
            setColorIssue(
              `${empty.join(" and ")} came out empty, so ${parts.length} of ${colorPlan.length} colors are showing. Ask for ${empty.length > 1 ? "those regions" : "that region"} to be placed differently.`,
            );
          }
        } else {
          applyColorParts(null);
          setColorIssue(
            `${empty.join(", ")} rendered empty, so the model stays one color. On an imported mesh that means the mask was aimed at a feature the model cannot see inside the import — ask it to split by region instead, e.g. "color it in three horizontal bands".`,
          );
        }
      })();
    },
    [applyColorParts],
  );

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
    if (handledResultRef.current === result) return;
    handledResultRef.current = result;
    // Empty output compiles "successfully" when nothing is instantiated at
    // the top level (e.g. the model left its module calls in a comment or
    // outside the code fence) — repairable, and worthless to display.
    if ((result.stl.byteLength - 84) / 50 <= 0) {
      beginRepairOrFail(
        result.source,
        [
          {
            message:
              "The program compiled but produced NO geometry. Make sure the modules are actually " +
              "instantiated at the top level of the program — as real statements, not inside a comment.",
          },
        ],
        [],
      );
      return;
    }
    viewerGenRef.current += 1;
    // A compile finishing is an external event (worker → hook state); the
    // viewer state follows it, which is exactly what this rule discourages
    // for derived state. Guarded above to run once per result.
    /* eslint-disable react-hooks/set-state-in-effect */
    applyColorParts(null);
    setColorPending(false);
    setWarnings(parseScadWarnings(result.stderr));
    setStl(result.stl); // show what compiled either way
    /* eslint-enable react-hooks/set-state-in-effect */
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
    // them and the 3MF exports per-color objects for AMS mapping. The
    // viewer generation captured here tells the loop to stand down if a
    // statue, restore, or Clear replaced the model meanwhile.
    buildColorParts(result.source);
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
  }, [result, captureHistory, beginRepairOrFail, applyColorParts, buildColorParts]);

  // Compile failure → auto-repair (code faults) or surface directly:
  // timeouts mean the model is too heavy, environment failures mean the
  // compiler never loaded — neither is fixable by rewriting code.
  useEffect(() => {
    if (!failure || failure.source !== lastCompiledSourceRef.current) return;
    if (handledFailureRef.current === failure) return;
    handledFailureRef.current = failure;
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
            // Re-arm the staleness guard: a chat message sent since the
            // timeout nulled it, and the retry's result would be discarded.
            lastCompiledSourceRef.current = source;
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
      const imageParts: FileUIPart[] = fresh.flatMap((u) => {
        const parts: FileUIPart[] = [];
        if (u.imageDataUrl !== undefined) {
          parts.push({
            type: "file",
            mediaType: "image/jpeg",
            // A mesh rides along as rendered views, not as itself — say so, or
            // the model reads the .stl name and thinks it was handed a picture.
            filename: u.kind === "mesh" ? `${u.name} — rendered views` : u.name,
            url: u.imageDataUrl,
          });
        }
        // A statue's own photo: the only colour reference that exists for it.
        if (u.sourcePhotoUrl !== undefined) {
          parts.push({
            type: "file",
            mediaType: "image/jpeg",
            filename: `${u.name} — source photo`,
            url: u.sourcePhotoUrl,
          });
        }
        return parts;
      });
      if (imageParts.length > 0) sendMessage({ text: fullText, files: imageParts });
      else sendMessage({ text: fullText });
    },
    [cancel, sendMessage],
  );

  const handleAttach = useCallback(
    async (files: File[], captureToLibrary = true) => {
      setUploadError(null);
      let suggestFor: UploadedAsset | null = null;
      for (const file of files) {
        try {
          const taken = new Set(uploadsRef.current.map((u) => u.path));
          const asset = await processUpload(file, taken);
          uploadsRef.current = [...uploadsRef.current, asset];
          unannouncedRef.current.add(asset.path);
          setUploads(uploadsRef.current);
          // Suggestions: instant generic set now, photo-specific ones from
          // the multimodal model (it sees the actual subject) after the loop.
          suggestionsPathRef.current = asset.path;
          setSuggestions(staticSuggestions(asset));
          if (asset.kind === "image" && asset.imageDataUrl) suggestFor = asset;
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
      // One vision call per batch, for the photo whose suggestions will
      // actually show (the last attached) — a multi-photo drop used to fire
      // one per file and discard all but the last.
      if (suggestFor && suggestionsPathRef.current === suggestFor.path) {
        const forPath = suggestFor.path;
        void fetch("/api/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: suggestFor.imageDataUrl }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { suggestions?: Omit<Suggestion, "path">[] } | null) => {
            if (!data?.suggestions?.length || suggestionsPathRef.current !== forPath) return;
            setSuggestions(data.suggestions.slice(0, 3).map((s) => ({ ...s, path: forPath })));
          })
          .catch(() => {}); // generic suggestions stay
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
      let repairWarning: string | null = null;
      let pollFailures = 0;
      for (;;) {
        await sleep(STATUE_POLL_MS);
        let s: StatueTaskStatus;
        try {
          s = await pollStatueTask(taskId);
          pollFailures = 0;
        } catch (error) {
          // A blip (sidecar restarting, laptop waking from sleep) must not
          // orphan a generation that is still running fine.
          if (++pollFailures >= 5) throw error;
          continue;
        }
        setStatueProgress({
          uploadPath: chipPath ?? "",
          phase: "generating",
          detail: s.detail || s.status,
          elapsedSeconds: s.elapsed_seconds,
        });
        if (s.status === "succeeded") {
          modelFormat = s.model_format ?? "glb";
          repairWarning = s.repair_warning ?? null;
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
        // Not `dims` alone: a statue is centred in X/Y and floored at Z=0, so
        // the model needs the box — and rendered views of what is inside it —
        // to aim color masks and cuts at anything.
        ...(await meshAsset(statueStl)),
        // The mesh is untextured; keep the photo so its colours can be
        // transferred later, long after the photo left the conversation.
        sourcePhotoUrl: chipPath
          ? uploadsRef.current.find((u) => u.path === chipPath)?.imageDataUrl
          : undefined,
      };
      uploadsRef.current = [...uploadsRef.current, statueAsset];
      unannouncedRef.current.add(statuePath);
      setUploads(uploadsRef.current);
      // The statue, not the photo, is now the thing to act on — and it is the
      // only asset that can offer "Colour it like the photo", so leaving the
      // photo's chips up hides the one suggestion the statue just earned.
      suggestionsPathRef.current = statuePath;
      setSuggestions(staticSuggestions(statueAsset));
      replaceViewerModel(statueStl);
      if (repairWarning) {
        setUploadError(
          `Statue delivered, but the watertight-repair step failed (${repairWarning}) — check the mesh in the slicer before printing.`,
        );
      }
      captureHistory(
        { kind: "statue", name: `${baseName}-statue.stl`, mime: "model/stl", dims, note: genNote },
        statueStl,
      );
    },
    [captureHistory, replaceViewerModel],
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
          replaceViewerModel(bytes);
          // The library keeps the program that produced the model, so a
          // color-structured one gets its colors (and its per-color 3MF)
          // back on restore instead of silently becoming single-body.
          if (item.scad) buildColorParts(item.scad);
        }
      } finally {
        restoringRef.current = false;
      }
    },
    [handleAttach, replaceViewerModel, buildColorParts],
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
    // Push any old per-browser library into the shared server store once,
    // then load the shared list.
    void migrateLocalLibrary().then(refreshHistory);
  }, [refreshHistory]);

  // "Clear" in the viewer: empty it and remember the statue task behind the
  // model so reload-adoption doesn't resurrect it. A generation still in
  // flight is unaffected — it delivers (and re-arms adoption) when done.
  const handleClearModel = useCallback(() => {
    replaceViewerModel(null);
    if (lastStatueTaskIdRef.current) {
      try {
        localStorage.setItem(DISMISSED_STATUE_TASK_KEY, lastStatueTaskIdRef.current);
      } catch {
        // localStorage unavailable — clear still works for this session
      }
    }
  }, [replaceViewerModel]);

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
            ? "Unlimited on-device generation needs a one-time install: run statue-service/setup.sh --local-engine (Apple silicon, ~15GB of weights). Or pick a cloud engine in the header — those work on any machine."
            : "Run statue-service/setup.sh to turn on photo-to-3D. It is small, works on any machine, and takes about a minute.",
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
      else if (s.prompt) {
        if (s.reannounce) unannouncedRef.current.add(s.path);
        handleSend(s.prompt);
      }
    },
    [handleMakeStatue, handleSend],
  );

  // Dev-only debug harness: compile arbitrary source from the console and
  // inspect the last failure.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const debugWindow = window as unknown as Record<string, unknown>;
    debugWindow.__ask3dColorParts = () =>
      colorPartsRef.current?.map((p) => `${p.name}:${p.stl.byteLength}b`) ?? null;
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
    <div className="relative flex h-dvh flex-col bg-[var(--background)] text-[var(--foreground)]">
      <SetupDialog
        open={setupOpen}
        dismissable={isConfigured}
        initialProvider={provider}
        onClose={() => setSetupOpen(false)}
        onSaved={(p, m) => {
          setModelLabel(`${p}/${m}`);
          setIsConfigured(true);
        }}
      />
      <header className="relative z-20 flex shrink-0 items-center justify-between gap-3 border-b border-[var(--rule)] bg-[var(--panel)]/80 px-4 py-2.5 backdrop-blur">
        <h1 className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="text-sm font-bold tracking-[0.2em]">
            ask<span className="a3d-beam-text">3d</span>
          </span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            title="Past photos and models, kept across reloads"
            className={`rounded-full border px-3 py-1 text-xs transition ${
              historyOpen
                ? "border-[var(--beam-1)]/50 bg-[var(--beam-1)]/10 text-[var(--beam-1)]"
                : "border-[var(--rule)] text-neutral-400 hover:border-[var(--rule-strong)] hover:text-neutral-100"
            }`}
          >
            Library
            {historyItems.length > 0 && (
              <span className="ml-1.5 tabular-nums opacity-70">{historyItems.length}</span>
            )}
          </button>
          <select
            value={statueEngine}
            onChange={(e) => setStatueEngine(e.target.value as StatueEngine)}
            title="Which engine generates photo statues"
            className="hidden rounded-full border border-[var(--rule)] bg-transparent px-3 py-1 text-xs text-neutral-400 transition hover:border-[var(--rule-strong)] focus:outline-none sm:block"
          >
            <option value="hunyuan">statues: local · unlimited · 1–4 photos</option>
            <option value="space">statues: cloud · best, ~2/day</option>
            <option value="hunyuan-space">statues: cloud · multi-photo</option>
          </select>
          <button
            type="button"
            onClick={() => setSetupOpen(true)}
            title="Change the model or API key"
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--rule)] px-3 py-1 font-mono text-xs text-neutral-500 transition hover:border-[var(--rule-strong)] hover:text-neutral-300"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${isConfigured ? "bg-[var(--beam-3)]" : "bg-[var(--warn)]"}`}
            />
            <span className="hidden md:inline">{modelLabel}</span>
            <span className="md:hidden">model</span>
          </button>
        </div>
      </header>
      {/* Hairline under the header that runs while the machine is working —
          the same signal as the pipeline rail, readable from across a room. */}
      <div className="relative z-20 h-px shrink-0 overflow-hidden bg-[var(--rule)]">
        {chatBusy || compilerStatus === "compiling" || statueProgress ? (
          <span className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-[var(--beam-1)] to-transparent a3d-travel" />
        ) : null}
      </div>
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
            onOpenSetup={() => setSetupOpen(true)}
          />
        </div>
        <div className="min-h-0 flex-1 md:h-full">
          <ViewerPanel
            stl={stl}
            colorParts={colorParts}
            colorPending={colorPending}
            colorIssue={colorIssue}
            warnings={warnings}
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
