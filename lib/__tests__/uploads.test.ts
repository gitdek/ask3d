import { describe, expect, it } from "vitest";
import { describeUpload, type UploadedAsset } from "../uploads";

const mesh = (extra: Partial<UploadedAsset> = {}): UploadedAsset => ({
  name: "statue.stl",
  path: "/uploads/statue.stl",
  kind: "mesh",
  dims: { x: 80, y: 67.46, z: 69.97 },
  ...extra,
});

describe("describeUpload — mesh", () => {
  it("states where the mesh sits, not only how big it is", () => {
    // A size alone sent the model into a 0..size frame, so every color mask
    // it wrote for a centred statue missed the geometry and rendered empty.
    const text = describeUpload(
      mesh({
        box: { min: { x: -40, y: -33.73, z: 0 }, max: { x: 40, y: 33.73, z: 69.97 } },
      }),
    );
    expect(text).toContain("x -40.0..40.0");
    expect(text).toContain("y -33.7..33.7");
    expect(text).toContain("z 0.0..70.0");
    expect(text).toContain("80.0 × 67.5 × 70.0 mm");
  });

  it("stays usable for a mesh recorded before the box was tracked", () => {
    const text = describeUpload(mesh());
    expect(text).toContain("80.0 × 67.5 × 70.0 mm");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("..");
  });

  it("neutralizes backticks and newlines in a filename", () => {
    const text = describeUpload(mesh({ name: "a`b\nc.stl" }));
    expect(text).not.toContain("`");
    expect(text.split("\n")).toHaveLength(1);
  });
});
