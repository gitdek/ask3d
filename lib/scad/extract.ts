const SCAD_TAGS = new Set(["openscad", "scad"]);

// Untagged fences are only trusted when the content plausibly is OpenSCAD —
// otherwise a fenced list of slicer settings would be sent to the compiler.
const SCAD_HINT =
  /\b(module|cube|cylinder|sphere|polygon|polyhedron|difference|union|intersection|translate|rotate|mirror|scale|linear_extrude|rotate_extrude|circle|square|hull|minkowski|offset)\s*\(|\$f[nas]\s*=/;

interface FencedBlock {
  lang: string;
  code: string;
}

/**
 * Line-anchored CommonMark-style fence scan: an opener is a line starting
 * with 3+ backticks (plus an info string); a closer is a backtick-only line
 * with at least as many ticks. Mid-line ``` in prose is ignored, and a
 * ````-wrapped quotation of a ```openscad block pairs correctly. Returns
 * null when a fence is still open at end of input (truncated output).
 */
function scanFences(markdown: string): FencedBlock[] | null {
  const blocks: FencedBlock[] = [];
  let open: { ticks: number; lang: string; body: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    if (open) {
      const closer = line.match(/^(`{3,})\s*$/);
      if (closer && closer[1].length >= open.ticks) {
        blocks.push({ lang: open.lang, code: open.body.join("\n") });
        open = null;
      } else {
        open.body.push(line);
      }
    } else {
      const opener = line.match(/^(`{3,})([^`]*)$/);
      if (opener) {
        open = { ticks: opener[1].length, lang: opener[2].trim().toLowerCase(), body: [] };
      }
    }
  }
  return open ? null : blocks;
}

/**
 * Extract the last complete OpenSCAD code block from a markdown message.
 *
 * Preference order: last ```openscad / ```scad fence, then the last bare
 * fence whose content looks like OpenSCAD (the system prompt mandates the
 * tag, so bare is a fallback for models that drop it). Returns null when no
 * usable fence exists or the message ends in an unclosed fence (malformed /
 * truncated output must not reach the compiler).
 */
export function extractLastScadBlock(markdown: string): string | null {
  const blocks = scanFences(markdown);
  if (blocks === null) return null;
  // No fences at all: a model that forgets them emits the program as prose,
  // and throwing a complete, correct program away looks to the user like
  // nothing happened at all.
  if (blocks.length === 0) return wholeMessageAsProgram(markdown);

  const tagged = blocks.filter((b) => SCAD_TAGS.has(b.lang));
  if (tagged.length > 0) {
    // A mangled reply can shed tiny fragment fences after the real program
    // (observed: a trailing block containing just "1"). Ignore tagged
    // blocks that are dwarfed by the largest one, then keep last-wins.
    const longest = Math.max(...tagged.map((b) => b.code.trim().length));
    const solid = tagged.filter(
      (b) => b.code.trim().length >= Math.max(40, longest * 0.25),
    );
    const pick = solid.length > 0 ? solid[solid.length - 1] : tagged[tagged.length - 1];
    const code = pick.code.trim();
    return code.length > 0 ? code : null;
  }

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    // Any info string is acceptable when the content is plainly OpenSCAD:
    // models reach for ```cpp and ```c more often than for no tag at all.
    if (block.lang !== "" && !SCAD_HINT.test(block.code)) continue;
    if (block.code.includes("```")) {
      // A quotation wrapper (e.g. ````) around an inner fenced block.
      const nested = extractLastScadBlock(block.code);
      if (nested) return nested;
      continue;
    }
    const code = block.code.trim();
    if (code.length > 0 && SCAD_HINT.test(code)) return code;
  }
  return null;
}

/**
 * Accept an unfenced reply that is, in its entirety, a program.
 *
 * Deliberately strict: a program is nearly all statements, braces and `//`
 * comments, while an explanation that happens to mention difference() is
 * mostly sentences. Requiring both a module definition and a high ratio of
 * code-shaped lines keeps prose away from the compiler, which is the whole
 * reason untagged content was distrusted in the first place.
 */
function wholeMessageAsProgram(markdown: string): string | null {
  const code = markdown.trim();
  if (!code || !SCAD_HINT.test(code)) return null;
  if (!/^[ \t]*module\s+\w+\s*\(/m.test(code)) return null;

  const lines = code.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 4) return null;
  const codeShaped = lines.filter((line) => {
    const text = line.trim();
    return text.startsWith("//") || /[;{}]\s*$/.test(text) || /^[})\]];?$/.test(text);
  }).length;
  return codeShaped / lines.length >= 0.85 ? code : null;
}
