"use client";

/**
 * The first screen anyone sees, so the examples do real work: each one
 * advertises a different capability — an angle, a multi-part plate, a snap
 * fit, lettering — and carries a small isometric glyph of the thing it makes,
 * drawn in the same blueprint language as the rest of the app.
 */

type Example = {
  prompt: string;
  /** What this example is really demonstrating. */
  teaches: string;
  icon: React.ReactNode;
};

const s = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const EXAMPLES: Example[] = [
  {
    prompt: "a phone stand angled at 60°",
    teaches: "angles",
    icon: (
      <g {...s}>
        <path d="M4 25 L28 25 L8 7 Z" />
        <path d="M11 22 L23 10" strokeOpacity="0.55" />
        <path d="M4 25 L4 27 L28 27 L28 25" strokeOpacity="0.4" />
      </g>
    ),
  },
  {
    prompt: "a hexagonal planter with a drainage tray",
    teaches: "two parts, one plate",
    icon: (
      <g {...s}>
        <path d="M7 9 L13 6 L19 9 L19 17 L13 20 L7 17 Z" />
        <path d="M7 9 L13 12 L19 9 M13 12 L13 20" strokeOpacity="0.5" />
        <path d="M14 24 L20 21 L27 24 L20 27 Z" strokeOpacity="0.8" />
      </g>
    ),
  },
  {
    prompt: "a cable clip for a 5mm cable",
    teaches: "snap fits",
    icon: (
      <g {...s}>
        <path d="M21 8 A9 9 0 1 0 21 24" />
        <circle cx="14" cy="16" r="3.4" strokeOpacity="0.55" />
        <path d="M24 6 L21 8 L24 10" strokeOpacity="0.7" />
      </g>
    ),
  },
  {
    prompt: "a desk nameplate with raised lettering",
    teaches: "text you can feel",
    icon: (
      <g {...s}>
        <path d="M4 20 L16 14 L28 20 L16 26 Z" />
        <path d="M4 20 L4 23 L16 29 L28 23 L28 20" strokeOpacity="0.45" />
        <path d="M11 18.5 L14 17 M15 17.3 L18 15.8 M19.5 16 L22.5 14.5" strokeOpacity="0.8" />
      </g>
    ),
  },
];

export default function ExamplePrompts({
  onPick,
  onPickPhoto,
}: {
  onPick: (prompt: string) => void;
  onPickPhoto: () => void;
}) {
  return (
    <div className="mx-auto mt-6 w-full max-w-md px-1">
      <p className="a3d-rise text-center text-sm text-neutral-300">
        Describe an object and I&apos;ll design it for 3D printing.
      </p>

      {/* The statue path is the least guessable thing the app does, so it gets
          a card of its own rather than living behind a "+" in the composer. */}
      <button
        type="button"
        onClick={onPickPhoto}
        className="a3d-rise group mt-4 flex w-full items-center gap-3 rounded-xl border border-[var(--beam-2)]/35 bg-[var(--beam-2)]/[0.07] p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--beam-2)]/70 hover:bg-[var(--beam-2)]/[0.12]"
        style={{ animationDelay: "90ms" }}
      >
        <span className="shrink-0 text-[var(--beam-2)] transition group-hover:scale-110">
          <svg viewBox="0 0 54 32" width="52" height="30" aria-hidden="true">
            <g {...s}>
              {/* photo */}
              <rect x="1" y="6" width="20" height="20" rx="3" />
              <circle cx="7.5" cy="12.5" r="2" />
              <path d="M2 22 L9 15 L14 20 L17 17.5 L20 20" />
              {/* becomes */}
              <path d="M25 16 L32 16 M29 13 L32 16 L29 19" strokeOpacity="0.75" />
              {/* a solid */}
              <path d="M44 4 L52 9 L52 23 L44 28 L36 23 L36 9 Z" />
              <path d="M44 4 L44 16 M36 9 L44 16 M52 9 L44 16" strokeOpacity="0.55" />
            </g>
          </svg>
        </span>
        <span className="min-w-0">
          <span className="block text-xs font-medium leading-snug text-[var(--beam-2)]">
            Turn a photo into a 3D model
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-neutral-400">
            Upload a photo of a real object — or drop it anywhere here. Add up to 4 angles of the
            same thing and it is sculpted into a printable mesh.
          </span>
        </span>
      </button>

      <p
        className="a3d-rise mt-5 mb-2 text-center text-[11px] font-medium uppercase tracking-wider text-neutral-600"
        style={{ animationDelay: "150ms" }}
      >
        or describe one
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {EXAMPLES.map((example, i) => (
          <button
            key={example.prompt}
            type="button"
            onClick={() => onPick(example.prompt)}
            className="a3d-rise group flex items-center gap-3 rounded-xl border border-[var(--rule)] bg-white/[0.02] p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--beam-1)]/45 hover:bg-[var(--beam-1)]/[0.06]"
            style={{ animationDelay: `${120 + i * 70}ms` }}
          >
            <span className="shrink-0 text-neutral-500 transition group-hover:scale-110 group-hover:text-[var(--beam-1)]">
              <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
                {example.icon}
              </svg>
            </span>
            <span className="min-w-0">
              <span className="block text-xs leading-snug text-neutral-300 transition group-hover:text-white">
                {example.prompt}
              </span>
              <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wider text-neutral-600">
                {example.teaches}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
