"""Shaded front/back renders of a statue mesh for fair comparison against
Meshy's studio screenshots. Decimates, then matplotlib trisurf with a
neutral gray material on dark ground.

Usage: python compare_render.py mesh.(glb|stl) out.png "title"
"""

import sys

import numpy as np
import trimesh
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402

try:
    import fast_simplification
except ImportError:
    fast_simplification = None


def load_welded(path: str) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="mesh")
    mesh = trimesh.Trimesh(
        vertices=np.asarray(loaded.vertices), faces=np.asarray(loaded.faces), process=False
    )
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    return mesh


def render(mesh: trimesh.Trimesh, out_path: str, title: str) -> None:
    if fast_simplification is not None and len(mesh.faces) > 60000:
        v, f = fast_simplification.simplify(
            np.asarray(mesh.vertices, np.float32), np.asarray(mesh.faces, np.int32),
            target_count=60000,
        )
        mesh = trimesh.Trimesh(v, f)

    v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    center = (v.max(axis=0) + v.min(axis=0)) / 2
    v = v - center

    tris = v[f]
    normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    norms = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = normals / np.maximum(norms, 1e-12)

    fig = plt.figure(figsize=(12, 6.5), dpi=110, facecolor="#26282b")
    light = np.array([0.3, 0.5, 0.85])
    light = light / np.linalg.norm(light)
    for i, (label, flip) in enumerate([("front", 1.0), ("back", -1.0)]):
        ax = fig.add_subplot(1, 2, i + 1, projection="3d", facecolor="#26282b")
        shade = np.clip(np.abs(normals @ (light * np.array([flip, flip, 1]))), 0.08, 1)
        colors = np.stack([0.16 + 0.72 * shade] * 3 + [np.ones_like(shade)], axis=1)
        order = np.argsort(flip * tris[:, :, 1].mean(axis=1))
        pc = Poly3DCollection(tris[order][:, :, [0, 2, 1]], facecolors=colors[order], edgecolors="none")
        ax.add_collection3d(pc)
        r = float(np.abs(v).max()) * 1.05
        ax.set_xlim(-r, r); ax.set_ylim(-r, r); ax.set_zlim(-r, r)
        ax.view_init(elev=12, azim=-90 if flip > 0 else 90)
        ax.set_title(f"{title} — {label}", color="#dddddd")
        ax.axis("off")
        ax.set_box_aspect((1, 1, 1))
    plt.tight_layout()
    plt.savefig(out_path, facecolor="#26282b")
    print(f"saved {out_path}")


if __name__ == "__main__":
    render(load_welded(sys.argv[1]), sys.argv[2], sys.argv[3])
