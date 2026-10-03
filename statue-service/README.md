# statue-service

The optional sidecar that turns photos of a real object into a printable mesh.

**You do not need this to use ask3d.** The chat, the OpenSCAD compiler, the
preview and the exports all work without it. Skip this file unless you want the
photo → 3D model button.

It is a separate install because the model weights are ~15 GB and the engine is
Apple-silicon only, so bundling it would make a clone unusable for everyone who
just wants to describe a bracket.

## What you need

- An Apple-silicon Mac (the local engine is an MLX port; there is no CUDA path)
- ~20 GB of disk for weights
- [`uv`](https://docs.astral.sh/uv/) for the sidecar itself: `brew install uv`

## Install the local engine

```bash
cd statue-service
git clone https://github.com/dgrauet/Hunyuan3D-2.1-mlx hunyuan-mlx
cd hunyuan-mlx
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install rembg onnxruntime pymeshlab opencv-python-headless trimesh
```

The last line adds what ask3d needs on top of the port itself: `rembg` for
background removal (the port composites on white and will otherwise reconstruct
your kitchen), and `pymeshlab`/`trimesh` for the repair pass.

Weights download on the first generation, so expect that run to take a while.

`./start.sh` launches the sidecar automatically once `hunyuan-mlx/.venv` exists.
The app's engine picker will show the local engine as available.

## How ask3d uses it

```
photo(s) ──▶ rembg cutout ──▶ Hunyuan3D-2.1 ──▶ repair.py ──▶ printable STL
```

`repair.py` is not optional polish. Generated meshes arrive with open shells and
debris, and OpenSCAD's Manifold backend silently drops open meshes from any
boolean — so an unrepaired statue vanishes from a CSG combine while the compile
still reports success. The repair pass welds vertices by position, closes each
shell, drops debris, and orients the result upright and floored for printing.

**Multiple photos.** Attach two to four views of the same object and press
*Sculpt 3D* on the one you want as the front; the rest are concatenated into the
conditioning as extra angles. This measurably fixes the body mass and depth that
a single front photo forces the model to invent. There are no true multi-view
weights for this checkpoint, so the views carry no camera identity — the output's
compass orientation is arbitrary (harmless, the repair pass fixes upright) and
contradictory views blur rather than override one another.

**Seeds.** Hard photos are a dice roll: the same image can give a clean model, a
garbled one, or collapse into a flat card. Every task rolls a fresh seed, the
generator detects the flat-card failure, and the sidecar re-rolls up to twice.
`STATUE_HY_SEED` pins it if you want to reproduce one.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `STATUE_MODE` | `space` | `hunyuan` / `local` for the on-device engine |
| `STATUE_HY_STEPS` | `50` | Sampler steps |
| `STATUE_HY_OCTREE` | `1024` | Mesh resolution; 512 is faster and softer |
| `STATUE_HY_SEED` | random | Pin the noise draw |
| `STATUE_MV` | `1` | `0` disables multi-photo conditioning |
| `STATUE_MAX_FACES` | `200000` | Decimation target after repair |
| `STATUE_TASK_TIMEOUT` | `3600` | Seconds before a wedged generator is killed |
| `STATUE_MOCK` | — | `1` serves an instant fake mesh, for testing the pipeline |

## Cloud engines

`STATUE_MODE=space` and `hunyuan-space` drive Hugging Face Spaces instead, which
needs a token (`hf auth login`) and is limited to roughly two generations a day
on a free account. The local engine is unlimited and generally better; the cloud
paths exist for machines that cannot run the model.

## Licensing

The model weights are not ask3d's to relicense and are **not** all permissive —
check Hunyuan3D-2.1's terms before using output commercially. `rembg`'s default
model is CC BY-NC.
