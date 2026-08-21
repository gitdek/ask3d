"""Textured statue GLB → multicolor 3MF for AMS printing.

Samples per-face colors from the baked texture, quantizes them to N
filament colors (k-means), splits the mesh into one object per color, and
writes a standard multi-object 3MF with basematerials — Bambu Studio maps
each object/color to an AMS slot.

Usage: python color3mf.py painted.glb output.3mf [n_colors] [height_mm]
"""

import sys
import zipfile

import numpy as np
import trimesh
from scipy.cluster.vq import kmeans2

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>"""


def face_colors(mesh: trimesh.Trimesh) -> np.ndarray:
    uv = np.asarray(mesh.visual.uv)
    img = np.asarray(mesh.visual.material.baseColorTexture.convert("RGB")).astype(float)
    h, w = img.shape[:2]
    px = np.clip((uv[:, 0] * (w - 1)).astype(int), 0, w - 1)
    py = np.clip(((1 - uv[:, 1]) * (h - 1)).astype(int), 0, h - 1)
    vertex_rgb = img[py, px]
    return vertex_rgb[np.asarray(mesh.faces)].mean(axis=1)  # per-face mean RGB


def mesh_xml(vertices: np.ndarray, faces: np.ndarray, object_id: int, pid: int, pindex: int) -> str:
    vs = "".join(f'<vertex x="{v[0]:.4f}" y="{v[1]:.4f}" z="{v[2]:.4f}"/>' for v in vertices)
    ts = "".join(f'<triangle v1="{f[0]}" v2="{f[1]}" v3="{f[2]}"/>' for f in faces)
    return (
        f'<object id="{object_id}" type="model" pid="{pid}" pindex="{pindex}">'
        f"<mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>"
    )


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    n_colors = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    height_mm = float(sys.argv[4]) if len(sys.argv) > 4 else 80.0

    mesh = trimesh.load(src, force="mesh")
    colors = face_colors(mesh)

    centroids, labels = kmeans2(colors, n_colors, minit="++", seed=7)
    print(f"palette: {[('#%02x%02x%02x' % tuple(int(x) for x in c)) for c in centroids]}")

    # Y-up glTF → Z-up print orientation, scaled and floored.
    work = trimesh.Trimesh(
        vertices=np.asarray(mesh.vertices), faces=np.asarray(mesh.faces), process=False
    )
    work.apply_transform(trimesh.transformations.rotation_matrix(np.radians(90), [1, 0, 0]))
    scale = height_mm / float(work.extents.max())
    work.apply_scale(scale)
    lo, hi = work.bounds
    work.apply_translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])

    materials = "".join(
        f'<base name="Color {i + 1}" displaycolor="#{int(c[0]):02x}{int(c[1]):02x}{int(c[2]):02x}"/>'
        for i, c in enumerate(centroids)
    )
    objects, items = [], []
    faces_all = np.asarray(work.faces)
    for i in range(n_colors):
        group = faces_all[labels == i]
        if len(group) == 0:
            continue
        used = np.unique(group)
        remap = np.zeros(used.max() + 1, dtype=np.int64)
        remap[used] = np.arange(len(used))
        object_id = 10 + i
        objects.append(mesh_xml(np.asarray(work.vertices)[used], remap[group], object_id, 2, i))
        items.append(f'<item objectid="{object_id}"/>')
        print(f"color {i + 1}: {len(group)} faces")

    model = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
        'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">'
        "<metadata name=\"Title\">colorstatue</metadata>"
        f'<resources><basematerials id="2">{materials}</basematerials>'
        f'{"".join(objects)}</resources>'
        f'<build>{"".join(items)}</build></model>'
    )

    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", model)
    print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
