"""Make a generated statue mesh watertight and printable.

Runs inside the trellis-mac venv (trimesh + pymeshfix + manifold3d).
TRELLIS.2 output (hole filling disabled in the Mac port) is one large open
shell plus floating debris; OpenSCAD's Manifold backend silently drops
non-closed meshes from CSG, so without this step a statue vanishes the
moment it is combined with other geometry.

Usage: python repair.py input.glb output.glb
"""

import sys

import numpy as np
import pymeshfix
import trimesh

MIN_SHELL_FACES = 1000  # smaller shells are floating debris — unprintable anyway


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    mesh = trimesh.load(src, force="mesh")
    shells = [p for p in mesh.split(only_watertight=False) if len(p.faces) >= MIN_SHELL_FACES]
    if not shells:
        print("repair: no substantial shells found", file=sys.stderr)
        return 1

    repaired = []
    for shell in shells:
        vertices, faces = pymeshfix.clean_from_arrays(
            np.asarray(shell.vertices, float), np.asarray(shell.faces, np.int32)
        )
        if len(faces) == 0:
            continue
        fixed = trimesh.Trimesh(vertices, faces)
        trimesh.repair.fix_normals(fixed)
        if fixed.volume < 0:
            fixed.invert()
        if fixed.is_volume:
            repaired.append(fixed)

    if not repaired:
        print("repair: no shell survived repair", file=sys.stderr)
        return 1

    union = trimesh.boolean.union(repaired, engine="manifold") if len(repaired) > 1 else repaired[0]
    if not union.is_watertight:
        print("repair: union is not watertight", file=sys.stderr)
        return 1

    union.export(dst)
    print(f"repair: {len(mesh.faces)} faces -> {len(union.faces)} faces, watertight, "
          f"{len(shells)} shells kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
