export interface UploadedAsset {
  /** Display name (original filename). */
  name: string;
  /** Virtual path inside the compiler FS, e.g. "/uploads/model.stl". */
  path: string;
  kind: "mesh" | "image" | "scad";
  /** Content written into the compiler FS (STL bytes or .dat heightmap text). */
  compileData?: ArrayBuffer | string;
  /** Mesh bounding box in mm (meshes only). */
  dims?: { x: number; y: number; z: number };
  /** Heightmap grid size (images only). */
  heightmap?: { rows: number; cols: number };
  /** Downscaled JPEG data URL for the multimodal model (images only). */
  imageDataUrl?: string;
  /** Source text (.scad uploads only). */
  scadSource?: string;
  /** The original picked file (images only) — full resolution for statue generation. */
  file?: File;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_HEIGHTMAP_COLS = 120;
const MAX_VISION_EDGE = 512;
const HEIGHTMAP_MAX_MM = 8;

function sanitizeBaseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || "file";
}

export function uploadPath(name: string, ext: string, taken: ReadonlySet<string>): string {
  const base = sanitizeBaseName(name);
  let path = `/uploads/${base}.${ext}`;
  for (let n = 2; taken.has(path); n++) path = `/uploads/${base}-${n}.${ext}`;
  return path;
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error(`Could not read image "${file.name}"`));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function drawScaled(img: HTMLImageElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Convert an image to an OpenSCAD surface() .dat heightmap: rows of
 * space-separated heights in mm, 0–8, bright = high. Rows are emitted
 * bottom-up so the relief is not mirrored (surface() treats the first data
 * row as the lowest Y).
 */
function imageToHeightmapDat(img: HTMLImageElement): { dat: string; rows: number; cols: number } {
  const canvas = drawScaled(img, MAX_HEIGHTMAP_COLS);
  const { width, height } = canvas;
  const pixels = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const lines: string[] = [];
  for (let y = height - 1; y >= 0; y--) {
    const row: string[] = [];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
      row.push(((luma / 255) * HEIGHTMAP_MAX_MM).toFixed(2));
    }
    lines.push(row.join(" "));
  }
  return { dat: lines.join("\n"), rows: height, cols: width };
}

async function meshDims(bytes: ArrayBuffer): Promise<{ x: number; y: number; z: number }> {
  const [{ STLLoader }, { Vector3 }] = await Promise.all([
    import("three/addons/loaders/STLLoader.js"),
    import("three"),
  ]);
  const geometry = new STLLoader().parse(bytes);
  geometry.computeBoundingBox();
  const size = new Vector3();
  geometry.boundingBox!.getSize(size);
  geometry.dispose();
  return { x: size.x, y: size.y, z: size.z };
}

/** Process a user-picked file into an uploadable asset. Throws with a readable message on unsupported input. */
export async function processUpload(file: File, takenPaths: ReadonlySet<string>): Promise<UploadedAsset> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".stl")) {
    const bytes = await file.arrayBuffer();
    return {
      name: file.name,
      path: uploadPath(file.name, "stl", takenPaths),
      kind: "mesh",
      compileData: bytes,
      dims: await meshDims(bytes),
    };
  }
  if (lower.endsWith(".scad")) {
    return {
      name: file.name,
      path: uploadPath(file.name, "scad", takenPaths),
      kind: "scad",
      scadSource: await file.text(),
    };
  }
  if (IMAGE_TYPES.has(file.type)) {
    const img = await loadImage(file);
    const { dat, rows, cols } = imageToHeightmapDat(img);
    const vision = drawScaled(img, MAX_VISION_EDGE);
    return {
      name: file.name,
      path: uploadPath(file.name, "dat", takenPaths),
      kind: "image",
      compileData: dat,
      heightmap: { rows, cols },
      imageDataUrl: vision.toDataURL("image/jpeg", 0.8),
      file,
    };
  }
  throw new Error(`Unsupported file "${file.name}" — upload .stl, .scad, or a PNG/JPEG/WebP image.`);
}

/** The context block appended to the user's message so the model knows what it can reference. */
export function describeUpload(asset: UploadedAsset): string {
  if (asset.kind === "mesh") {
    const d = asset.dims!;
    return `- ${asset.name}: 3D mesh, ${d.x.toFixed(1)} × ${d.y.toFixed(1)} × ${d.z.toFixed(1)} mm, use it with import("${asset.path}") — treat it as an opaque solid you can combine with, cut from, or add to.`;
  }
  if (asset.kind === "image") {
    const h = asset.heightmap!;
    return `- ${asset.name}: photo converted to a heightmap at "${asset.path}" (${h.rows} rows × ${h.cols} cols, heights 0–${HEIGHTMAP_MAX_MM}mm, bright = high). Use surface(file = "${asset.path}", center = true) and scale([target_width/${h.cols}, target_depth/${h.rows}, relief_factor]) to size it. Ideal for relief plaques and lithophane-style prints. The photo itself is attached for reference.`;
  }
  return `- ${asset.name}: OpenSCAD source to modify:\n\`\`\`openscad\n${asset.scadSource}\n\`\`\``;
}
