# ask3d

Describe a physical object in a chatbot and get a 3D-printable model: an LLM
writes OpenSCAD code, the browser compiles it to STL with OpenSCAD's
WebAssembly build, a three.js pane shows a print-style preview, and a button
downloads the STL. Refine conversationally ("make the hole bigger"). Compile
errors are fed back to the model automatically (max 2 repair attempts).

## Setup

```bash
npm install
cp .env.local.example .env.local
```

Add an API key to `.env.local`. The default provider is Google Gemini — a
free API key with no credit card at <https://aistudio.google.com>:

```
AI_PROVIDER=google
AI_MODEL=gemini-3.7-flash
GOOGLE_GENERATIVE_AI_API_KEY=your-key
```

Also wired: OpenRouter (`AI_PROVIDER=openrouter`, e.g. `AI_MODEL=z-ai/glm-5.2:free`)
and Anthropic (`AI_PROVIDER=anthropic`, e.g. `AI_MODEL=claude-sonnet-5`).
Set the matching `*_API_KEY` and restart.

```bash
./start.sh        # web app + statue sidecar, opens http://localhost:3000
./start.sh --lan  # also reachable from other devices on your Wi-Fi
./start.sh stop   # shut both down, running generators included (also: status, logs)
```

Or run the pieces by hand:

```bash
npm run dev     # http://localhost:3000 (loopback only; npm run dev:lan for the LAN)
npm test        # unit tests (fence extraction, lint, stderr parsing, 3MF)
```

Requires Node >= 22.

There is no login: anyone who can reach the server can spend your API key
and use the library, so the dev server listens on loopback unless you ask
for `--lan`. In `--lan` mode the phone's browser sees this machine's LAN
address as the host, and Next blocks its own dev resources for any host it
wasn't started with — a blocked HMR socket leaves the page drawn but never
hydrated, every button dead. `next.config.ts` therefore allows this
machine's own addresses (read live, since DHCP reassigns them);
`ASK3D_ALLOWED_HOSTS` adds more. Either way, `proxy.ts` refuses browser requests that didn't
come from the app's own page (cross-site POSTs from another tab, DNS
rebinding), and the statue sidecar is reached only through the app's
`/statue/*` proxy, never directly.

## How it works

```
chat (Vercel AI SDK v7, streaming) ──▶ last ```openscad fence
        ▲                                    │ lint (no include/use/text/import)
        │ [auto-repair] message              ▼
        └── compile errors ◀── openscad-wasm (Web Worker, Manifold, binary STL)
                                             │
                                             ▼
                              three.js preview (r3f) + STL download
