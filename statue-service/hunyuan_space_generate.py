"""Multi-photo (and optionally textured) statue via the official tencent
HF Spaces (ZeroGPU — shares the account's free quota).

Single front photo → tencent/Hunyuan3D-2.1 (best single-view model).
Any other view combination → tencent/Hunyuan3D-2mv: the only true
multiview-TRAINED checkpoint (2.0-era turbo DiT; 2.1 has no MV weights,
and the 2.1 Space's mv_image_* slots are dead — its MV_MODE launch flag
is off, so it errors "Please provide either a caption or an image").

Usage: python hunyuan_space_generate.py out_dir front=front.png [left=...] [back=...] [right=...] [--textured]
A bare path (no view= prefix) is treated as the front view.
Writes out_dir/statue.glb (shape) or out_dir/statue-textured.glb too with --textured.
"""

import shutil
import sys
import time

from gradio_client import Client, handle_file
from huggingface_hub import get_token

VIEWS = ("front", "back", "left", "right")


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--textured"]
    textured = "--textured" in sys.argv
    out_dir, specs = args[0], args[1:]
    images = {}
    for spec in specs:
        view, _, path = spec.rpartition("=")
        view = view or "front"
        if view not in VIEWS:
            print(f"unknown view '{view}'; valid: {VIEWS}", file=sys.stderr)
            return 1
        images[view] = path
    if not images:
        print("need at least one view=path image", file=sys.stderr)
        return 1
    # Single front photo → the 2.1 Space's plain image slot; otherwise the
    # 2mv Space's named mv_image_* slots, keyed by view (never positional).
    kwargs = {}
    if list(images) == ["front"]:
        space, steps = "tencent/Hunyuan3D-2.1", 30
        kwargs["image"] = handle_file(images["front"])
    else:
        # The Space's step default is 5 (turbo checkpoint), but 5 steps
        # produced a blocky under-converged mesh on a real subject — 30
        # costs the same 120s ZeroGPU reservation and converges properly.
        space, steps = "tencent/Hunyuan3D-2mv", 30
        for view, path in images.items():
            kwargs[f"mv_image_{view}"] = handle_file(path)

    t0 = time.time()
    client = Client(space, token=get_token())
    print(f"[{time.time()-t0:5.0f}s] connected to {space}", flush=True)
    endpoint = "/generation_all" if textured else "/shape_generation"
    result = client.predict(
        **kwargs,
        steps=steps,
        guidance_scale=5.0,
        seed=1234,
        octree_resolution=512,
        check_box_rembg=True,
        randomize_seed=False,
        api_name=endpoint,
    )
    print(f"[{time.time()-t0:5.0f}s] generated", flush=True)
    # The response mixes local file paths with HTML preview snippets —
    # keep only strings that are real files on disk.
    import os
    files = [
        r for r in (result if isinstance(result, (list, tuple)) else [result])
        if isinstance(r, str) and os.path.isfile(r)
    ]
    if not files:
        print("no file in response", file=sys.stderr)
        return 1
    shutil.copy(files[0], f"{out_dir}/statue.glb")
    print(f"[{time.time()-t0:5.0f}s] saved {out_dir}/statue.glb", flush=True)
    if textured and len(files) > 1:
        shutil.copy(files[1], f"{out_dir}/statue-textured.glb")
        print(f"[{time.time()-t0:5.0f}s] saved {out_dir}/statue-textured.glb", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
