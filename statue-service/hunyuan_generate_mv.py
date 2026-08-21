"""EXPERIMENTAL multi-photo statue generation on the MLX Hunyuan3D port.

Usage:
  python hunyuan_generate_mv.py output.glb front=path.png [back=...] [left=...] [right=...] \
      [--steps N] [--octree N] [--view-embed]
Run from statue-service/hunyuan-mlx with its .venv. Inputs should be
pre-cut RGBA (use cutout.py) — the pipeline composites on white.

Default is plain token concat (no view embeddings): the local checkpoint is
the single-view 2.1 DiT (no MV weights exist for 2.1), and the torch MV
recipe's view embeddings make it denoise to an empty SDF. --view-embed
restores the faithful DinoImageEncoderMV semantics for future MV weights.
"""

import sys
import time

sys.path.insert(0, ".")

import mlx.core as mx

from hy3dshape.hy3dshape.pipeline_mlx import ShapePipeline

sys.path.insert(0, "/Users/dek/projects/ask3d/statue-service")
from hunyuan_mv import MultiViewEncoderProxy, sort_views


def main() -> int:
    args = sys.argv[1:]
    steps, octree, guidance = 50, 512, 7.5
    add_view_embed = False
    if "--guidance" in args:
        i = args.index("--guidance")
        guidance = float(args[i + 1])
        del args[i : i + 2]
    if "--view-embed" in args:
        add_view_embed = True
        args.remove("--view-embed")
    if "--no-view-embed" in args:  # legacy alias of the default
        args.remove("--no-view-embed")
    if "--steps" in args:
        i = args.index("--steps")
        steps = int(args[i + 1])
        del args[i : i + 2]
    if "--octree" in args:
        i = args.index("--octree")
        octree = int(args[i + 1])
        del args[i : i + 2]
    out_path = args[0]
    views = dict(a.split("=", 1) for a in args[1:])
    if not views:
        print("need at least one view=path argument", file=sys.stderr)
        return 1

    t0 = time.time()
    pipe = ShapePipeline.from_pretrained("dgrauet/hunyuan3d-2.1-mlx")
    print(f"[{time.time()-t0:6.0f}s] pipeline loaded", flush=True)

    paths, view_idxs = sort_views(views)
    tensors = [pipe.preprocess_image(p) for p in paths]  # each (1, H, W, 3)
    stacked = mx.concatenate(tensors, axis=0)  # (n, H, W, 3)
    print(f"[{time.time()-t0:6.0f}s] {len(paths)} views prepared, idxs {view_idxs}", flush=True)

    original_encoder = pipe.image_encoder
    pipe.image_encoder = MultiViewEncoderProxy(original_encoder, view_idxs, add_view_embed=add_view_embed)
    try:
        mesh = pipe(stacked, num_inference_steps=steps, guidance_scale=guidance, octree_resolution=octree)
    finally:
        pipe.image_encoder = original_encoder
    print(
        f"[{time.time()-t0:6.0f}s] shape generated (mv x{len(paths)}, steps={steps}, "
        f"octree={octree}, cfg={guidance}, view_embed={add_view_embed})",
        flush=True,
    )
    mesh.export(out_path)
    print(f"[{time.time()-t0:6.0f}s] exported {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
