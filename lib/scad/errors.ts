import type { ScadError } from "./types";

// Known OpenSCAD stderr shapes (from the official playground's parser).
const PARSER_ERROR_QUOTED = /^ERROR: Parser error in file "([^"]+)", line (\d+): (.*)$/;
const PARSER_ERROR_BARE = /^ERROR: Parser error: (.*?) in file ([^",]+), line (\d+)$/;
const GENERIC_ERROR = /^ERROR: (.*)$/;
const WARNING = /^WARNING: (.*?),? in file ([^,]+), line (\d+)\.?/;

/** Parse OpenSCAD stderr lines into structured errors. */
export function parseScadErrors(stderr: string[], exitCode: number | null): ScadError[] {
  const errors: ScadError[] = [];
  for (const raw of stderr) {
    let m = raw.match(PARSER_ERROR_QUOTED);
    if (m) {
      errors.push({ file: m[1], line: Number(m[2]), message: m[3], raw });
      continue;
    }
    m = raw.match(PARSER_ERROR_BARE);
    if (m) {
      errors.push({ message: m[1], file: m[2], line: Number(m[3]), raw });
      continue;
    }
    m = raw.match(GENERIC_ERROR);
    if (m) {
      errors.push({ message: m[1], raw });
    }
  }
  if (errors.length === 0 && exitCode !== null && exitCode !== 0) {
    const tail = stderr.slice(-5).join("\n");
    errors.push({
      message: `OpenSCAD exited with code ${exitCode}${tail ? ` — last output:\n${tail}` : ""}`,
    });
  }
  return errors;
}

/** Parse OpenSCAD stderr lines into structured warnings (line-attributed only). */
export function parseScadWarnings(stderr: string[]): ScadError[] {
  const warnings: ScadError[] = [];
  for (const raw of stderr) {
    const m = raw.match(WARNING);
    if (m) warnings.push({ message: m[1], file: m[2], line: Number(m[3]), raw });
  }
  return warnings;
}
