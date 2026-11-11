"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createStatueTask,
  fetchLatestStatueTask,
  fetchStatueModel,
  getDismissedStatueTaskId,
  pollStatueTask,
  setDismissedStatueTaskId,
  statueHealth,
  type StatueEngine,
  type StatueTaskStatus,
} from "../lib/statue";

const STATUE_POLL_MS = 4000;

export interface StatueProgress {
  uploadPath: string;
  phase: "starting" | "generating" | "converting";
  detail: string;
  elapsedSeconds: number;
}

interface StatueTaskInput {
  images: File[];
  engine: StatueEngine;
  sourceName: string;
  sourcePath: string;
}

export interface StatueDelivery {
  taskId: string;
  name: string;
  model: ArrayBuffer;
  format: "glb" | "obj" | "stl";
  sourcePath: string | null;
  note: string | undefined;
  repairWarning: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Owns the sidecar task lifecycle, holding the guard until delivery finishes. */
export function useStatueTask({ onDeliver, onError }: {
  onDeliver: (delivery: StatueDelivery) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [progress, setProgress] = useState<StatueProgress | null>(null);
  const statueRunningRef = useRef(false);
  // Keep the last adopted task for Clear and its basename for same-page retries.
  const lastStatueTaskRef = useRef<{ id: string; baseName: string } | null>(null);
  // Remember every exclusion on this page before any recovery answer can arrive.
  const excludedStatueTaskIdsRef = useRef<Set<string> | null>(null);
  if (excludedStatueTaskIdsRef.current === null) {
    const dismissedTaskId = getDismissedStatueTaskId();
    excludedStatueTaskIdsRef.current = new Set(dismissedTaskId ? [dismissedTaskId] : []);
  }

  // Fresh generations and post-reload recovery share polling and delivery.
  const adoptStatueTask = useCallback(
    async (taskId: string, baseName: string, sourcePath: string | null) => {
      lastStatueTaskRef.current = { id: taskId, baseName };
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
        setProgress({
          uploadPath: sourcePath ?? "",
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

      setProgress({
        uploadPath: sourcePath ?? "",
        phase: "converting",
        detail: "converting to STL…",
        elapsedSeconds: 0,
      });
      const model = await fetchStatueModel(taskId);
      await onDeliver({
        taskId,
        name: `${baseName}-statue-${taskId}.stl`,
        model,
        format: modelFormat,
        sourcePath,
        note: genNote,
        repairWarning,
      });
      excludedStatueTaskIdsRef.current?.add(taskId);
      setDismissedStatueTaskId(taskId);
    },
    [onDeliver],
  );

  const start = useCallback(
    async ({ images, engine, sourceName, sourcePath }: StatueTaskInput) => {
      if (statueRunningRef.current) return;
      onError(null);
      statueRunningRef.current = true;
      setProgress({ uploadPath: sourcePath, phase: "starting", detail: "contacting statue service…", elapsedSeconds: 0 });
      try {
        const health = await statueHealth();
        if (!health) {
          throw new Error(
            "The statue service is not running. Start it in a terminal:  uv run statue-service/server.py",
          );
        }
        const engineReady =
          engine === "hunyuan" ? health.engines?.hunyuan : health.engines?.space;
        if (!engineReady) {
          throw new Error(
            engine === "hunyuan"
              ? "Unlimited on-device generation needs a one-time install: run statue-service/setup.sh --local-engine (Apple silicon, ~15GB of weights). Or pick a cloud engine in the header — those work on any machine."
              : "Run statue-service/setup.sh to turn on photo-to-3D. It is small, works on any machine, and takes about a minute.",
          );
        }
        if (health.busy) throw new Error("The statue service is already generating a model.");

        const taskId = await createStatueTask(images, engine);
        await adoptStatueTask(taskId, sourceName.replace(/\.[^.]*$/, ""), sourcePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(
          /ZeroGPU quota/i.test(message)
            ? "Today's free GPU quota for statue generation is used up (about 2 statues/day on a free Hugging Face account). It resets 24 hours after the first generation — try again later."
            : /already being generated/i.test(message)
              ? "A statue is already generating — it keeps running even across page reloads, and the app reconnects to it automatically. Give it a minute or two."
              : message,
        );
      } finally {
        statueRunningRef.current = false;
        setProgress(null);
      }
    },
    [adoptStatueTask, onError],
  );

  // A statue task keeps running on the sidecar through page reloads —
  // adopt a running (or freshly finished) task instead of orphaning it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const latest = await fetchLatestStatueTask();
      if (cancelled || !latest || statueRunningRef.current) return;
      // A delayed answer must see all exclusions, even after storage was replaced.
      if (excludedStatueTaskIdsRef.current?.has(latest.id) || latest.id === getDismissedStatueTaskId()) return;
      const active = latest.status === "queued" || latest.status === "running";
      const fresh = latest.status === "succeeded" && latest.age_seconds < 600;
      if (!active && !fresh) return;
      statueRunningRef.current = true;
      setProgress({
        uploadPath: "",
        phase: "generating",
        detail: "reconnected to a statue in progress…",
        elapsedSeconds: 0,
      });
      try {
        const baseName = lastStatueTaskRef.current?.id === latest.id
          ? lastStatueTaskRef.current.baseName
          : "recovered";
        await adoptStatueTask(latest.id, baseName, null);
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        statueRunningRef.current = false;
        setProgress(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptStatueTask, onError]);

  // Clear only affects future recovery; in-flight work still delivers.
  const dismiss = useCallback(() => {
    if (lastStatueTaskRef.current) {
      excludedStatueTaskIdsRef.current?.add(lastStatueTaskRef.current.id);
      setDismissedStatueTaskId(lastStatueTaskRef.current.id);
    }
  }, []);

  return { progress, start, dismiss };
}
