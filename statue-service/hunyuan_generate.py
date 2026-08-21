"""Shape-only statue generation via the native MLX port of Hunyuan3D-2.1.

Usage: python hunyuan_generate.py input.(png|jpg) output.glb [steps] [octree] [guidance]
Run from statue-service/hunyuan-mlx with its .venv.
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
    t0 = time.time()
    pipe = ShapePipeline.from_pretrained("dgrauet/hunyuan3d-2.1-mlx")
    print(f"[{time.time()-t0:6.0f}s] pipeline loaded", flush=True)
    mesh = pipe(
        image_path,
        num_inference_steps=steps,
        guidance_scale=guidance,
        octree_resolution=octree,
    )
    print(f"[{time.time()-t0:6.0f}s] shape generated (steps={steps} octree={octree} cfg={guidance})", flush=True)
    mesh.export(out_path)
    print(f"[{time.time()-t0:6.0f}s] exported {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
