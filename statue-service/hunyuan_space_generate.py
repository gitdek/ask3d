"""Multi-photo (and optionally textured) statue via the official
tencent/Hunyuan3D-2.1 HF Space (ZeroGPU — shares the account's free quota).

Usage: python hunyuan_space_generate.py out_dir front.png [back.png] [left.png] [right.png] [--textured]
Writes out_dir/statue.glb (shape) or out_dir/statue-textured.glb too with --textured.
"""

import shutil
import sys
import time

from gradio_client import Client, handle_file
from huggingface_hub import get_token


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--textured"]
    textured = "--textured" in sys.argv
    out_dir, images = args[0], args[1:]
    if not images:
        print("need at least one image", file=sys.stderr)
        return 1
    views = ["image", "mv_image_front", "mv_image_back", "mv_image_left", "mv_image_right"]
    # Single photo → the plain image slot; multiple → the named view slots
    # in chip order front, back, left, right.
    kwargs = {}
    if len(images) == 1:
        kwargs["image"] = handle_file(images[0])
    else:
        for slot, path in zip(views[1:], images[:4]):
            kwargs[slot] = handle_file(path)

    t0 = time.time()
    client = Client("tencent/Hunyuan3D-2.1", token=get_token())
    print(f"[{time.time()-t0:5.0f}s] connected", flush=True)
    endpoint = "/generation_all" if textured else "/shape_generation"
    result = client.predict(
        **kwargs,
        steps=30,
        guidance_scale=5.0,
        seed=1234,
        octree_resolution=512,
        check_box_rembg=True,
        randomize_seed=False,
        api_name=endpoint,
    )
    print(f"[{time.time()-t0:5.0f}s] generated", flush=True)
    files = [r for r in (result if isinstance(result, (list, tuple)) else [result]) if isinstance(r, str)]
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
