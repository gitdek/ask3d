/**
 * Connected-component analysis of a compiled binary STL.
 *
 * OpenSCAD's Manifold backend emits exact shared vertex coordinates within
 * a component, so exact-bit vertex matching + union-find over triangles
 * recovers the solid's separate pieces. Used to catch a silent failure
 * class: geometry that compiles cleanly but contains severed fragments
 * floating in the air (e.g. a "corner rounding" difference() that sliced
 * clean through the part) — those print as loose debris.
 */

export interface StlComponentReport {
  componentCount: number;
  /** Components whose inflated AABB touches no other component's AABB. */
  floatingCount: number;
  /** Floating components small enough to be severed debris, not a second
   *  intentional part (AABB volume < 25% of the largest component's). */
  debrisCount: number;
}

interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

function boxesTouch(a: Box, b: Box, tol: number): boolean {
  for (let i = 0; i < 3; i++) {
    if (a.max[i] + tol < b.min[i] || b.max[i] + tol < a.min[i]) return false;
  }
  return true;
}

function boxVolume(b: Box): number {
  return Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);
}

export function analyzeStlComponents(stl: ArrayBuffer, tolerance = 0.5): StlComponentReport {
  const view = new DataView(stl);
  if (stl.byteLength < 84) return { componentCount: 0, floatingCount: 0, debrisCount: 0 };
  const triangleCount = view.getUint32(80, true);
  if (stl.byteLength < 84 + triangleCount * 50 || triangleCount === 0) {
    return { componentCount: 0, floatingCount: 0, debrisCount: 0 };
  }

  // Vertex ids by exact float bits.
  const vertexIds = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const triVertexIds = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const off = base + v * 12;
      const key = `${view.getUint32(off, true)},${view.getUint32(off + 4, true)},${view.getUint32(off + 8, true)}`;
      let id = vertexIds.get(key);
      if (id === undefined) {
        id = parent.length;
        vertexIds.set(key, id);
        parent.push(id);
      }
      triVertexIds[t * 3 + v] = id;
    }
    union(triVertexIds[t * 3], triVertexIds[t * 3 + 1]);
    union(triVertexIds[t * 3], triVertexIds[t * 3 + 2]);
  }

  // AABB per component root.
  const boxes = new Map<number, Box>();
  for (let t = 0; t < triangleCount; t++) {
    const root = find(triVertexIds[t * 3]);
    let box = boxes.get(root);
    if (!box) {
      box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      boxes.set(root, box);
    }
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const off = base + v * 12;
      for (let i = 0; i < 3; i++) {
        const c = view.getFloat32(off + i * 4, true);
        if (c < box.min[i]) box.min[i] = c;
        if (c > box.max[i]) box.max[i] = c;
      }
    }
  }

  const all = [...boxes.values()];
  const largestVolume = Math.max(...all.map(boxVolume));
  let floatingCount = 0;
  let debrisCount = 0;
  for (let i = 0; i < all.length; i++) {
    const touchesAny = all.some((other, j) => j !== i && boxesTouch(all[i], other, tolerance));
    if (all.length > 1 && !touchesAny) {
      floatingCount++;
      if (boxVolume(all[i]) < 0.25 * largestVolume) debrisCount++;
    }
  }
  return { componentCount: all.length, floatingCount, debrisCount };
}
