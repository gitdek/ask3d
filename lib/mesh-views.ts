"use client";

/**
 * Labelled orthographic views of an uploaded mesh, for the model to look at.
 *
 * An import() is opaque: the model is told the box the mesh occupies and
 * nothing else, so asking for "the eyes white" means guessing where eyes are
 * in a solid it has never seen. Colour masks written that way miss, and a
 * mask that misses renders empty.
 *
 * So render the thing. Two orthographic views — down -Y and down -X — over a
 * 10 mm grid with real millimetre labels, which turns "the raised arm" into a
 * coordinate the model can write an intersection() against.
 *
 * Axis directions are read back out of the projection matrix rather than
 * reasoned about, because getting a sign wrong here would teach the model a
 * mirrored frame, which is worse than telling it nothing.
 */

export interface ViewAxis {
  name: "x" | "y" | "z";
  /** World mm at the left (or bottom) edge of the rendered view. */
  from: number;
  /** World mm at the right (or top) edge. */
  to: number;
}

export interface ViewSpec {
  title: string;
  /** Camera offset direction from the mesh centre. */
  at: [number, number, number];
  horiz: ViewAxis;
  vert: ViewAxis;
}

export const VIEW_SPECS: { title: string; at: [number, number, number]; horizName: "x" | "y"; vertName: "z" }[] = [
  { title: "FRONT", at: [0, -1, 0], horizName: "x", vertName: "z" },
  { title: "SIDE", at: [1, 0, 0], horizName: "y", vertName: "z" },
];

export interface MeshViews {
  /** JPEG data URL of the composed views. */
  dataUrl: string;
  /** One line telling the model how to read the image. */
  legend: string;
}

type Box = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

// 300px over an 80mm model is under 4px/mm, which is not enough to read a
// feature's centre to the millimetre the mask needs. 512 is.
const VIEW = 512; // px per view, before the gutter
const PAD = 44; // room for the axis labels
const GRID_MM = 10;

/** Nice round step so a view never turns into a hatch of labels. */
function gridStep(span: number): number {
  for (const step of [GRID_MM, 20, 25, 50, 100]) if (span / step <= 12) return step;
  return 200;
}

/**
 * Which way each axis actually runs on screen, read out of the projection
 * rather than reasoned about — a sign error here would teach the model a
 * mirrored frame, which is worse than telling it nothing. No WebGL needed,
 * so this is the part under test.
 */
