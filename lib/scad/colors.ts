/**
 * Multi-color convention between the chat model and the app.
 *
 * When the user asks for colors, the model structures its program as
 * top-level modules color_part_1() … color_part_N() (all instantiated, so
 * the normal compile is their union) and declares the palette on the first
 * line: `// COLORS: midnight blue, gold`. The app then re-renders each part
 * alone (OpenSCAD's `!` root modifier) and packages a multi-object 3MF the
 * AMS can map to filament slots.
 */

export function parseColorPlan(source: string): string[] | null {
  const match = source.match(/^\s*\/\/\s*COLORS:\s*(.+)$/m);
  if (!match) return null;
  const names = match[1]
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length < 2 || names.length > 4) return null;
  // Every declared color must have its module, or the plan is bogus.
  for (let i = 1; i <= names.length; i++) {
    if (!new RegExp(`module\\s+color_part_${i}\\s*\\(`).test(source)) return null;
  }
  return names;
}

/** Render only part k (1-based) of a color-structured program. */
export function colorPartSource(source: string, k: number): string {
  return `${source}\n!color_part_${k}();\n`;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#1A1A1A",
  white: "#F5F2EB",
  gray: "#8A8A8A",
  grey: "#8A8A8A",
  silver: "#C0C0C8",
  gold: "#D4A017",
  copper: "#B87333",
  bronze: "#9C7A3C",
  red: "#C0272D",
  orange: "#E8641B",
  yellow: "#F2C230",
  green: "#2E7D4F",
  teal: "#1F8A8A",
  blue: "#2455A4",
  "midnight blue": "#1B2A4A",
  navy: "#1B2A4A",
  purple: "#6A3FA0",
  pink: "#E86BA0",
  brown: "#6B4A2F",
};

export function colorToHex(name: string): string {
  const n = name.toLowerCase();
  if (NAMED_COLORS[n]) return NAMED_COLORS[n];
  // Fall back to any single word we know inside a compound name.
  for (const word of n.split(/\s+/)) {
    if (NAMED_COLORS[word]) return NAMED_COLORS[word];
  }
  return "#999999";
}
