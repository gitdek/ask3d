import type { ScadError } from "./types";

/**
 * Blank out comments and string literals while preserving line structure,
 * so forbidden-construct checks don't fire on `// text() is forbidden`.
 * One combined pass: whichever token opens first wins, so `//` inside a
 * string is string content and quotes inside a comment are comment content.
 */
function blankNonCode(source: string): string {
  return source.replace(
    /"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}

function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

// text() is allowed: DejaVu Sans is installed into the compiler's virtual FS.
const ALWAYS_FORBIDDEN: { re: RegExp; what: string; why: string }[] = [
  { re: /\binclude\s*</, what: "include", why: "library files are not available in the browser compiler" },
  { re: /\buse\s*</, what: "use", why: "library files are not available in the browser compiler" },
];

/**
 * Check a file-reading call (import/surface) against the uploaded-path
 * whitelist. `callRe` must capture the literal path; calls with no string
 * literal (variable paths) are counted via `bareRe` on the blanked source.
 */
function checkFileCalls(
  source: string,
  blanked: string,
  fn: "import" | "surface",
  pathRe: RegExp,
  allowedPaths: ReadonlySet<string>,
  errors: ScadError[],
): void {
  const bareRe = new RegExp(String.raw`\b${fn}\s*\(`, "g");
  const callCount = (blanked.match(bareRe) ?? []).length;
  if (callCount === 0) return;
  let literalCount = 0;
  for (const m of source.matchAll(pathRe)) {
    literalCount += 1;
    const path = m[1] ?? m[2];
    if (!allowedPaths.has(path)) {
      errors.push({
        line: lineOfIndex(source, m.index ?? 0),
        message:
          allowedPaths.size > 0
            ? `${fn}() may only reference an uploaded file (${[...allowedPaths].join(", ")}), not "${path}".`
            : `${fn}() is unavailable — no file has been uploaded to reference.`,
      });
    }
  }
  if (literalCount < callCount) {
    errors.push({
      message: `${fn}() must be called with a literal string path to an uploaded file.`,
    });
  }
}

/**
 * Pre-compile check for constructs that are guaranteed to fail in the bare
 * wasm build. `allowedPaths` are the virtual paths of user uploads (e.g.
 * "/uploads/model.stl") that import()/surface() may legally reference.
 */
export function lintScad(source: string, allowedPaths: readonly string[] = []): ScadError[] {
  const errors: ScadError[] = [];
  const blanked = blankNonCode(source);
  blanked.split("\n").forEach((lineText, i) => {
    for (const rule of ALWAYS_FORBIDDEN) {
      if (rule.re.test(lineText)) {
        errors.push({
          line: i + 1,
          message: `Forbidden construct \`${rule.what}\` — ${rule.why}. Rewrite without it.`,
        });
      }
    }
  });

  const allowed = new Set(allowedPaths);
  // Both OpenSCAD calling conventions: positional first argument or file=.
  checkFileCalls(
    source,
    blanked,
    "import",
    /\bimport\s*\(\s*(?:file\s*=\s*)?"([^"]*)"/g,
    allowed,
    errors,
  );
  checkFileCalls(
    source,
    blanked,
    "surface",
    /\bsurface\s*\(\s*(?:"([^"]*)"|[^)]*?file\s*=\s*"([^"]*)")/g,
    allowed,
    errors,
  );
  return errors;
}
