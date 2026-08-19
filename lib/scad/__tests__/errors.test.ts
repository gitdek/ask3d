import { describe, expect, it } from "vitest";
import { parseScadErrors, parseScadWarnings } from "../errors";

describe("parseScadErrors", () => {
  it("parses a quoted parser error with file and line", () => {
    const errors = parseScadErrors(
      ['ERROR: Parser error in file "/input.scad", line 4: syntax error'],
      1,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "/input.scad", line: 4, message: "syntax error" });
  });

  it("parses the bare parser error variant", () => {
    const errors = parseScadErrors(
      ["ERROR: Parser error: syntax error in file /input.scad, line 7"],
      1,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ file: "/input.scad", line: 7, message: "syntax error" });
  });

  it("captures generic ERROR lines", () => {
    const errors = parseScadErrors(["ERROR: Compilation failed."], 1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("Compilation failed.");
    expect(errors[0].line).toBeUndefined();
  });

  it("collects multiple errors", () => {
    const errors = parseScadErrors(
      [
        'ERROR: Parser error in file "/input.scad", line 2: unexpected token',
        "ERROR: Compilation failed.",
      ],
      1,
    );
    expect(errors).toHaveLength(2);
  });

  it("falls back to a generic message on unparseable stderr with nonzero exit", () => {
    const errors = parseScadErrors(["something inscrutable", "more noise"], 137);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("exited with code 137");
    expect(errors[0].message).toContain("more noise");
  });

  it("returns nothing for clean output and zero exit", () => {
    expect(parseScadErrors(["Geometries in cache: 3"], 0)).toEqual([]);
  });
});

describe("parseScadWarnings", () => {
  it("parses a warning with file and line", () => {
    const warnings = parseScadWarnings([
      'WARNING: variable "x" not defined, in file /input.scad, line 12.',
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].line).toBe(12);
  });

  it("ignores non-warning lines", () => {
    expect(parseScadWarnings(["ERROR: nope", "info line"])).toEqual([]);
  });
});
