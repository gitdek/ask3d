"""Shape-only statue generation via the native MLX port of Hunyuan3D-2.1.

Usage: python hunyuan_generate.py input.(png|jpg) output.glb [steps] [octree] [guidance] [seed]
Run from statue-service/hunyuan-mlx with its .venv. Without a seed the
run is deterministic (MLX default generator); hard subjects are worth a
few seed rolls — head/face quality varies a lot between seeds.
"""

import sys
import time

sys.path.insert(0, ".")

from hy3dshape.hy3dshape.pipeline_mlx import ShapePipeline


def main() -> int:
    image_path, out_path = sys.argv[1], sys.argv[2]
    steps = int(sys.argv[3]) if len(sys.argv) > 3 else 50
    octree = int(sys.argv[4]) if len(sys.argv) > 4 else 256
    guidance = float(sys.argv[5]) if len(sys.argv) > 5 else 7.5
    seed = int(sys.argv[6]) if len(sys.argv) > 6 else None
    t0 = time.time()
    pipe = ShapePipeline.from_pretrained("dgrauet/hunyuan3d-2.1-mlx")
    print(f"[{time.time()-t0:6.0f}s] pipeline loaded", flush=True)
    mesh = pipe(
        image_path,
        num_inference_steps=steps,
        guidance_scale=guidance,
        octree_resolution=octree,
        seed=seed,
    )
    print(f"[{time.time()-t0:6.0f}s] shape generated (steps={steps} octree={octree} cfg={guidance} seed={seed})", flush=True)
    mesh.export(out_path)
    print(f"[{time.time()-t0:6.0f}s] exported {out_path}", flush=True)
    # Degenerate-output guard: some seeds collapse a hard subject into a
    # flat card (observed ratio ~0.002 vs >0.2 for real statues). Exit 3
    # so the sidecar can re-roll the seed once instead of serving a card.
    extents = sorted(float(e) for e in mesh.extents)
    if extents[2] > 0 and extents[0] / extents[2] < 0.05:
        print(f"flat-card output detected (extents {extents}) — try another seed", flush=True)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
