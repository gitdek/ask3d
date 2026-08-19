import { describe, expect, it } from "vitest";
import { lintScad } from "../lint";

describe("lintScad", () => {
  it("passes clean code", () => {
    expect(lintScad("$fn = 48;\ncube(10);")).toEqual([]);
  });

  it("detects include", () => {
    const errors = lintScad("include <BOSL2/std.scad>\ncube(1);");
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
    expect(errors[0].message).toContain("include");
  });

  it("detects use", () => {
    expect(lintScad("use <MCAD/gears.scad>")).toHaveLength(1);
  });

  it("detects text()", () => {
    const errors = lintScad("linear_extrude(2) text(\"hi\");");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("text()");
  });

  it("detects import()", () => {
    expect(lintScad("import(\"model.stl\");")).toHaveLength(1);
  });

  it("does not flag comments", () => {
    expect(lintScad("// text() is forbidden here\ncube(1);")).toEqual([]);
    expect(lintScad("/* use <lib> would fail */\ncube(1);")).toEqual([]);
  });

  it("does not flag string literals", () => {
    expect(lintScad('echo("call text( for fun");\ncube(1);')).toEqual([]);
  });

  it("does not flag identifiers containing forbidden names", () => {
    expect(lintScad("context(1);\nmy_text_size = 4;\nreused = 2;")).toEqual([]);
  });

  it("reports the correct line number", () => {
    const errors = lintScad("cube(1);\nsphere(2);\ntext(\"x\");");
    expect(errors[0].line).toBe(3);
  });
});