```

- `workers/openscad-worker.ts` — compiles in a Web Worker; fresh instance per
  render; 60s timeout via `worker.terminate()`.
- `components/app-shell.tsx` — owns the chat → extract → lint → compile →
  preview → repair state machine.
- `lib/ai/registry.ts` — provider registry; swap LLMs via `AI_PROVIDER`/`AI_MODEL`.

## OpenSCAD binaries

`public/openscad/` contains the **unmodified** official OpenSCAD WebAssembly
snapshot (`OpenSCAD-2026.01.02.wasm30346-WebAssembly-web.zip` from
<https://files.openscad.org/snapshots/>), loaded at runtime by the worker.
OpenSCAD is GPL-2.0-or-later — see `public/openscad/NOTICE.txt`. Nightly
snapshots have no semver stability; to upgrade, pin a new zip deliberately and
re-test.

## Uploads

The `+` button attaches files to the conversation:

- **`.stl` mesh** — written into the compiler's virtual FS; the model
  references it via `import("/uploads/<name>.stl")` (with its measured
  bounding box) and can mount, cut, extend, or engrave around it.
- **Photo (PNG/JPEG/WebP)** — converted in-browser to a `surface()`
  heightmap (`/uploads/<name>.dat`, 0–8mm, bright = high) for relief
  plaques and lithophane-style prints; a downscaled copy is also attached
  to the chat so a multimodal model can see the image.
- **`.scad` source** — injected into the conversation for the model to
  modify directly.

The lint whitelist only permits `import()`/`surface()` of uploaded paths.

## Statues (photo → full 3D model, free)

A **statue** button on photo chips generates a true 3D model from the
photo using Microsoft's TRELLIS.2-4B. The sidecar's default mode
(`STATUE_MODE=space`) runs the **full pipeline on Hugging Face's free
ZeroGPU** via the `microsoft/TRELLIS.2` Space — ~40s of GPU per statue,
about 2 statues/day on a free account's quota (each pipeline stage
reserves 120s against the ~5-minute daily allowance).

**`STATUE_MODE=hunyuan` (alias `local`) is the unlimited local engine:**
Hunyuan3D-2.1 via the native MLX port
([dgrauet/Hunyuan3D-2.1-mlx](https://github.com/dgrauet/Hunyuan3D-2.1-mlx),
vendored under `statue-service/hunyuan-mlx/`, gitignored). ~2 min per
statue on an M-series Mac, near-watertight output, quality within
striking distance of paid services (A/B-tested: `octree 512 / 50 steps`
is the sweet spot — set via `STATUE_HY_OCTREE` / `STATUE_HY_STEPS`). A
rembg cutout pre-step runs automatically — the port does no background
removal itself and reconstructs backgrounds verbatim without it.

Every task rolls a fresh random seed (`STATUE_HY_SEED` pins it; the task
detail logs it). This matters: hard photos are seed roulette — the same
image can yield a clean statue, a garbled head, or collapse entirely
into a flat card depending on the noise draw. The generator detects the
flat-card failure (min/max bounding extent ratio < 0.05) and the sidecar
automatically re-rolls up to twice, so a retry means new dice rather
than the same failure reproduced.

The local engine also does **multi-photo statues** (attach 2–4 photos;
extra views land in front/left/back/right order): extra photos switch it
to token-concat multiview conditioning (`hunyuan_generate_mv.py`), which
A/B-decisively fixes the body mass and depth a single front photo forces
the model to hallucinate. Honest caveat: no true multiview weights exist
for Hunyuan3D-2.1 (Tencent's `Hunyuan3D-2mv` is a different 2.0-era
architecture), so this concatenates all views' DINO tokens without view
identity — the faithful MV recipe (sincos view embeddings) makes the
single-view checkpoint denoise to an empty SDF and is kept behind
`--view-embed` for future MV-trained weights. Consequences: the output's
compass orientation is arbitrary (harmless — repair fixes upright), and
contradictory views blur rather than override each other. Disable with
`STATUE_MV=0`. `STATUE_MODE=local` uses
[trellis-mac](https://github.com/shivampkumar/trellis-mac) on-device
(vendored under `statue-service/trellis-mac/`, gitignored) — offline and
unlimited, but its output is markedly blobbier than the full pipeline:
the port's preprocessing is fine (verified — clean subject cutout), but
its replaced compute stages (padded SDPA attention, pure-Python mesh
extraction, disabled hole filling) deterministically degrade geometry,
and its GLBs sit in the input photo's camera frame rather than glTF
Y-up. Results are erratically subject-dependent: at the upstream default
of 12 sampler steps thin radial subjects fragment entirely while chunky
subjects come out blobby-but-coherent; at 32 steps (`STATUE_STEPS`, the
default here) thin subjects converge but chunky subjects can collapse
into hollow shells. No setting wins across subjects — treat local mode
as experimental and watch the port's upstream before trusting it.

One-time setup (the env is created by `bash setup.sh`; already done if
`statue-service/trellis-mac/.venv` exists), plus HuggingFace access for
the gated weights:

```bash
cd statue-service/trellis-mac
.venv/bin/hf auth login   # paste a HuggingFace read token
```

Then request access (instant) to both gated models while logged into
huggingface.co: `facebook/dinov3-vitl16-pretrain-lvd1689m` and
`briaai/RMBG-2.0`. First generation downloads ~15GB of weights.

Run the sidecar alongside `npm run dev`:

```bash
uv run statue-service/server.py
```

(`STATUE_MOCK=1 uv run statue-service/server.py` serves an instant fake
model for testing the pipeline without the weights.) The browser talks
to it through the app's own origin (`/statue/*`, rewritten in
`next.config.ts`; `STATUE_SERVICE_URL` points elsewhere), so a phone on
the LAN can make statues too. A generation that runs past
`STATUE_TASK_TIMEOUT` (default 60 minutes) is killed rather than holding
the sidecar's single slot forever, and any crash inside the worker ends
the task as failed instead of leaving it "running".

The generated GLB is converted in-browser to a print-ready binary STL
(Y-up→Z-up, scaled to 80mm max dimension, floored to Z=0), previewed
immediately, and added as an uploaded mesh so the chat can build around
it with `import()`. Licensing: TRELLIS.2 weights MIT; DINOv3 is Meta's
gated license; RMBG-2.0 background removal is CC BY-NC (personal use).

## Known limits

- No `include`/`use` (no OpenSCAD libraries in the wasm build) — the
  system prompt forbids them and a pre-compile lint catches violations.
  `text()` IS supported (DejaVu Sans regular/bold, vendored under
  `public/openscad/fonts/` and installed into the compiler's virtual FS).
  `import()`/`surface()` work only with uploaded files.
- Exports: binary STL, plus 3MF (Bambu Studio's native format) built
  client-side in `lib/threemf.ts` — the wasm build's own 3MF writer is
  broken (lib3mf signature mismatch), so don't re-enable it without
  testing. 3MFs embed Bambu per-object print settings; Bambu Studio only
  reads them via File → Open as a fresh project (drag-import strips
  foreign config with an "invalid config" note — geometry still loads).
- The Library (header button) is a shared store on the server's disk
  (`.library/`, gitignored): photos you attach, generated statues, and
  compiled models are captured with their prompts/provenance and visible
  from every browser that uses this instance. Old per-browser libraries
  migrate up automatically on first load. After File -> Open of an
  exported 3MF in Bambu Studio, glance at the filament slot — project
  imports can leave it blank, which slices at crawl-speed defaults.
- Multi-color (AMS): ask for colors in chat ("plates midnight blue,
  letters gold") and the model structures the program into per-color
  modules (`// COLORS:` convention, `lib/scad/colors.ts`); the app
  re-renders each color group in the background (the 3MF button reads
  "3MF · colors…" until they're in, then "3MF · N colors"), tints the 3D
  preview per color, and the 3MF then exports one object per color with
  display colors and extruder assignments — Bambu Studio maps them to
  AMS slots on import. The STL download stays single-body.
- A successful compile can still carry OpenSCAD warnings (geometry
  silently dropped, a non-manifold shape); they show as a "⚠ N compiler
  warnings" chip in the viewer — hover for the lines.
- Floating-fragment detection (a cut that severed a piece into mid-air)
  triggers an automatic repair round; separate parts standing on the
  plate are treated as deliberate multi-part prints and left alone.
- Heavy models hit a 60s compile timeout; the error panel offers a
  one-click retry with a 5-minute limit.
- Attached photos ride only on the most recent message that has files
  (older file parts are trimmed in the chat transport) and are downscaled
  to ≤512px.
- Statue meshes are repaired in the sidecar (`statue-service/repair.py`):
  position-weld (textured GLBs shatter into phantom components at UV
  seams), per-shell pymeshfix, manifold union, debris dropped, then a
  deterministic Y-up→Z-up print orientation. Without this, OpenSCAD's
  Manifold backend silently drops the statue from any CSG combine. Thin
  features (tails, ears) may still need thickening before printing.
- Single-photo statues hallucinate the unseen side; a top-down photo
  gives the model almost nothing of the face. Eye-level, plain-background
  photos produce far better heads.
- The build plate and prompt target a Bambu Lab A1 (256×256×256mm).
