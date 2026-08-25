import { strToU8, zipSync } from "three/examples/jsm/libs/fflate.module.js";

// The wasm build's native 3MF writer is broken (function signature mismatch
// in lib3mf), so — like the official OpenSCAD playground — we build the 3MF
// ourselves: it is a zip holding an OPC manifest and one XML mesh.

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/**
 * Per-object print settings embedded Bambu Studio-style. Bambu (and Orca)
 * read Metadata/model_settings.config on project import and apply these as
 * object overrides — the user's own printer/filament presets stay in
 * charge of everything else. Other slicers ignore the extra file.
 * Tuned for statue-style prints; keys are slicer config names.
 */
const OBJECT_PRINT_SETTINGS: Record<string, string> = {
  wall_loops: "4",
  sparse_infill_density: "15%",
  enable_support: "1",
  support_type: "tree(auto)",
  brim_type: "outer_only",
  brim_width: "5",
  seam_position: "back", // Bambu/Orca enum ("rear" is PrusaSlicer's word and gets rejected)
};

function modelSettingsConfig(title: string): string {
  const entries = Object.entries(OBJECT_PRINT_SETTINGS)
    .map(([k, v]) => `  <metadata key="${k}" value="${v}"/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="1">
  <metadata key="name" value="${title.replace(/[<>&"]/g, "")}"/>
${entries}
 </object>
</config>`;
}

/**
 * Convert a binary STL into a minimal single-object 3MF (millimeter units)
 * with Bambu-readable per-object print settings.
 * Vertices are deduplicated by exact coordinates — STL stores each triangle
 * independently, 3MF wants an indexed mesh.
 */
export function stlTo3mf(stl: ArrayBuffer, title: string): Uint8Array {
  const view = new DataView(stl);
  if (stl.byteLength < 84) throw new Error("Not a binary STL (too short)");
  const triangleCount = view.getUint32(80, true);
  if (stl.byteLength < 84 + triangleCount * 50) throw new Error("Truncated binary STL");

  const vertexIndex = new Map<string, number>();
  const vertices: string[] = [];
  const triangles: string[] = [];

  const indexOf = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let idx = vertexIndex.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      vertexIndex.set(key, idx);
      vertices.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
    }
    return idx;
  };

  for (let t = 0; t < triangleCount; t++) {
    const base = 84 + t * 50 + 12; // skip the facet normal
    const idx: number[] = [];
    for (let v = 0; v < 3; v++) {
      const off = base + v * 12;
      idx.push(
        indexOf(view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)),
      );
    }
    triangles.push(`<triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"/>`);
  }

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">${title.replace(/[<>&"]/g, "")}</metadata>
 <metadata name="Application">BambuStudio-01.00.00.00</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>${vertices.join("")}</vertices>
    <triangles>${triangles.join("")}</triangles>
   </mesh>
  </object>
 </resources>
 <build><item objectid="1"/></build>
</model>`;

  return zipSync(
    {
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      _rels: { ".rels": strToU8(RELS) },
      "3D": { "3dmodel.model": strToU8(model) },
      Metadata: { "model_settings.config": strToU8(modelSettingsConfig(title)) },
    },
    { level: 6 },
  );
}
