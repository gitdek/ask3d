"use client";

/**
 * Dev-only: shows exactly what the model is sent for an uploaded mesh.
 *
 * The views in lib/mesh-views.ts are the difference between the model
 * knowing where a feature is and guessing, so there needs to be somewhere
 * to look at them. Not reachable in a production build.
 */

import { useEffect, useState } from "react";
import { meshBox } from "@/lib/uploads";
import { renderMeshViews } from "@/lib/mesh-views";

type Item = { id: string; name: string; kind: string };

export default function ViewCheck() {
  const [items, setItems] = useState<Item[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("loading meshes…");

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/library");
      const data = (await res.json()) as { items: Item[] };
      const meshes = data.items.filter((i) => i.kind === "statue" || i.kind === "mesh" || i.kind === "compiled");
      setItems(meshes);
      setStatus(meshes.length ? "pick a mesh" : "no meshes in the library");
    })();
  }, []);

  useEffect(() => {
    if (!chosen) return;
    void (async () => {
      setUrl(null);
      setStatus("rendering…");
      try {
        const t0 = performance.now();
        const bytes = await (await fetch(`/api/library?id=${chosen}`)).arrayBuffer();
        const { box } = await meshBox(bytes);
        const views = await renderMeshViews(bytes, box);
        setUrl(views?.dataUrl ?? null);
        setStatus(
          views
            ? `${Math.round(performance.now() - t0)}ms — ${views.legend}`
            : "render returned null (no WebGL?)",
        );
      } catch (e) {
        setStatus("threw: " + (e instanceof Error ? e.message : String(e)));
      }
    })();
  }, [chosen]);

  if (process.env.NODE_ENV === "production") return <p style={{ padding: 24 }}>Not available.</p>;

  return (
    <div style={{ background: "#0b0b0f", color: "#d6dde6", minHeight: "100vh", padding: 20, fontFamily: "ui-monospace, monospace" }}>
      <h1 style={{ fontSize: 15, marginBottom: 12 }}>What the model sees for a mesh</h1>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {items.map((i) => (
          <button
            key={i.id}
            onClick={() => setChosen(i.id)}
            style={{
              background: chosen === i.id ? "#22d3ee22" : "transparent",
              border: "1px solid #ffffff22", color: "inherit",
              borderRadius: 7, padding: "5px 9px", fontSize: 11, cursor: "pointer",
            }}
          >
            {i.name}
          </button>
        ))}
      </div>
      <p id="status" style={{ fontSize: 11, color: "#8ba6c0", marginBottom: 12 }}>{status}</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing for next/image to optimize */}
      {url && <img id="views" src={url} alt="rendered views of the mesh" />}
    </div>
  );
}