export async function computeViewAxes(box: Box): Promise<ViewSpec[]> {
  const THREE = await import("three");
  const centre = {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
  const half = (span / 2) * 1.08;

  return VIEW_SPECS.map((spec) => {
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

    /** Screen travel of +axis, in normalized device coords. */
    const travel = (name: "x" | "y" | "z") => {
      const lo = { ...centre, [name]: box.min[name] };
      const hi = { ...centre, [name]: box.max[name] };
      const a = new THREE.Vector3(lo.x, lo.y, lo.z).project(camera);
      const b = new THREE.Vector3(hi.x, hi.y, hi.z).project(camera);
      return { dx: b.x - a.x, dy: b.y - a.y };
    };

    const h = travel(spec.horizName);
    const v = travel(spec.vertName);
    return {
      title: spec.title,
      at: spec.at,
      // NDC x grows rightward; NDC y grows upward.
      horiz: {
        name: spec.horizName,
        from: h.dx >= 0 ? box.min[spec.horizName] : box.max[spec.horizName],
        to: h.dx >= 0 ? box.max[spec.horizName] : box.min[spec.horizName],
      },
      vert: {
        name: spec.vertName,
        from: v.dy >= 0 ? box.min[spec.vertName] : box.max[spec.vertName],
        to: v.dy >= 0 ? box.max[spec.vertName] : box.min[spec.vertName],
      },
    };
  });
}

export async function renderMeshViews(bytes: ArrayBuffer, box: Box): Promise<MeshViews | null> {
  try {
    const [{ STLLoader }, THREE, specs] = await Promise.all([
      import("three/addons/loaders/STLLoader.js"),
      import("three"),
      computeViewAxes(box),
    ]);

    const geometry = new STLLoader().parse(bytes);
    geometry.computeVertexNormals();

    const centre = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      (box.min.y + box.max.y) / 2,
      (box.min.z + box.max.z) / 2,
    );
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const half = (span / 2) * 1.08; // a sliver of air so nothing touches the frame

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0b0f);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.75, metalness: 0 }),
    );
    scene.add(mesh);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.4, 1.2);
    scene.add(key);

    const canvas = document.createElement("canvas");
    canvas.width = VIEW;
    canvas.height = VIEW;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(VIEW, VIEW, false);

    const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, span * 10);
    camera.up.set(0, 0, 1);

    const frames: HTMLCanvasElement[] = [];
    for (const spec of specs) {
      camera.position.set(
        centre.x + spec.at[0] * span * 3,
        centre.y + spec.at[1] * span * 3,
        centre.z + spec.at[2] * span * 3,
      );
      camera.lookAt(centre);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const frame = document.createElement("canvas");
      frame.width = VIEW;
      frame.height = VIEW;
      frame.getContext("2d")!.drawImage(canvas, 0, 0);
      frames.push(frame);
    }

    renderer.dispose();
    geometry.dispose();

    // Compose: each view gets a padded panel with a labelled mm grid.
    const out = document.createElement("canvas");
    out.width = PAD + (VIEW + PAD) * specs.length;
    out.height = VIEW + PAD * 2;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#0b0b0f";
    ctx.fillRect(0, 0, out.width, out.height);

    specs.forEach((spec, i) => {
      const x0 = PAD + i * (VIEW + PAD);
      const y0 = PAD;
      ctx.drawImage(frames[i], x0, y0);

      ctx.strokeStyle = "rgba(120,200,255,0.26)";
      ctx.lineWidth = 1;
      ctx.font = "13px ui-monospace, monospace";
      ctx.fillStyle = "#8ba6c0";

      // Horizontal: `from` is the left edge, so t runs straight across.
      const hStep = gridStep(Math.abs(spec.horiz.to - spec.horiz.from));
      ctx.strokeStyle = "rgba(120,200,255,0.11)";
      for (const mm of ticks(spec.horiz, hStep / 2)) {
        const t = (mm - spec.horiz.from) / (spec.horiz.to - spec.horiz.from);
        ctx.beginPath();
        ctx.moveTo(x0 + t * VIEW, y0);
        ctx.lineTo(x0 + t * VIEW, y0 + VIEW);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(120,200,255,0.26)";
      for (const mm of ticks(spec.horiz, hStep)) {
        const t = (mm - spec.horiz.from) / (spec.horiz.to - spec.horiz.from);
        const px = x0 + t * VIEW;
        ctx.beginPath();
        ctx.moveTo(px, y0);
        ctx.lineTo(px, y0 + VIEW);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.fillText(String(Math.round(mm)), px, y0 + VIEW + 16);
      }

      // Vertical: `from` is the BOTTOM edge, and canvas y grows downward.
      const vStep = gridStep(Math.abs(spec.vert.to - spec.vert.from));
      ctx.strokeStyle = "rgba(120,200,255,0.11)";
      for (const mm of ticks(spec.vert, vStep / 2)) {
        const t = (mm - spec.vert.from) / (spec.vert.to - spec.vert.from);
        ctx.beginPath();
        ctx.moveTo(x0, y0 + (1 - t) * VIEW);
        ctx.lineTo(x0 + VIEW, y0 + (1 - t) * VIEW);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(120,200,255,0.26)";
      for (const mm of ticks(spec.vert, vStep)) {
        const t = (mm - spec.vert.from) / (spec.vert.to - spec.vert.from);
        const py = y0 + (1 - t) * VIEW;
        ctx.beginPath();
        ctx.moveTo(x0, py);
        ctx.lineTo(x0 + VIEW, py);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(String(Math.round(mm)), x0 - 5, py + 4);
      }

      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.strokeRect(x0, y0, VIEW, VIEW);
      ctx.fillStyle = "#d6dde6";
      ctx.font = "bold 14px ui-monospace, monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${spec.title}  ${spec.horiz.name} \u2192  ${spec.vert.name} \u2191`, x0, y0 - 12);
    });

    return { dataUrl: out.toDataURL("image/jpeg", 0.82), legend: describeAxes(specs) };
  } catch {
    // No WebGL, a mesh three.js won't parse — the box alone still works.
    return null;
  }
}

/** Round millimetre marks spanning an axis, in ascending world order. */
function ticks(axis: ViewAxis, step: number): number[] {
  const lo = Math.min(axis.from, axis.to);
  const hi = Math.max(axis.from, axis.to);
  const out: number[] = [];
  for (let mm = Math.ceil(lo / step) * step; mm <= hi; mm += step) out.push(mm);
  return out;
}

/** The one line that tells the model how to read the image. */
export function describeAxes(specs: ViewSpec[]): string {
  return specs
    .map(
      (s) =>
        `${s.title.toLowerCase()} view: ${s.horiz.name} runs ${s.horiz.from.toFixed(0)} (left) to ${s.horiz.to.toFixed(0)} (right), ${s.vert.name} runs ${s.vert.from.toFixed(0)} (bottom) to ${s.vert.to.toFixed(0)} (top)`,
    )
    .join("; ");
}
