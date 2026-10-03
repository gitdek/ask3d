import { describe, expect, it } from "vitest";
import { computeViewAxes, describeAxes } from "../mesh-views";

// The statue that failed to colour: centred in X/Y, floored at Z=0.
const BOX = {
  min: { x: -40, y: -33.73, z: 0 },
  max: { x: 40, y: 33.73, z: 69.97 },
};

/**
 * Project a world point through the same camera the renderer uses, built
 * here independently, and return its normalized device coords.
 */
async function project(spec: { at: [number, number, number] }, p: { x: number; y: number; z: number }) {
  const THREE = await import("three");
  const centre = {
    x: (BOX.min.x + BOX.max.x) / 2,
    y: (BOX.min.y + BOX.max.y) / 2,
    z: (BOX.min.z + BOX.max.z) / 2,
  };
  const span = Math.max(BOX.max.x - BOX.min.x, BOX.max.y - BOX.min.y, BOX.max.z - BOX.min.z);
  const half = (span / 2) * 1.08;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, span * 10);
  camera.up.set(0, 0, 1);
  camera.position.set(
    centre.x + spec.at[0] * span * 3,
    centre.y + spec.at[1] * span * 3,
    centre.z + spec.at[2] * span * 3,
  );
  camera.lookAt(centre.x, centre.y, centre.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new THREE.Vector3(p.x, p.y, p.z).project(camera);
}

describe("computeViewAxes", () => {
  it("labels each axis the way the geometry actually projects", async () => {
    // The whole point: a mirrored label would teach the model a frame in
    // which every mask it writes lands on the wrong side of the model.
    const specs = await computeViewAxes(BOX);
    expect(specs).toHaveLength(2);

    for (const spec of specs) {
      const centre = { x: 0, y: 0, z: (BOX.min.z + BOX.max.z) / 2 };

      const leftEnd = await project(spec, { ...centre, [spec.horiz.name]: spec.horiz.from });
      const rightEnd = await project(spec, { ...centre, [spec.horiz.name]: spec.horiz.to });
      expect(leftEnd.x).toBeLessThan(rightEnd.x);

      const bottomEnd = await project(spec, { ...centre, [spec.vert.name]: spec.vert.from });
      const topEnd = await project(spec, { ...centre, [spec.vert.name]: spec.vert.to });
      expect(bottomEnd.y).toBeLessThan(topEnd.y);
    }
  });

  it("covers the full extent of each axis it names", async () => {
    const specs = await computeViewAxes(BOX);
    for (const spec of specs) {
      for (const axis of [spec.horiz, spec.vert]) {
        expect(Math.min(axis.from, axis.to)).toBeCloseTo(BOX.min[axis.name], 5);
        expect(Math.max(axis.from, axis.to)).toBeCloseTo(BOX.max[axis.name], 5);
      }
    }
  });

  it("shows one view per horizontal axis, both upright in Z", async () => {
    const specs = await computeViewAxes(BOX);
    expect(specs.map((s) => s.horiz.name).sort()).toEqual(["x", "y"]);
    expect(specs.every((s) => s.vert.name === "z")).toBe(true);
  });

  it("writes a legend naming real millimetres", async () => {
    const legend = describeAxes(await computeViewAxes(BOX));
    // Direction, not just presence: a mirrored legend is the failure mode.
    expect(legend).toContain("front view: x runs -40 (left) to 40 (right)");
    expect(legend).toContain("side view: y runs -34 (left) to 34 (right)");
    expect(legend).toContain("z runs 0 (bottom) to 70 (top)");
  });
});
