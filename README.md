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
npm run dev     # http://localhost:3000
npm test        # unit tests (fence extraction, lint, stderr parsing)
```

Requires Node >= 22.

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

## Statues (photo → full 3D model, free & local)

A **statue** button on photo chips generates a true 3D model from the
photo using Microsoft's TRELLIS.2-4B running locally on Apple Silicon
([trellis-mac](https://github.com/shivampkumar/trellis-mac), vendored
under `statue-service/trellis-mac/`, gitignored). No API costs; ~5 min
per statue; ~18GB peak unified memory.

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
model for testing the pipeline without the weights.)

The generated GLB is converted in-browser to a print-ready binary STL
(Y-up→Z-up, scaled to 80mm max dimension, floored to Z=0), previewed
immediately, and added as an uploaded mesh so the chat can build around
it with `import()`. Licensing: TRELLIS.2 weights MIT; DINOv3 is Meta's
gated license; RMBG-2.0 background removal is CC BY-NC (personal use).

## Known v1 limits

- No `text()`, `include`, or `use` in generated models (no fonts or
  libraries in the bare wasm build) — the system prompt forbids them and a
  pre-compile lint catches violations. `import()`/`surface()` work only
  with uploaded files.
- STL export only (3MF later).
- Very heavy models (high-res `minkowski`, huge `$fn`) hit the 60s compile
  timeout by design.
- Attached photos are re-sent with the whole history each turn (data
  URLs); they are downscaled to ≤512px to keep payloads small.
