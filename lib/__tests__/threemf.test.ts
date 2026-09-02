import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "three/examples/jsm/libs/fflate.module.js";
import { stlTo3mf, stlTo3mfMulti } from "../threemf";

/** One-triangle binary STL. */
function tinyStl(): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50);
  const view = new DataView(buf);
  view.setUint32(80, 1, true);
  const base = 84 + 12;
  const verts = [0, 0, 0, 10, 0, 0, 0, 10, 0];
  verts.forEach((v, i) => view.setFloat32(base + i * 4, v, true));
  return buf;
}

describe("stlTo3mf", () => {
  const files = unzipSync(stlTo3mf(tinyStl(), "test <model>"));

  it("packs the OPC manifest, model, and Bambu settings", () => {
    expect(Object.keys(files).filter((k) => !k.endsWith("/")).sort()).toEqual([
      "3D/3dmodel.model",
      "Metadata/model_settings.config",
      "Metadata/project_settings.config",
      "[Content_Types].xml",
      "_rels/.rels",
    ]);
    // The gate in Bambu's Plater.cpp accepts configs naming a Bambu printer.
    expect(strFromU8(files["Metadata/project_settings.config"])).toContain(
      '"printer_model": "Bambu Lab A1"',
    );
  });

  it("writes an indexed mesh with the title sanitized", () => {
    const model = strFromU8(files["3D/3dmodel.model"]);
    expect(model).toContain('<vertex x="0" y="0" z="0"/>');
    expect(model).toContain('<triangle v1="0" v2="1" v3="2"/>');
    expect(model).toContain("<metadata name=\"Title\">test model</metadata>");
    expect(model).toContain("BambuStudio");
  });

  it("accepts ASCII STL too (library restores hand back user uploads verbatim)", () => {
    const ascii =
      "solid tri\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 10 0 0\n" +
      "   vertex 0 10 0\n  endloop\n endfacet\nendsolid tri\n";
    const bytes = new TextEncoder().encode(ascii);
    const out = unzipSync(stlTo3mf(bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, "ascii"));
    const model = strFromU8(out["3D/3dmodel.model"]);
    expect(model).toContain('<vertex x="10" y="0" z="0"/>');
    expect(model).toContain('<triangle v1="0" v2="1" v3="2"/>');
  });

  it("exports one object per color with materials and extruder mapping", () => {
    const multi = unzipSync(
      stlTo3mfMulti(
        [
          { name: "midnight blue", hex: "#1B2A4A", stl: tinyStl() },
          { name: "gold", hex: "#D4A017", stl: tinyStl() },
        ],
        "plaque",
      ),
    );
    const model = strFromU8(multi["3D/3dmodel.model"]);
    expect(model).toContain('<basematerials id="100">');
    expect(model).toContain('displaycolor="#D4A017FF"');
    expect(model).toContain('<object id="1" type="model" pid="100" pindex="0">');
    expect(model).toContain('<object id="2" type="model" pid="100" pindex="1">');
    expect(model).toContain('<item objectid="2"/>');
    const config = strFromU8(multi["Metadata/model_settings.config"]);
    expect(config).toContain('<object id="1">');
    expect(config).toContain('<metadata key="extruder" value="1"/>');
    expect(config).toContain('<object id="2">');
    expect(config).toContain('<metadata key="extruder" value="2"/>');
    expect(config).toContain('<metadata key="name" value="gold"/>');
  });

  it("embeds per-object print settings keyed to the model object", () => {
    const config = strFromU8(files["Metadata/model_settings.config"]);
    expect(config).toContain('<object id="1">');
    expect(config).toContain('<metadata key="wall_loops" value="3"/>');
    expect(config).toContain('<metadata key="enable_support" value="1"/>');
    expect(config).toContain('<metadata key="support_type" value="tree(auto)"/>');
    expect(config).toContain('<metadata key="seam_position" value="back"/>');
    expect(config).toContain('<metadata key="brim_width" value="5"/>');
  });
});
