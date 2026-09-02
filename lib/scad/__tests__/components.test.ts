import { describe, expect, it } from "vitest";
import { analyzeStlComponents } from "../components";

type Tri = [number[], number[], number[]];

function stlOf(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  tris.forEach((tri, t) => {
    const base = 84 + t * 50 + 12;
    tri.forEach((v, i) => {
      view.setFloat32(base + i * 12, v[0], true);
      view.setFloat32(base + i * 12 + 4, v[1], true);
      view.setFloat32(base + i * 12 + 8, v[2], true);
    });
  });
  return buf;
}

/** A tetrahedron (closed 3D solid, like real Manifold output) at offset/scale. */
function tet(ox: number, oy: number, oz: number, s = 1): Tri[] {
  const a = [ox, oy, oz];
  const b = [ox + s, oy, oz];
  const c = [ox, oy + s, oz];
  const d = [ox, oy, oz + s];
  return [
    [a, b, c],
    [a, b, d],
    [a, c, d],
    [b, c, d],
  ];
}

describe("analyzeStlComponents", () => {
  it("sees one connected component in a single solid", () => {
    const r = analyzeStlComponents(stlOf(tet(0, 0, 0)));
    expect(r).toEqual({ componentCount: 1, floatingCount: 0, debrisCount: 0 });
  });

  it("flags a tiny far-away fragment as floating debris", () => {
    const r = analyzeStlComponents(stlOf([...tet(0, 0, 0, 20), ...tet(100, 100, 100, 0.5)]));
    expect(r.componentCount).toBe(2);
    expect(r.floatingCount).toBe(1); // the big one stands on the plate
    expect(r.debrisCount).toBe(1); // only the small one is debris
  });

  it("does not call a small separate part debris when it stands on the plate", () => {
    // e.g. a phone stand plus its little cable clip printed alongside
    const r = analyzeStlComponents(stlOf([...tet(0, 0, 0, 20), ...tet(60, 0, 0, 0.5)]));
    expect(r.componentCount).toBe(2);
    expect(r.floatingCount).toBe(0);
    expect(r.debrisCount).toBe(0);
  });

  it("measures plate level from the model, not from Z=0", () => {
    const r = analyzeStlComponents(stlOf([...tet(0, 0, 5, 20), ...tet(60, 0, 5, 0.5)]));
    expect(r.debrisCount).toBe(0);
    const lifted = analyzeStlComponents(stlOf([...tet(0, 0, 5, 20), ...tet(60, 0, 40, 0.5)]));
    expect(lifted.debrisCount).toBe(1);
  });

  it("does not call similar-sized separated parts debris (intentional multi-part)", () => {
    const r = analyzeStlComponents(stlOf([...tet(0, 0, 0, 10), ...tet(50, 0, 0, 10)]));
    expect(r.componentCount).toBe(2);
    expect(r.debrisCount).toBe(0);
  });

  it("does not flag separate shells whose boxes touch (e.g. statue + base)", () => {
    const r = analyzeStlComponents(stlOf([...tet(0, 0, 0, 10), ...tet(2, 2, 0.2, 0.5)]));
    expect(r.componentCount).toBe(2);
    expect(r.floatingCount).toBe(0);
    expect(r.debrisCount).toBe(0);
  });

  it("handles empty and malformed buffers", () => {
    expect(analyzeStlComponents(new ArrayBuffer(10)).componentCount).toBe(0);
    expect(analyzeStlComponents(stlOf([])).componentCount).toBe(0);
  });
});
