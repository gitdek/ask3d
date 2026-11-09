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

  it("parses an assertion error with file and line", () => {
    const raw = "ERROR: Assertion '(height > 0)' failed in file input.scad, line 3";
    expect(parseScadErrors([raw], 1)).toEqual([
      { message: "Assertion '(height > 0)' failed", file: "input.scad", line: 3, raw },
    ]);
  });

  it("parses a recursion error with a final period", () => {
    const raw = "ERROR: Recursion detected calling function 'f' in file /input.scad, line 12.";
    expect(parseScadErrors([raw], 1)).toEqual([
      {
        message: "Recursion detected calling function 'f'",
        file: "/input.scad",
        line: 12,
        raw,
      },
    ]);
  });

  it("extracts the final runtime location while preserving the message", () => {
    const raw = "ERROR: Evaluation failed in file helper.scad. in file /models/my part.scad, line 21.";
    expect(parseScadErrors([raw], 1)).toEqual([
      {
        message: "Evaluation failed in file helper.scad.",
        file: "/models/my part.scad",
        line: 21,
        raw,
      },
    ]);
  });

  it("captures generic ERROR lines", () => {
    const errors = parseScadErrors(["ERROR: Compilation failed."], 1);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("Compilation failed.");
    expect(errors[0].line).toBeUndefined();
  });

  it("keeps incomplete or nonterminal runtime locations generic", () => {
    expect(parseScadErrors([
      "ERROR: Evaluation failed in file input.scad",
      "ERROR: Evaluation failed in file input.scad, line unknown",
      "ERROR: Evaluation failed in file input.scad, line 9: extra details",
      "ERROR: Evaluation failed in file input.scad, line 9.5",
    ], 1)).toEqual([
      {
        message: "Evaluation failed in file input.scad",
        raw: "ERROR: Evaluation failed in file input.scad",
      },
      {
        message: "Evaluation failed in file input.scad, line unknown",
        raw: "ERROR: Evaluation failed in file input.scad, line unknown",
      },
      {
        message: "Evaluation failed in file input.scad, line 9: extra details",
        raw: "ERROR: Evaluation failed in file input.scad, line 9: extra details",
      },
      {
        message: "Evaluation failed in file input.scad, line 9.5",
        raw: "ERROR: Evaluation failed in file input.scad, line 9.5",
      },
    ]);
  });

  it("collects errors in order with parser errors taking precedence", () => {
    const quoted = 'ERROR: Parser error in file "/input.scad", line 2: unexpected token in file helper.scad, line 8';
    const runtime = "ERROR: Unable to evaluate expression. in file input.scad, line 21";
    const bare = "ERROR: Parser error: syntax error in file /input.scad, line 7";
    const generic = "ERROR: Compilation failed.";
    expect(parseScadErrors([
      quoted,
      "WARNING: variable x not defined, in file input.scad, line 12.",
      runtime,
      "ECHO: diagnostic in file input.scad, line 99",
      bare,
      generic,
    ], 1)).toEqual([
      {
        message: "unexpected token in file helper.scad, line 8",
        file: "/input.scad",
        line: 2,
        raw: quoted,
      },
      { message: "Unable to evaluate expression.", file: "input.scad", line: 21, raw: runtime },
      { message: "syntax error", file: "/input.scad", line: 7, raw: bare },
      { message: "Compilation failed.", raw: generic },
    ]);
  });

  it("falls back to a generic message on unparseable stderr with nonzero exit", () => {
    const errors = parseScadErrors(["something inscrutable", "more noise"], 137);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("exited with code 137");
    expect(errors[0].message).toContain("more noise");
  });

  it("includes only the last five lines in fallback messages", () => {
    const stderr = ["noise 0", "noise 1", "noise 2", "noise 3", "noise 4", "noise 5"];
    const tail = "noise 1\nnoise 2\nnoise 3\nnoise 4\nnoise 5";
    expect(parseScadErrors(stderr, 137)).toEqual([
      { message: `OpenSCAD exited with code 137 — last output:\n${tail}` },
    ]);
    expect(parseScadErrors(stderr, null)).toEqual([{ message: tail }]);
  });

  it("reports a nonzero exit with empty stderr", () => {
    expect(parseScadErrors([], 1)).toEqual([{ message: "OpenSCAD exited with code 1" }]);
  });

  it("returns nothing for clean output and zero exit", () => {
    expect(parseScadErrors(["Geometries in cache: 3"], 0)).toEqual([]);
  });

  it("surfaces startup failures (null exit code) via the stderr tail", () => {
    const errors = parseScadErrors(
      ["Compiler failed to start: Failed to fetch dynamically imported module"],
      null,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Compiler failed to start");
  });

  it("gives a generic startup message when stderr is empty and exit is null", () => {
    const errors = parseScadErrors([], null);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("failed to start");
  });
});

describe("parseScadWarnings", () => {
  it("parses a warning with file and line", () => {
    const raw = 'WARNING: variable "x" not defined, in file /input.scad, line 12.';
    expect(parseScadWarnings([raw])).toEqual([
      { message: 'variable "x" not defined', file: "/input.scad", line: 12, raw },
    ]);
  });

  it("ignores non-warning lines and warnings without a location", () => {
    expect(parseScadWarnings([
      "ERROR: nope",
      "ERROR: Evaluation failed in file input.scad, line 3.",
      "info line",
      "WARNING: no location",
    ])).toEqual([]);
  });
});
