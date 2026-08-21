"""Stage-2 PBR texture synthesis via the MLX Hunyuan3D-2.1 port.

Usage: python hunyuan_paint.py mesh.glb reference.png output_prefix
Run from statue-service/hunyuan-mlx with its .venv.
Produces output_prefix.obj (+ .glb when supported).
"""

import sys
import time

sys.path.insert(0, ".")
sys.path.insert(0, "hy3dpaint")

from textureGenPipeline_mlx import Hunyuan3DPaintConfigMLX, Hunyuan3DPaintPipelineMLX


def main() -> int:
    mesh_path, ref_path, out_prefix = sys.argv[1], sys.argv[2], sys.argv[3]
    t0 = time.time()
    cfg = Hunyuan3DPaintConfigMLX(max_num_view=6, resolution=512)
    pipe = Hunyuan3DPaintPipelineMLX(cfg)
    print(f"[{time.time()-t0:6.0f}s] paint pipeline ready", flush=True)
    pipe(
        mesh_path=mesh_path,
        image_path=ref_path,
        output_mesh_path=f"{out_prefix}.obj",
        save_glb=True,
    )
    print(f"[{time.time()-t0:6.0f}s] textured mesh written to {out_prefix}.obj/.glb", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
