// The checked snapshot contains use-auto-repair.ts, but not these three
// imported utilities. These doubles cover only the driver's input domain;
// none implements repair, staleness, deduplication, or counter behavior.

export function extractLastScadBlock(reply: string): string | null {
  let source: string | null = null;
  for (const match of reply.matchAll(/```(?:scad|openscad)[ \t]*\n([\s\S]*?)```/g)) source = match[1].trim() || null;
  return source;
}

export function buildRepairMessage(lines: string[], stderr: string[]): string {
  // The hook only forwards this string to sendRepair; its wording does not
  // participate in any modeled decision.
  return ["Repair the program:", ...lines, ...stderr].join("\n");
}

export function analyzeStlComponents(stl: ArrayBuffer): { componentCount: number; debrisCount: number } {
  // Classify the supplied closed cube and optional small floating tetrahedron
  // from their bytes, without consulting the generator's signal label.
  const view = new DataView(stl);
  const count = view.getUint32(80, true);
  if (stl.byteLength !== 84 + count * 50) throw new Error("Invalid fixture STL");
  const parent = Array.from({ length: count }, (_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const vertexOwners = new Map<string, number>();
  const minZ = Array<number>(count).fill(Infinity);
  for (let triangle = 0; triangle < count; triangle++) for (let vertex = 0; vertex < 3; vertex++) {
    const offset = 84 + triangle * 50 + 12 + vertex * 12;
    const point = [0, 4, 8].map(axis => view.getFloat32(offset + axis, true));
    minZ[triangle] = Math.min(minZ[triangle], point[2]);
    const key = point.join(",");
    const owner = vertexOwners.get(key);
    if (owner === undefined) vertexOwners.set(key, triangle);
    else parent[root(triangle)] = root(owner);
  }
  const components = new Map<number, { triangles: number; minZ: number }>();
  for (let i = 0; i < count; i++) {
    const id = root(i);
    const component = components.get(id) ?? { triangles: 0, minZ: Infinity };
    component.triangles++;
    component.minZ = Math.min(component.minZ, minZ[i]);
    components.set(id, component);
  }
  return {
    componentCount: components.size,
    debrisCount: [...components.values()].filter(c => c.minZ > 0.2 && c.triangles < count * 0.1).length,
  };
}
