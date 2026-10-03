"use client";

/**
 * The ask3d mark: an isometric cube that inks itself in like a technical
 * drawing, with a print head sweeping up through it on a loop. One SVG, no
 * images, no runtime cost beyond compositing — and it says "CAD" and
 * "3D printer" in the same glyph.
 *
 * Geometry: a unit isometric cube drawn from its silhouette hexagon plus the
 * three interior edges that meet at the centre vertex.
 */

const HEX = "M24 4 L41.3 14 L41.3 34 L24 44 L6.7 34 L6.7 14 Z";
const EDGE_UP = "M24 4 L24 24";
const EDGE_LEFT = "M6.7 14 L24 24";
const EDGE_RIGHT = "M41.3 14 L24 24";

export default function BrandMark({
  size = 34,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <defs>
        <linearGradient id="a3d-mark-beam" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--beam-1)" />
          <stop offset="100%" stopColor="var(--beam-2)" />
        </linearGradient>
        {/* The print head only lights the inside of the cube. */}
        <clipPath id="a3d-mark-clip">
          <path d={HEX} />
        </clipPath>
        <linearGradient id="a3d-mark-head" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--beam-1)" stopOpacity="0" />
          <stop offset="50%" stopColor="var(--beam-1)" stopOpacity="0.85" />
          <stop offset="100%" stopColor="var(--beam-1)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Deposited material: the lower part of the cube reads as solid. */}
      <g clipPath="url(#a3d-mark-clip)">
        <rect x="0" y="26" width="48" height="22" fill="url(#a3d-mark-beam)" opacity="0.14" />
        {/* print head sweep */}
        <rect x="0" y="-10" width="48" height="10" fill="url(#a3d-mark-head)">
          <animate
            attributeName="y"
            values="44;6;44"
            dur="4.2s"
            repeatCount="indefinite"
            keyTimes="0;0.55;1"
            calcMode="spline"
            keySplines="0.4 0 0.2 1;0.4 0 0.2 1"
          />
        </rect>
      </g>

      {/* The drawing itself. */}
      <g
        stroke="url(#a3d-mark-beam)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={HEX} className="a3d-ink" style={{ "--len": 120 } as React.CSSProperties} />
        <path
          d={EDGE_UP}
          className="a3d-ink"
          style={{ "--len": 24, "--delay": "520ms" } as React.CSSProperties}
          opacity="0.85"
        />
        <path
          d={EDGE_LEFT}
          className="a3d-ink"
          style={{ "--len": 24, "--delay": "660ms" } as React.CSSProperties}
          opacity="0.85"
        />
        <path
          d={EDGE_RIGHT}
          className="a3d-ink"
          style={{ "--len": 24, "--delay": "800ms" } as React.CSSProperties}
          opacity="0.85"
        />
      </g>

      {/* Centre vertex, the one point all three faces share. */}
      <circle cx="24" cy="24" r="1.9" fill="var(--beam-1)" className="a3d-breathe" />
    </svg>
  );
}
