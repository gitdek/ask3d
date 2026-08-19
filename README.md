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

## Known v1 limits

- No `text()`, `include`, `use`, or `import()` in generated models (no fonts
  or libraries in the bare wasm build) — the system prompt forbids them and a
  pre-compile lint catches violations.
- STL export only (3MF later).
- Very heavy models (high-res `minkowski`, huge `$fn`) hit the 60s compile
  timeout by design.
