const SERVICE_URL = process.env.NEXT_PUBLIC_STATUE_SERVICE_URL ?? "http://127.0.0.1:8765";

export type StatueEngine = "hunyuan" | "space" | "hunyuan-space";

export interface StatueHealth {
  ok: boolean;
  mock: boolean;
  default_engine: string;
  engines: Record<string, boolean>;
  busy: boolean;
}

export interface StatueTaskStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  detail: string;
  elapsed_seconds: number;
  /** "stl" is the repaired path: already watertight, upright, Z-up. */
  model_format: "glb" | "obj" | "stl" | null;
  error: string | null;
  /** Generation provenance (local engines): how to reproduce this statue. */
  engine?: string | null;
  seed?: number | null;
  octree?: string | null;
}

export async function statueHealth(): Promise<StatueHealth | null> {
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Start a statue task. `images` order matters for multi-photo engines and
 * follows Hunyuan's canonical view order: front, left, back, right (max 4;
 * extras beyond the first are only used by multi-photo capable engines).
 * With two photos the second lands in `left` — the right guess for the
 * common front-plus-profile pair.
 */
export async function createStatueTask(images: File[], engine: StatueEngine): Promise<string> {
  const form = new FormData();
  form.append("image", images[0], images[0].name);
  const slots = ["image_left", "image_back", "image_right"];
  images.slice(1, 4).forEach((file, i) => form.append(slots[i], file, file.name));
  form.append("engine", engine);
  const res = await fetch(`${SERVICE_URL}/tasks`, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `statue service returned ${res.status}`);
  }
  return (await res.json()).id;
}

export interface LatestStatueTask {
  id: string;
  status: StatueTaskStatus["status"];
  detail: string;
  age_seconds: number;
  model_format: StatueTaskStatus["model_format"];
  engine: string | null;
}

/** The sidecar's most recent task, or null — used to adopt orphaned generations after a page reload. */
export async function fetchLatestStatueTask(): Promise<LatestStatueTask | null> {
  try {
    const res = await fetch(`${SERVICE_URL}/tasks-latest`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function pollStatueTask(id: string): Promise<StatueTaskStatus> {
  const res = await fetch(`${SERVICE_URL}/tasks/${id}`);
  if (!res.ok) throw new Error(`statue service returned ${res.status}`);
  return res.json();
}

export async function fetchStatueModel(id: string): Promise<ArrayBuffer> {
  const res = await fetch(`${SERVICE_URL}/tasks/${id}/model`);
  if (!res.ok) throw new Error(`could not download the generated model (${res.status})`);
  return res.arrayBuffer();
}

/**
 * Convert a generated model into a print-ready binary STL, uniformly scaled
 * so the largest dimension hits the target (AI models are bbox-normalized,
 * never real meters), centered in XY and floored to Z=0.
 *
 * "stl" input comes from the sidecar's repair step and is ALREADY upright
 * Z-up — no axis correction. GLB/OBJ (unrepaired fallback) get the glTF
 * Y-up → Z-up rotation. Returns Z-up printer-mm dims.
 */
export async function modelToPrintableStl(
  buffer: ArrayBuffer,
  format: "glb" | "obj" | "stl",
  targetMaxDimMm: number,
): Promise<{ stl: ArrayBuffer; dims: { x: number; y: number; z: number } }> {
  const three = await import("three");
  const { STLExporter } = await import("three/addons/exporters/STLExporter.js");

  let root: import("three").Object3D;
  let alreadyZUp = false;
  if (format === "stl") {
    const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
    const geometry = new STLLoader().parse(buffer);
    root = new three.Mesh(geometry);
    alreadyZUp = true;
  } else if (format === "glb") {
    const [{ GLTFLoader }, { DRACOLoader }] = await Promise.all([
      import("three/addons/loaders/GLTFLoader.js"),
      import("three/addons/loaders/DRACOLoader.js"),
    ]);
    const loader = new GLTFLoader();
    // Belt and braces: decoders are vendored in public/draco; unused unless
    // the file is actually Draco-compressed.
    const draco = new DRACOLoader();
    draco.setDecoderPath("/draco/");
    loader.setDRACOLoader(draco);
    const gltf = await new Promise<{ scene: import("three").Group }>((resolve, reject) => {
      try {
        loader.parse(buffer, "", resolve, reject);
      } catch (error) {
        reject(error); // Draco errors throw synchronously out of parse()
      }
    });
    root = gltf.scene;
  } else {
    const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
    root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  }

  const wrapper = new three.Group();
  wrapper.add(root);
  if (!alreadyZUp) wrapper.rotation.x = Math.PI / 2; // Y-up → Z-up

  let box = new three.Box3().setFromObject(wrapper); // also updates world matrices
  const size = new three.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!(maxDim > 0)) throw new Error("The generated model is empty");
  wrapper.scale.setScalar(targetMaxDimMm / maxDim);

  box = new three.Box3().setFromObject(wrapper); // re-measure after scaling
  const center = new three.Vector3();
  box.getCenter(center);
  wrapper.position.set(-center.x, -center.y, -box.min.z);
  wrapper.updateMatrixWorld(true); // exporter never updates matrices itself

  const dataView = new STLExporter().parse(wrapper, { binary: true }) as unknown as DataView;
  const triangles = (dataView.byteLength - 84) / 50;
  if (triangles <= 0) throw new Error("Conversion produced an empty STL");

  box = new three.Box3().setFromObject(wrapper);
  const finalSize = new three.Vector3();
  box.getSize(finalSize);
  return {
    stl: dataView.buffer as ArrayBuffer,
    dims: { x: finalSize.x, y: finalSize.y, z: finalSize.z },
  };
}
