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

const FORBIDDEN: { re: RegExp; what: string; why: string }[] = [
  { re: /\binclude\s*</, what: "include", why: "library files are not available in the browser compiler" },
  { re: /\buse\s*</, what: "use", why: "library files are not available in the browser compiler" },
  { re: /\btext\s*\(/, what: "text()", why: "fonts are not available in the browser compiler" },
  { re: /\bimport\s*\(/, what: "import()", why: "external files are not available in the browser compiler" },
];

/** Pre-compile check for constructs that are guaranteed to fail in the bare wasm build. */
export function lintScad(source: string): ScadError[] {
  const errors: ScadError[] = [];
  blankNonCode(source)
    .split("\n")
    .forEach((lineText, i) => {
      for (const rule of FORBIDDEN) {
        if (rule.re.test(lineText)) {
          errors.push({
            line: i + 1,
            message: `Forbidden construct \`${rule.what}\` — ${rule.why}. Rewrite without it.`,
          });
        }
      }
    });
  return errors;
}
