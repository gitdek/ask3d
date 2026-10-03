#!/usr/bin/env bash
# Sets up photo → 3D model generation.
#
#   ./setup.sh                  mesh repair + cloud generation (any machine)
#   ./setup.sh --local-engine   also install the unlimited on-device engine
#                               (Apple silicon only, ~15 GB of weights)
set -euo pipefail
cd "$(dirname "$0")"

LOCAL_ENGINE=0
for arg in "$@"; do
  case "$arg" in
    --local-engine) LOCAL_ENGINE=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. the sidecar's own environment -------------------------------------
# This alone is enough for mesh repair and for the cloud engines, on any OS.
if [[ -x .venv/bin/python ]]; then
  echo "✓ sidecar environment already present"
else
  echo "… creating the sidecar environment (small, ~1 min)"
  if have uv; then
    uv venv .venv >/dev/null
  else
    python3 -m venv .venv
  fi
  if have uv; then
    uv pip install --python .venv/bin/python -r requirements.txt >/dev/null
  else
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r requirements.txt
  fi
  echo "✓ sidecar environment ready"
fi

.venv/bin/python - <<'CHECK'
import sys
missing = []
for m in ("numpy", "trimesh", "pymeshfix", "manifold3d", "gradio_client"):
    try:
        __import__(m)
    except Exception:
        missing.append(m)
if missing:
    sys.exit("✗ missing after install: " + ", ".join(missing))
print("✓ mesh repair and cloud generation are ready")
CHECK

# --- 2. the optional on-device engine -------------------------------------
if [[ $LOCAL_ENGINE == 0 ]]; then
  cat <<'NEXT'

Done. Photo → 3D works now through the cloud engines, which need a free
Hugging Face account:

    .venv/bin/hf auth login

For unlimited on-device generation (Apple silicon, ~15 GB):

    ./setup.sh --local-engine
NEXT
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "✗ the on-device engine is an MLX port: Apple silicon only." >&2
  echo "  Your sidecar is still set up — use the cloud engines instead." >&2
  exit 1
fi
if ! have git; then echo "✗ git is required" >&2; exit 1; fi

PY312="$(command -v python3.12 || true)"
if [[ -z $PY312 ]]; then
  echo "✗ python3.12 not found (brew install python@3.12)" >&2
  exit 1
fi

if [[ ! -d hunyuan-mlx ]]; then
  echo "… cloning the Hunyuan3D-2.1 MLX port"
  git clone --depth 1 https://github.com/dgrauet/Hunyuan3D-2.1-mlx hunyuan-mlx
fi
if [[ ! -x hunyuan-mlx/.venv/bin/python ]]; then
  echo "… creating its environment (this is the slow part)"
  "$PY312" -m venv hunyuan-mlx/.venv
fi
echo "… installing the engine and the extras ask3d needs on top of it"
hunyuan-mlx/.venv/bin/pip install --quiet --upgrade pip
[[ -f hunyuan-mlx/requirements.txt ]] && hunyuan-mlx/.venv/bin/pip install --quiet -r hunyuan-mlx/requirements.txt
# rembg: the port composites on white and would otherwise rebuild your kitchen.
hunyuan-mlx/.venv/bin/pip install --quiet rembg onnxruntime pymeshlab opencv-python-headless trimesh

cat <<'DONE'

✓ on-device engine installed.
  The ~15 GB of weights download on your first generation, so expect that
  one to take a while. Pick "statues: local" in the app's header.
DONE
