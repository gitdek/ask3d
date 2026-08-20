import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "three/examples/jsm/libs/fflate.module.js";
import { stlTo3mf } from "../threemf";

/** Build a binary STL with the given triangles (array of 3 vertices each). */
function makeStl(triangles: [number, number, number][][]): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((tri, t) => {
    const base = 84 + t * 50 + 12;
    tri.forEach(([x, y, z], v) => {
      view.setFloat32(base + v * 12, x, true);
      view.setFloat32(base + v * 12 + 4, y, true);
      view.setFloat32(base + v * 12 + 8, z, true);
    });
  });
  return buffer;
}

describe("stlTo3mf", () => {
  it("produces a valid zip with manifest, rels, and model", () => {
    const stl = makeStl([
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[0, 0, 0], [0, 10, 0], [0, 0, 10]],
    ]);
    const files = unzipSync(stlTo3mf(stl, "test"));
    const fileNames = Object.keys(files).filter((k) => !k.endsWith("/")).sort();
    expect(fileNames).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const model = strFromU8(files["3D/3dmodel.model"]);
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('<item objectid="1"/>');
  });

  it("deduplicates shared vertices", () => {
    // Two triangles sharing an edge: 6 STL corners but only 4 unique vertices.
    const stl = makeStl([
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[10, 0, 0], [10, 10, 0], [0, 10, 0]],
    ]);
    const model = strFromU8(unzipSync(stlTo3mf(stl, "t"))["3D/3dmodel.model"]);
    expect((model.match(/<vertex /g) ?? []).length).toBe(4);
    expect((model.match(/<triangle /g) ?? []).length).toBe(2);
  });

  it("rejects truncated input", () => {
    expect(() => stlTo3mf(new ArrayBuffer(10), "t")).toThrow(/too short/);
  });
});
