const SERVICE_URL = process.env.NEXT_PUBLIC_STATUE_SERVICE_URL ?? "http://127.0.0.1:8765";

export interface StatueHealth {
  ok: boolean;
  mock: boolean;
  model_ready: boolean;
  busy: boolean;
}

export interface StatueTaskStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  detail: string;
  elapsed_seconds: number;
  model_format: "glb" | "obj" | null;
  error: string | null;
}

export async function statueHealth(): Promise<StatueHealth | null> {
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(2500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export async function createStatueTask(image: File): Promise<string> {
  const form = new FormData();
  form.append("image", image, image.name);
  const res = await fetch(`${SERVICE_URL}/tasks`, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `statue service returned ${res.status}`);
  }
  return (await res.json()).id;
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
 * Convert a generated GLB/OBJ into a print-ready binary STL:
 * Y-up → Z-up (rotateX +π/2), uniform scale so the largest dimension hits
 * the target (AI models are bbox-normalized, never real meters), centered
 * in XY and floored to Z=0. Returns Z-up printer-mm dims.
 */
export async function modelToPrintableStl(
  buffer: ArrayBuffer,
  format: "glb" | "obj",
  targetMaxDimMm: number,
): Promise<{ stl: ArrayBuffer; dims: { x: number; y: number; z: number } }> {
  const three = await import("three");
  const { STLExporter } = await import("three/addons/exporters/STLExporter.js");

  let root: import("three").Object3D;
  if (format === "glb") {
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
  wrapper.rotation.x = Math.PI / 2; // Y-up → Z-up

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
