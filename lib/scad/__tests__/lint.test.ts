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

  it("rejects import() when nothing is uploaded", () => {
    const errors = lintScad('import("model.stl");');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("no file has been uploaded");
  });

  it("allows import() of an uploaded path", () => {
    expect(lintScad('import("/uploads/dog.stl");', ["/uploads/dog.stl"])).toEqual([]);
  });

  it("rejects import() of a non-uploaded path even when uploads exist", () => {
    const errors = lintScad('import("/etc/passwd");', ["/uploads/dog.stl"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("/uploads/dog.stl");
  });

  it("rejects import() with a variable path", () => {
    const errors = lintScad("p = 1; import(p);", ["/uploads/dog.stl"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("literal string");
  });

  it("allows surface() of an uploaded heightmap and rejects others", () => {
    expect(
      lintScad('surface(file = "/uploads/turing.dat", center = true);', ["/uploads/turing.dat"]),
    ).toEqual([]);
    expect(lintScad('surface(file = "other.dat");')).toHaveLength(1);
  });

  it("ignores import() mentioned in comments", () => {
    expect(lintScad('// import("x.stl") would fail\ncube(1);')).toEqual([]);
  });

  it("does not flag comments", () => {
    expect(lintScad("// text() is forbidden here\ncube(1);")).toEqual([]);
    expect(lintScad("/* use <lib> would fail */\ncube(1);")).toEqual([]);
  });

  it("does not flag string literals", () => {
    expect(lintScad('echo("call text( for fun");\ncube(1);')).toEqual([]);
  });

  it("does not treat // inside a string as a comment", () => {
    expect(lintScad('msg = "please use <caution> // fragile";\ncube(1);')).toEqual([]);
  });

  it("still flags forbidden calls after a string containing //", () => {
    const errors = lintScad('url = "https://x"; text("hi");');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("text()");
  });

  it("does not flag identifiers containing forbidden names", () => {
    expect(lintScad("context(1);\nmy_text_size = 4;\nreused = 2;")).toEqual([]);
  });

  it("reports the correct line number", () => {
    const errors = lintScad("cube(1);\nsphere(2);\ntext(\"x\");");
    expect(errors[0].line).toBe(3);
  });
});
