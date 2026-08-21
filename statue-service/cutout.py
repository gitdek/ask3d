"""Background removal pre-step for statue generation (Hunyuan path).

The MLX Hunyuan port composites its input on white and does NO subject
segmentation — raw photos come back as subject-plus-background coral.

Usage: python cutout.py input.(jpg|png) output.png
"""

import sys

from PIL import Image
from rembg import remove


def main() -> int:
    image = Image.open(sys.argv[1])
    remove(image).save(sys.argv[2])
    print(f"cutout saved: {sys.argv[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
