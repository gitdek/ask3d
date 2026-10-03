"use client";

/**
 * Empty-viewer state. The part inks itself in like a shop drawing, and then a
 * constructive-solid-geometry loop plays forever: a cutting tool flies in,
 * the boolean fires, and a bore is left behind.
 *
 * That loop is the product's entire premise — solids combined by subtraction —
 * so the blank stage teaches the idea instead of apologising for being empty.
 */

// Isometric cube silhouette: hexagon about (160, 120), three visible faces
// meeting at the centre vertex.
const T = "160,50";
const UR = "220.6,85";
const LR = "220.6,155";
const B = "160,190";
const LL = "99.4,155";
const UL = "99.4,85";
const C = "160,120";

const ink = (len: number, delay: number) =>
  ({ "--len": len, "--delay": `${delay}ms` }) as React.CSSProperties;

export default function BlueprintEmpty() {
  return (
    <div className="pointer-events-none flex flex-col items-center gap-5 px-6 text-center">
      <svg
        viewBox="0 0 320 250"
        className="h-auto w-[min(23rem,62vw)] a3d-float"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="a3d-bp-edge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--beam-1)" />
            <stop offset="100%" stopColor="var(--beam-2)" />
          </linearGradient>
          <linearGradient id="a3d-bp-face" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--beam-1)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--beam-2)" stopOpacity="0.04" />
          </linearGradient>
          <radialGradient id="a3d-bp-flash">
            <stop offset="0%" stopColor="var(--beam-1)" stopOpacity="0.9" />
            <stop offset="100%" stopColor="var(--beam-1)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Faces, washed in once the outline lands. */}
        <g className="a3d-fade" style={{ animationDelay: "900ms" }}>
          <polygon points={`${T} ${UR} ${C} ${UL}`} fill="url(#a3d-bp-face)" />
          <polygon points={`${UL} ${C} ${B} ${LL}`} fill="url(#a3d-bp-face)" opacity="0.6" />
          <polygon points={`${C} ${LR} ${B}`} fill="url(#a3d-bp-face)" opacity="0.3" />
        </g>

        {/* The part. Drawn once, then it just exists. */}
        <g stroke="url(#a3d-bp-edge)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
          <polygon points={`${T} ${UR} ${LR} ${B} ${LL} ${UL}`} className="a3d-ink" style={ink(430, 0)} />
          <path d="M160 50 L160 120" className="a3d-ink" style={ink(72, 620)} opacity="0.9" />
          <path d="M99.4 85 L160 120" className="a3d-ink" style={ink(72, 740)} opacity="0.9" />
          <path d="M220.6 85 L160 120" className="a3d-ink" style={ink(72, 860)} opacity="0.9" />
        </g>

        {/* The cutting tool: an isometric cylinder that flies in and lands. */}
        <g className="a3d-csg-tool" stroke="var(--beam-2)" strokeWidth="1.5" fill="none">
          <ellipse cx="160" cy="55" rx="30" ry="17.3" fill="var(--beam-2)" fillOpacity="0.1" />
          <path d="M130 55 L130 85" />
          <path d="M190 55 L190 85" />
          <ellipse cx="160" cy="85" rx="30" ry="17.3" strokeDasharray="4 3" opacity="0.7" />
        </g>

        {/* The boolean firing. */}
        <circle cx="160" cy="85" r="34" fill="url(#a3d-bp-flash)" className="a3d-csg-flash" />

        {/* What the subtraction left behind. */}
        <ellipse
          cx="160"
          cy="85"
          rx="30"
          ry="17.3"
          className="a3d-csg-bore"
          stroke="url(#a3d-bp-edge)"
          strokeWidth="1.6"
          fill="#07070b"
          fillOpacity="0.55"
        />

        {/* Dimensions, in the muted ink a drawing uses for annotation. */}
        <g className="a3d-csg-dims">
          <g stroke="rgba(255,255,255,0.34)" strokeWidth="1">
            <path d="M99.4 206 L220.6 206" />
            <path d="M99.4 200 L99.4 212" />
            <path d="M220.6 200 L220.6 212" />
            <path d="M248 85 L248 155" />
            <path d="M242 85 L254 85" />
            <path d="M242 155 L254 155" />
            <path d="M178 76 L214 54" strokeDasharray="3 3" />
          </g>
          <g
            fill="rgba(255,255,255,0.55)"
            fontSize="11"
            fontFamily="var(--font-geist-mono), monospace"
          >
            <text x="160" y="224" textAnchor="middle">
              80.0
            </text>
            <text x="262" y="124">
              40.0
            </text>
            <text x="218" y="50">
              ⌀20
            </text>
          </g>
        </g>
      </svg>

      <div className="a3d-fade space-y-1.5" style={{ animationDelay: "1500ms" }}>
        <p className="text-sm font-medium text-neutral-300">Nothing on the plate yet</p>
        <p className="max-w-xs text-xs leading-relaxed text-neutral-500">
          Describe an object in the chat. It arrives here dimensioned, watertight and ready to
          slice.
        </p>
      </div>
    </div>
  );
}
