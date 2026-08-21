"""Make a generated statue mesh watertight, upright, and printable.

Runs inside the trellis-mac venv (trimesh + pymeshfix + manifold3d).
TRELLIS.2 output (hole filling disabled in the Mac port) is one large open
shell plus floating debris; OpenSCAD's Manifold backend silently drops
non-closed meshes from CSG, so without this step a statue vanishes the
moment it is combined with other geometry.

TRELLIS also reconstructs in the input photo's CAMERA frame, so the model
is pitched by however the photo was taken (a downward shot of a dog yields
a ~45° lean). After repair we auto-orient: starting from the head-up base
rotation, scan pitch angles and keep the one whose ground contact
footprint is widest — the statue stands the way it would naturally rest.

Output is binary STL in final print orientation: Z-up, base at z=0,
centered in XY. (STL avoids glTF up-axis ambiguity entirely.)

Usage: python repair.py input.glb output.stl
"""

import sys

import numpy as np
import pymeshfix
import trimesh

MIN_SHELL_FACES = 1000  # smaller shells are floating debris — unprintable anyway
CONTACT_BAND = 0.015  # vertices within 1.5% of height count as touching the ground
LEVEL_SCAN_DEG = np.arange(-25, 26, 2.5)  # small corrections only — must not flop the model over


def _rot(deg: float, axis: list) -> np.ndarray:
    return trimesh.transformations.rotation_matrix(np.radians(deg), axis)


def auto_orient(mesh: "trimesh.Trimesh") -> "trimesh.Trimesh":
    """Stand the statue upright using the reconstruction's own ground cut:
    single-photo TRELLIS meshes are truncated at the ground plane, leaving
    one large flat planar region — that region IS the base. Find the
    dominant coplanar patch by binning face normals and weighting by area,
    then rotate its normal to point straight down."""
    normals = mesh.face_normals
    areas = mesh.area_faces
    # ~5.7° normal bins; the flat cut lands in one bin, organic surface spreads.
    keys = np.round(normals * 10).astype(int)
    keys_view = [tuple(k) for k in keys]
    from collections import defaultdict

    bin_area = defaultdict(float)
    for key, area in zip(keys_view, areas):
        bin_area[key] += float(area)
    best_key = max(bin_area, key=bin_area.get)
    fraction = bin_area[best_key] / float(areas.sum())
    mask = np.array([k == best_key for k in keys_view])
    plane_normal = (normals[mask] * areas[mask, None]).sum(axis=0)
    plane_normal /= np.linalg.norm(plane_normal)
    print(f"repair: auto-orient ground-cut normal {np.round(plane_normal, 3).tolist()}, "
          f"{fraction * 100:.1f}% of surface area")

    m = mesh.copy()
    if fraction < 0.02:
        # No dominant flat region — fall back to longest-axis-up.
        axis_rots = {0: _rot(90, [0, 1, 0]), 1: _rot(-90, [1, 0, 0]), 2: np.eye(4)}
        m.apply_transform(axis_rots[int(np.argmax(mesh.extents))])
        print("repair: auto-orient fallback (no dominant plane): longest axis up")
        return m

    m.apply_transform(trimesh.geometry.align_vectors(plane_normal, [0, 0, -1]))
    return m


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    loaded = trimesh.load(src, force="mesh")
    # Weld by position first: textured GLBs split vertices at every UV seam,
    # which shatters connectivity into thousands of phantom "components"
    # (and makes trimesh's split() blow up on the resulting graph).
    mesh = trimesh.Trimesh(
        vertices=np.asarray(loaded.vertices), faces=np.asarray(loaded.faces), process=False
    )
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    shells = [p for p in mesh.split(only_watertight=False) if len(p.faces) >= MIN_SHELL_FACES]
    if not shells:
        print("repair: no substantial shells found", file=sys.stderr)
        return 1

    repaired = []
    for shell in shells:
        if shell.is_watertight:
            fixed = shell
        else:
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

    # Keep the largest shell plus only shells whose bounds intersect its
    # (slightly padded) bounds — disconnected floaters ruin the bounding box,
    # the auto-orientation, and the print.
    repaired.sort(key=lambda s: len(s.faces), reverse=True)
    main = repaired[0]
    pad = 0.02 * float(np.max(main.extents))
    lo, hi = main.bounds[0] - pad, main.bounds[1] + pad
    kept = [main] + [
        s for s in repaired[1:]
        if bool(np.all(s.bounds[1] >= lo) and np.all(s.bounds[0] <= hi))
    ]
    dropped = len(repaired) - len(kept)
    if dropped:
        print(f"repair: dropped {dropped} floating shell(s)")
    repaired = kept

    union = trimesh.boolean.union(repaired, engine="manifold") if len(repaired) > 1 else repaired[0]
    if not union.is_watertight:
        print("repair: union is not watertight", file=sys.stderr)
        return 1

    # Properly generated GLBs (full TRELLIS.2 pipeline) are standard glTF
    # Y-up: a deterministic Y-up → Z-up rotation is correct. (The pose-
    # guessing auto_orient heuristics proved unreliable and are retired.)
    union.apply_transform(_rot(90, [1, 0, 0]))
    # Final print placement: centered in XY, base on z=0.
    lo, hi = union.bounds
    union.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])

    union.export(dst)  # extension decides format; we pass .stl
    print(f"repair: {len(mesh.faces)} faces -> {len(union.faces)} faces, watertight, "
          f"{len(shells)} shells kept")
    return 0


if __name__ == "__main__":
    sys.exit(main())
