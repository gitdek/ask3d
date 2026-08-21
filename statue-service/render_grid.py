"""Grid render: N meshes (rows) x 4 yaw angles (columns), shared shading
with compare_render.py. For A/B judging of statue geometry.

Usage: python render_grid.py out.png "label1=mesh1.glb" "label2=mesh2.glb" ...
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

YAWS = [0, 90, 180, 270]


def load_welded(path: str) -> trimesh.Trimesh:
    loaded = trimesh.load(path, force="mesh")
    mesh = trimesh.Trimesh(
        vertices=np.asarray(loaded.vertices), faces=np.asarray(loaded.faces), process=False
    )
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    if fast_simplification is not None and len(mesh.faces) > 60000:
        v, f = fast_simplification.simplify(
            np.asarray(mesh.vertices, np.float32), np.asarray(mesh.faces, np.int32),
            target_count=60000,
        )
        mesh = trimesh.Trimesh(v, f)
    return mesh


def main() -> int:
    out_path = sys.argv[1]
    rows = [a.split("=", 1) for a in sys.argv[2:]]
    fig = plt.figure(figsize=(4 * len(YAWS), 4.3 * len(rows)), dpi=100, facecolor="#26282b")
    light = np.array([0.3, 0.5, 0.85])
    light = light / np.linalg.norm(light)

    for r, (label, path) in enumerate(rows):
        mesh = load_welded(path)
        v, f = np.asarray(mesh.vertices), np.asarray(mesh.faces)
        v = v - (v.max(axis=0) + v.min(axis=0)) / 2
        radius = float(np.abs(v).max()) * 1.05
        for c, yaw in enumerate(YAWS):
            ax = fig.add_subplot(len(rows), len(YAWS), r * len(YAWS) + c + 1,
                                 projection="3d", facecolor="#26282b")
            tris = v[f]
            normals = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
            # rotate the light with the view so shading stays legible
            a = np.radians(yaw)
            lv = light @ np.array([[np.cos(a), np.sin(a), 0], [-np.sin(a), np.cos(a), 0], [0, 0, 1]])
            shade = np.clip(np.abs(normals @ lv), 0.08, 1)
            colors = np.stack([0.16 + 0.72 * shade] * 3 + [np.ones_like(shade)], axis=1)
            # painter's sort along the view direction for correct occlusion
            vd = np.array([np.sin(a), -np.cos(a), 0.2])
            order = np.argsort(tris.mean(axis=1) @ vd)
            pc = Poly3DCollection(tris[order][:, :, [0, 2, 1]], facecolors=colors[order],
                                  edgecolors="none")
            ax.add_collection3d(pc)
            ax.set_xlim(-radius, radius); ax.set_ylim(-radius, radius); ax.set_zlim(-radius, radius)
            ax.view_init(elev=12, azim=-90 + yaw)
            if c == 0:
                ax.set_title(label, color="#dddddd", loc="left", fontsize=13)
            ax.axis("off")
            ax.set_box_aspect((1, 1, 1))

    plt.tight_layout()
    plt.savefig(out_path, facecolor="#26282b")
    print(f"saved {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
