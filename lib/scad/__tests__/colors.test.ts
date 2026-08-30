import { describe, expect, it } from "vitest";
import { colorPartSource, colorToHex, parseColorPlan } from "../colors";

const VALID = `// COLORS: midnight blue, gold
module color_part_1() { cube(10); }
module color_part_2() { translate([0,0,10]) cube(2); }
color_part_1();
color_part_2();`;

describe("parseColorPlan", () => {
  it("parses a well-formed plan", () => {
    expect(parseColorPlan(VALID)).toEqual(["midnight blue", "gold"]);
  });

  it("returns null without the COLORS comment", () => {
    expect(parseColorPlan("cube(10);")).toBeNull();
  });

  it("returns null when a declared color lacks its module", () => {
    expect(parseColorPlan("// COLORS: red, blue\nmodule color_part_1() {}")).toBeNull();
  });

  it("rejects single-color and >4-color plans", () => {
    expect(parseColorPlan("// COLORS: red\nmodule color_part_1() {}")).toBeNull();
    const five = "// COLORS: a, b, c, d, e\n" +
      [1, 2, 3, 4, 5].map((i) => `module color_part_${i}() {}`).join("\n");
    expect(parseColorPlan(five)).toBeNull();
  });
});

describe("colorPartSource", () => {
  it("appends a root-modifier instantiation", () => {
    expect(colorPartSource(VALID, 2)).toContain("\n!color_part_2();");
  });
});

describe("colorToHex", () => {
  it("maps known names and compound names", () => {
    expect(colorToHex("gold")).toBe("#D4A017");
    expect(colorToHex("Midnight Blue")).toBe("#1B2A4A");
    expect(colorToHex("silk gold")).toBe("#D4A017");
    expect(colorToHex("chartreuse")).toBe("#999999");
  });
});
