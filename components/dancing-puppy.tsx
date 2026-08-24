"use client";

/**
 * A dancing Rhodesian Ridgeback puppy for long waits (statue generation
 * runs minutes). Pure SVG + CSS keyframes — no assets, no 3D. Wheaten
 * coat, dark muzzle, floppy ears, the breed's signature back ridge, and
 * a happy little two-step with floating music notes.
 */

interface DancingPuppyProps {
  /** Compact corner mode (a model is showing behind it). */
  small?: boolean;
  caption?: string;
}

export default function DancingPuppy({ small = false, caption }: DancingPuppyProps) {
  return (
    <div
      className={`pointer-events-none flex flex-col items-center gap-1 ${small ? "" : "gap-2"}`}
      aria-hidden="true"
    >
      <style>{`
        @keyframes puppy-bob {
          0%, 100% { transform: translateY(0) rotate(-4deg); }
          25% { transform: translateY(-7%) rotate(0deg); }
          50% { transform: translateY(0) rotate(4deg); }
          75% { transform: translateY(-7%) rotate(0deg); }
        }
        @keyframes puppy-ear-l {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(-14deg); }
          75% { transform: rotate(8deg); }
        }
        @keyframes puppy-ear-r {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(10deg); }
          75% { transform: rotate(-12deg); }
        }
        @keyframes puppy-tail {
          0%, 100% { transform: rotate(-18deg); }
          50% { transform: rotate(22deg); }
        }
        @keyframes puppy-leg-a {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(-16deg); }
        }
        @keyframes puppy-leg-b {
          0%, 100% { transform: rotate(0deg); }
          75% { transform: rotate(16deg); }
        }
        @keyframes puppy-note {
          0% { opacity: 0; transform: translate(0, 6px) scale(0.7); }
          25% { opacity: 1; }
          100% { opacity: 0; transform: translate(8px, -26px) scale(1.1); }
        }
        .puppy-body { animation: puppy-bob 0.9s ease-in-out infinite; transform-origin: 50% 78%; }
        .puppy-ear-l { animation: puppy-ear-l 0.9s ease-in-out infinite; transform-origin: 62px 34px; }
        .puppy-ear-r { animation: puppy-ear-r 0.9s ease-in-out infinite; transform-origin: 88px 34px; }
        .puppy-tail { animation: puppy-tail 0.45s ease-in-out infinite; transform-origin: 24px 74px; }
        .puppy-leg-a { animation: puppy-leg-a 0.9s ease-in-out infinite; transform-origin: 50% 0%; }
        .puppy-leg-b { animation: puppy-leg-b 0.9s ease-in-out infinite; transform-origin: 50% 0%; }
        .puppy-note1 { animation: puppy-note 1.8s ease-out infinite; }
        .puppy-note2 { animation: puppy-note 1.8s ease-out 0.9s infinite; }
      `}</style>
      <svg
        viewBox="0 0 120 110"
        className={small ? "h-20 w-20" : "h-40 w-40"}
        role="img"
      >
        <g className="puppy-note1" style={{ transformOrigin: "14px 30px" }}>
          <text x="8" y="34" fontSize="13" fill="#a78bfa">♪</text>
        </g>
        <g className="puppy-note2" style={{ transformOrigin: "106px 26px" }}>
          <text x="100" y="30" fontSize="11" fill="#7dd3fc">♫</text>
        </g>

        <g className="puppy-body">
          {/* tail — wags fast */}
          <g className="puppy-tail">
            <path d="M25 74 Q12 66 10 54" stroke="#b9855c" strokeWidth="6" fill="none" strokeLinecap="round" />
          </g>

          {/* back legs */}
          <g className="puppy-leg-b" style={{ transformOrigin: "36px 84px" }}>
            <rect x="32" y="84" width="9" height="18" rx="4.5" fill="#a9744b" />
          </g>
          <g className="puppy-leg-a" style={{ transformOrigin: "58px 86px" }}>
            <rect x="54" y="86" width="9" height="17" rx="4.5" fill="#b9855c" />
          </g>

          {/* body */}
          <ellipse cx="52" cy="74" rx="30" ry="20" fill="#c89065" />
          {/* the breed's ridge — a darker stripe along the spine */}
          <path d="M28 62 Q52 52 78 66" stroke="#a9744b" strokeWidth="4" fill="none" strokeLinecap="round" />
          {/* belly */}
          <ellipse cx="52" cy="82" rx="20" ry="10" fill="#dbb289" />

          {/* front legs */}
          <g className="puppy-leg-a" style={{ transformOrigin: "70px 84px" }}>
            <rect x="66" y="84" width="9" height="18" rx="4.5" fill="#b9855c" />
          </g>
          <g className="puppy-leg-b" style={{ transformOrigin: "80px 82px" }}>
            <rect x="76" y="82" width="9" height="19" rx="4.5" fill="#c89065" />
          </g>

          {/* head */}
          <g>
            {/* floppy ears behind the head */}
            <g className="puppy-ear-l">
              <ellipse cx="60" cy="36" rx="8" ry="14" fill="#8f5b39" transform="rotate(18 60 36)" />
            </g>
            <g className="puppy-ear-r">
              <ellipse cx="90" cy="36" rx="8" ry="14" fill="#8f5b39" transform="rotate(-18 90 36)" />
            </g>
            <circle cx="75" cy="40" r="20" fill="#c89065" />
            {/* wrinkly puppy forehead */}
            <path d="M67 30 Q75 27 83 30" stroke="#a9744b" strokeWidth="1.6" fill="none" />
            <path d="M68 34 Q75 31.5 82 34" stroke="#a9744b" strokeWidth="1.4" fill="none" />
            {/* dark muzzle */}
            <ellipse cx="79" cy="49" rx="11" ry="8.5" fill="#6b4226" />
            <ellipse cx="80" cy="46" rx="4" ry="3" fill="#2d1b10" />
            {/* happy closed eyes */}
            <path d="M65 40 Q68 37 71 40" stroke="#2d1b10" strokeWidth="2" fill="none" strokeLinecap="round" />
            <path d="M84 39 Q87 36 90 39" stroke="#2d1b10" strokeWidth="2" fill="none" strokeLinecap="round" />
            {/* tongue */}
            <path d="M76 55 Q78 61 82 57 L81 53 Z" fill="#e6739f" />
          </g>
        </g>
      </svg>
      {caption && (
        <p className={`text-center text-neutral-400 ${small ? "text-[10px]" : "text-xs"}`}>
          {caption}
        </p>
      )}
    </div>
  );
}
