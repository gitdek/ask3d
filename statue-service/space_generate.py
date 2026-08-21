"""Generate a statue via the microsoft/TRELLIS.2 HF Space (full pipeline,
ZeroGPU). Free-account quota: ~5 GPU-min/day. One Client session carries
the server-side state across the endpoint chain.

Usage: python space_generate.py input.jpg output_dir
"""

import shutil
import sys
import time

from gradio_client import Client, handle_file
from huggingface_hub import get_token


def main() -> int:
    image_path, out_dir = sys.argv[1], sys.argv[2]
    t0 = time.time()
    client = Client("microsoft/TRELLIS.2", token=get_token())
    print(f"[{time.time()-t0:5.0f}s] connected")

    client.predict(api_name="/start_session")
    print(f"[{time.time()-t0:5.0f}s] session started")

    pre = client.predict(input=handle_file(image_path), api_name="/preprocess_image")
    print(f"[{time.time()-t0:5.0f}s] preprocessed: {pre.get('path') if isinstance(pre, dict) else pre}")

    seed = client.predict(randomize_seed=False, seed=42, api_name="/get_seed")
    print(f"[{time.time()-t0:5.0f}s] seed: {seed}")

    preview = client.predict(
        image=handle_file(image_path),
        seed=42,
        resolution="1024",
        api_name="/image_to_3d",
    )
    print(f"[{time.time()-t0:5.0f}s] image_to_3d done (preview html {len(str(preview))} chars)")

    glb_path, download_path = client.predict(
        decimation_target=300000, texture_size=1024, api_name="/extract_glb"
    )
    print(f"[{time.time()-t0:5.0f}s] extracted: {glb_path}")
    dest = f"{out_dir}/statue.glb"
    shutil.copy(download_path or glb_path, dest)
    print(f"[{time.time()-t0:5.0f}s] saved {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
