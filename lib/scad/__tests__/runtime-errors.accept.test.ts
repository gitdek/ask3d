import { describe, expect, it } from "vitest";
import { parseScadErrors, parseScadWarnings } from "../errors";

describe("OpenSCAD runtime error locations", () => {
  it("attributes an assertion without a final period", () => {
    const raw = "ERROR: Assertion '(x > 0)' failed in file input.scad, line 3";

    expect(parseScadErrors([raw], 1)).toEqual([
      {
        message: "Assertion '(x > 0)' failed",
        file: "input.scad",
        line: 3,
        raw,
      },
    ]);
  });

  it("attributes recursion with a final period", () => {
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

  it("preserves existing diagnostics alongside runtime locations", () => {
    const quoted = 'ERROR: Parser error in file "/input.scad", line 4: syntax error';
    const bare = "ERROR: Parser error: syntax error in file /input.scad, line 7";
    const quotedWithLocation =
      'ERROR: Parser error in file "/input.scad", line 5: unexpected token in file example.scad, line 8';
    const runtime = "ERROR: Unable to evaluate expression. in file /input.scad, line 21.";
    const generic = "ERROR: Compilation failed.";
    const trailingText = "ERROR: Evaluation failed in file input.scad, line 9: extra details";
    const invalidLine = "ERROR: Evaluation failed in file input.scad, line unknown";
    const missingLine = "ERROR: Evaluation failed in file input.scad";
    const warning = 'WARNING: variable "x" not defined, in file /input.scad, line 12.';
    const stderr = [
      quoted,
      bare,
      quotedWithLocation,
      runtime,
      generic,
      trailingText,
      invalidLine,
      missingLine,
      warning,
      "ECHO: diagnostic in file input.scad, line 99",
      "Geometries in cache: 3",
    ];

    expect(parseScadErrors(stderr, 1)).toEqual([
      { message: "syntax error", file: "/input.scad", line: 4, raw: quoted },
      { message: "syntax error", file: "/input.scad", line: 7, raw: bare },
      {
        message: "unexpected token in file example.scad, line 8",
        file: "/input.scad",
        line: 5,
        raw: quotedWithLocation,
      },
      {
        message: "Unable to evaluate expression.",
        file: "/input.scad",
        line: 21,
        raw: runtime,
      },
      { message: "Compilation failed.", raw: generic },
      { message: "Evaluation failed in file input.scad, line 9: extra details", raw: trailingText },
      { message: "Evaluation failed in file input.scad, line unknown", raw: invalidLine },
      { message: "Evaluation failed in file input.scad", raw: missingLine },
    ]);

    expect(parseScadWarnings(stderr)).toEqual([
      { message: 'variable "x" not defined', file: "/input.scad", line: 12, raw: warning },
    ]);
    expect(parseScadWarnings([runtime, generic, "WARNING: no location"])).toEqual([]);

    expect(parseScadErrors(["noise 0", "noise 1", "noise 2", "noise 3", "noise 4", "noise 5"], 137))
      .toEqual([
        {
          message: "OpenSCAD exited with code 137 — last output:\nnoise 1\nnoise 2\nnoise 3\nnoise 4\nnoise 5",
        },
      ]);
    expect(parseScadErrors([], 1)).toEqual([{ message: "OpenSCAD exited with code 1" }]);
    expect(parseScadErrors(["Compiler failed to start", "load failed"], null)).toEqual([
      { message: "Compiler failed to start\nload failed" },
    ]);
    expect(parseScadErrors([], null)).toEqual([
      { message: "The OpenSCAD compiler failed to start" },
    ]);
    expect(parseScadErrors(["Geometries in cache: 3"], 0)).toEqual([]);
  });
});
