import { describe, expect, it } from "vitest";
import { extractLastScadBlock } from "../extract";

describe("extractLastScadBlock", () => {
  it("returns null when there is no fence", () => {
    expect(extractLastScadBlock("just some prose about cubes")).toBeNull();
  });

  it("extracts a single openscad fence", () => {
    const md = "Here you go:\n```openscad\ncube(10);\n```\nEnjoy!";
    expect(extractLastScadBlock(md)).toBe("cube(10);");
  });

  it("takes the last of multiple openscad fences", () => {
    const md = "```openscad\ncube(1);\n```\ntext\n```openscad\nsphere(2);\n```";
    expect(extractLastScadBlock(md)).toBe("sphere(2);");
  });

  it("accepts the scad tag", () => {
    const md = "```scad\ncylinder(h=5, d=3);\n```";
    expect(extractLastScadBlock(md)).toBe("cylinder(h=5, d=3);");
  });

  it("falls back to a bare fence when no tagged fence exists and content looks like scad", () => {
    const md = "```\ncube(10);\n```";
    expect(extractLastScadBlock(md)).toBe("cube(10);");
  });

  it("ignores bare fences whose content is not OpenSCAD", () => {
    const md = "Use these settings:\n```\nlayer height: 0.2\ninfill: 20%\n```";
    expect(extractLastScadBlock(md)).toBeNull();
  });

  it("ignores fences tagged with other languages", () => {
    const md = "```json\n{\"cube\": 10}\n```";
    expect(extractLastScadBlock(md)).toBeNull();
  });

  it("prefers a tagged fence over a later bare fence", () => {
    const md = "```openscad\ncube(1);\n```\n```\nnot scad\n```";
    expect(extractLastScadBlock(md)).toBe("cube(1);");
  });

  it("tolerates a stray mid-line ``` mention in prose before a valid fence", () => {
    const md = "I'll wrap the code in a ```openscad fence:\n\n```openscad\ncube(10);\n```\n";
    expect(extractLastScadBlock(md)).toBe("cube(10);");
  });

  it("unwraps a four-backtick quotation around an inner openscad fence", () => {
    const md = "````\n```openscad\ncube(7);\n```\n````";
    expect(extractLastScadBlock(md)).toBe("cube(7);");
  });

  it("returns null for an unclosed fence", () => {
    const md = "Working on it:\n```openscad\ncube(10);";
    expect(extractLastScadBlock(md)).toBeNull();
  });

  it("returns null when an unclosed fence follows a complete one", () => {
    const md = "```openscad\ncube(1);\n```\n```openscad\nsphere(";
    expect(extractLastScadBlock(md)).toBeNull();
  });

  it("returns null for an empty fence", () => {
    expect(extractLastScadBlock("```openscad\n\n```")).toBeNull();
  });

  it("handles a fence with trailing prose and language casing", () => {
    const md = "intro\n```OpenSCAD\ncube(3);\n```\nsome closing words";
    expect(extractLastScadBlock(md)).toBe("cube(3);");
  });
});

describe("fragment resistance", () => {
  it("ignores a tiny trailing fragment fence after the real program", () => {
    const real = "module a() { cube(10); }\na();\n" + "// filler\n".repeat(10);
    const md = "Here:\n```openscad\n" + real + "```\nleftover\n```openscad\n1\n```\n";
    expect(extractLastScadBlock(md)).toContain("module a()");
  });

  it("still honors last-wins between two substantial programs", () => {
    const a = "module a() { cube(10); }\na();\n// aaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
    const b = "module b() { sphere(5); }\nb();\n// bbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
    const md = "```openscad\n" + a + "```\ntext\n```openscad\n" + b + "```\n";
    expect(extractLastScadBlock(md)).toContain("module b()");
  });
});
