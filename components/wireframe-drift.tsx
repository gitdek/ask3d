"use client";

/**
 * A constellation of wireframe solids drifting far behind the conversation.
 *
 * Deliberately faint — this is texture, not content. Each solid rotates on its
 * own clock so the field never repeats visibly, and the whole thing is one
 * inert SVG: no state, no raf loop, nothing the compositor can't handle.
 */

type Solid = {
  /** left/top as percentages of the panel */
  x: number;
  y: number;
  size: number;
  dur: number;
  delay: number;
  opacity: number;
  shape: "cube" | "octa" | "cyl";
};

const SOLIDS: Solid[] = [
  { x: 12, y: 16, size: 86, dur: 52, delay: 0, opacity: 0.1, shape: "cube" },
  { x: 72, y: 30, size: 58, dur: 41, delay: -9, opacity: 0.08, shape: "octa" },
  { x: 24, y: 64, size: 70, dur: 63, delay: -21, opacity: 0.07, shape: "cyl" },
  { x: 78, y: 76, size: 44, dur: 36, delay: -5, opacity: 0.09, shape: "cube" },
  { x: 48, y: 44, size: 110, dur: 77, delay: -33, opacity: 0.05, shape: "octa" },
];

function Shape({ kind }: { kind: Solid["shape"] }) {
  const stroke = { stroke: "currentColor", strokeWidth: 1.4, fill: "none" as const };
  if (kind === "cube") {
    return (
      <g {...stroke}>
        <polygon points="24,4 41.3,14 41.3,34 24,44 6.7,34 6.7,14" />
        <path d="M24 4 L24 24 M6.7 14 L24 24 M41.3 14 L24 24" />
      </g>
    );
  }
  if (kind === "octa") {
    return (
      <g {...stroke}>
        <polygon points="24,3 44,24 24,45 4,24" />
        <path d="M4 24 L24 16 L44 24 M24 16 L24 3 M24 16 L24 45" />
      </g>
    );
  }
  return (
    <g {...stroke}>
      <ellipse cx="24" cy="13" rx="17" ry="8" />
      <path d="M7 13 L7 35 M41 13 L41 35" />
      <path d="M7 35 A17 8 0 0 0 41 35" />
    </g>
  );
}

export default function WireframeDrift() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden text-[var(--beam-1)]">
      {SOLIDS.map((s, i) => (
        <svg
          key={i}
          viewBox="0 0 48 48"
          width={s.size}
          height={s.size}
          aria-hidden="true"
          className="a3d-orbit absolute"
          style={{
            left: `${s.x}%`,
            top: `${s.y}%`,
            opacity: s.opacity,
            ["--dur" as string]: `${s.dur}s`,
            animationDelay: `${s.delay}s`,
          }}
        >
          <Shape kind={s.shape} />
        </svg>
      ))}
    </div>
  );
}
