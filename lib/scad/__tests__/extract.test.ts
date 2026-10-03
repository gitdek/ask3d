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

describe("replies that forget the fence", () => {
  const PROGRAM = `// COLORS: white, midnight blue
$fn = 48;

module the_mesh() {
  import("/uploads/statue.stl");
}

module mask_eyes() {
  translate([-12.5, -17, 50]) sphere(r = 5.2);
  translate([12.5, -17, 50]) sphere(r = 5.2);
}

module color_part_1() {
  intersection() { the_mesh(); mask_eyes(); }
}

module color_part_2() {
  difference() { the_mesh(); mask_eyes(); }
}

color_part_1();
color_part_2();`;

  it("takes an unfenced reply that is entirely a program", () => {
    // Observed: a complete, correct colour program arrived with no fence and
    // was silently discarded, so the app looked like it had done nothing.
    const code = extractLastScadBlock(PROGRAM);
    expect(code).not.toBeNull();
    expect(code).toContain("// COLORS: white, midnight blue");
    expect(code).toContain("color_part_2();");
  });

  it("still refuses prose that merely mentions OpenSCAD", () => {
    const prose = `I can do that for you. The usual approach is to call difference()
with the body first and the holes after it, then union() the lettering on top.
Each module should be watertight before you combine them, and a cylinder()
with a low $fn will look faceted. Tell me which diameter you want and I will
write the program for you in the next message.`;
    expect(extractLastScadBlock(prose)).toBeNull();
  });

  it("refuses an unfenced reply with no module definition", () => {
    expect(extractLastScadBlock("cube([10,10,10]);\ntranslate([1,2,3]);")).toBeNull();
  });

  it("takes a fence the model tagged with the wrong language", () => {
    const md = "Here you go:\n\n```cpp\n" + PROGRAM + "\n```\n";
    expect(extractLastScadBlock(md)).toContain("color_part_1()");
  });

  it("does not treat a tagged non-OpenSCAD fence as code", () => {
    const md = "Slicer settings:\n\n```json\n{ \"layer_height\": 0.2 }\n```\n";
    expect(extractLastScadBlock(md)).toBeNull();
  });
});
