const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;
const SCAD_TAGS = new Set(["openscad", "scad"]);

/**
 * Extract the last complete OpenSCAD code block from a markdown message.
 *
 * Preference order: last ```openscad / ```scad fence, then last bare ```
 * fence (the system prompt mandates the tag, so bare is a fallback for
 * models that drop it). Returns null when no fence exists or the message
 * ends in an unclosed fence (malformed / truncated output must not reach
 * the compiler).
 */
export function extractLastScadBlock(markdown: string): string | null {
  if ((markdown.match(/```/g) ?? []).length % 2 === 1) return null;

  const blocks: { lang: string; code: string }[] = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(markdown)) !== null) {
    blocks.push({ lang: m[1].trim().toLowerCase(), code: m[2] });
  }
  if (blocks.length === 0) return null;

  const tagged = blocks.filter((b) => SCAD_TAGS.has(b.lang));
  const chosen = tagged.length > 0 ? tagged[tagged.length - 1] : blocks[blocks.length - 1];
  const code = chosen.code.trim();
  return code.length > 0 ? code : null;
}
