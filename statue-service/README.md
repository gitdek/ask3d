# statue-service

The optional sidecar that turns photos of a real object into a printable mesh.

**ask3d works without this.** The chat, the compiler, the preview and the
exports need nothing here. This file is only about the photo → 3D button.

## Setup

```bash
./statue-service/setup.sh
```

About a minute, ~130 MB, and it works on **any machine** — Linux, Windows,
Intel Macs included. That gets you mesh repair and the cloud generators, which
need a free Hugging Face account for GPU quota:

```bash
statue-service/.venv/bin/hf auth login
```

### Unlimited, on-device (optional)

```bash
./statue-service/setup.sh --local-engine
```

Apple silicon only, and the weights are ~15 GB downloaded on your first
generation. In exchange it is unlimited, private, and needs no account. That is
why it is a separate flag rather than part of the clone: nobody who just wants
to describe a bracket should pay 15 GB for it, and it cannot run at all on a
machine without MLX.

The script is idempotent — run it again any time, it only does what is missing.
`./start.sh` picks up whichever engines exist and the app's header shows them.

## Which engine

| Engine | Needs | Limits |
|---|---|---|
| `space`, `hunyuan-space` (cloud) | `setup.sh` + a free HF account | ~2 generations/day |
| `hunyuan` (on-device) | `setup.sh --local-engine`, Apple silicon | none |

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
