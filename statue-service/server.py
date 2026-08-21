# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi", "uvicorn", "python-multipart"]
# ///
"""Local statue-generation sidecar for ask3d.

Wraps the trellis-mac (TRELLIS.2 on Apple Silicon) CLI behind a tiny task
API the web app can poll. One generation at a time — the model peaks around
18GB of unified memory.

Run:  uv run statue-service/server.py          (real mode; needs trellis-mac set up)
      STATUE_MOCK=1 uv run statue-service/server.py   (instant fake GLB, for testing)
"""

import base64
import json
import os
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

SERVICE_DIR = Path(__file__).resolve().parent
TRELLIS_DIR = SERVICE_DIR / "trellis-mac"
TRELLIS_PYTHON = TRELLIS_DIR / ".venv" / "bin" / "python"
MOCK = os.environ.get("STATUE_MOCK") == "1"
PORT = int(os.environ.get("STATUE_PORT", "8765"))
WORK_DIR = Path(tempfile.gettempdir()) / "ask3d-statue"
WORK_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

tasks: dict[str, dict] = {}
tasks_lock = threading.Lock()


def busy_task() -> str | None:
    for task_id, task in tasks.items():
        if task["status"] in ("queued", "running"):
            return task_id
    return None


def make_mock_glb() -> bytes:
    """Minimal valid GLB: a unit cube. Enough to exercise the whole
    convert-and-preview pipeline without the model installed."""
    positions = [
        (-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5),
        (-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5),
    ]
    indices = [
        0, 2, 1, 0, 3, 2,  # back
        4, 5, 6, 4, 6, 7,  # front
        0, 1, 5, 0, 5, 4,  # bottom
        3, 6, 2, 3, 7, 6,  # top
        0, 4, 7, 0, 7, 3,  # left
        1, 2, 6, 1, 6, 5,  # right
    ]
    pos_bytes = b"".join(struct.pack("<fff", *p) for p in positions)
    idx_bytes = b"".join(struct.pack("<H", i) for i in indices)
    if len(idx_bytes) % 4:
        idx_bytes += b"\x00" * (4 - len(idx_bytes) % 4)
    bin_chunk = pos_bytes + idx_bytes

    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(bin_chunk)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes)},
            {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(indices) * 2},
        ],
        "accessors": [
            {
                "bufferView": 0, "componentType": 5126, "count": len(positions),
                "type": "VEC3", "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5],
            },
            {"bufferView": 1, "componentType": 5123, "count": len(indices), "type": "SCALAR"},
        ],
    }
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode()
    if len(json_bytes) % 4:
        json_bytes += b" " * (4 - len(json_bytes) % 4)
    length = 12 + 8 + len(json_bytes) + 8 + len(bin_chunk)
    return (
        struct.pack("<III", 0x46546C67, 2, length)
        + struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
        + struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
    )


def repair_model(task: dict, glb_path: Path) -> None:
    """Make the mesh watertight and upright (TRELLIS output has open shells
    that OpenSCAD's Manifold backend silently drops from CSG, and sits in
    the input photo's camera frame). Emits print-oriented binary STL.
    Falls back to the unrepaired GLB if repair fails."""
    task["detail"] = "repairing mesh (watertight + upright)…"
    repaired_path = glb_path.with_name("statue-repaired.stl")
    proc = subprocess.run(
        [str(TRELLIS_PYTHON), str(SERVICE_DIR / "repair.py"), str(glb_path), str(repaired_path)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if proc.returncode == 0 and repaired_path.exists() and repaired_path.stat().st_size > 0:
        task["model_path"] = str(repaired_path)
        task["model_format"] = "stl"
        task["detail"] = (proc.stdout.strip().splitlines() or ["repaired"])[-1]
    else:
        task["detail"] = f"mesh repair failed, serving unrepaired mesh: {proc.stderr.strip()[-150:]}"


def run_generation(task_id: str, image_path: Path, out_base: Path) -> None:
    task = tasks[task_id]
    task["status"] = "running"
    task["started_at"] = time.time()

    if MOCK:
        time.sleep(3)
        glb_path = out_base.with_suffix(".glb")
        glb_path.write_bytes(make_mock_glb())
        task["model_path"] = str(glb_path)
        task["model_format"] = "glb"
        task["status"] = "succeeded"
        return

    # "space" (default): full TRELLIS.2 pipeline on the free HF ZeroGPU Space
    # (~5 GPU-min/day on a free account, ~40s per statue; needs `hf auth login`).
    # "local": trellis-mac on this machine — currently produces poor results
    # because its background-removal stage is broken; use only offline.
    if os.environ.get("STATUE_MODE", "space") == "space":
        task["detail"] = "generating on HF ZeroGPU (full TRELLIS.2)…"
        cmd = [
            str(TRELLIS_PYTHON),
            str(SERVICE_DIR / "space_generate.py"),
            str(image_path),
            str(out_base.parent),
        ]
    else:
        cmd = [
            str(TRELLIS_PYTHON),
            "generate.py",
            str(image_path),
            "--no-texture",
            "--pipeline-type",
            os.environ.get("STATUE_PIPELINE", "1024"),
            "--output",
            str(out_base),
        ]
    try:
        proc = subprocess.Popen(
            cmd, cwd=TRELLIS_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        task["pid"] = proc.pid
        for line in proc.stdout or []:
            line = line.rstrip()
            if line:
                task["detail"] = line[-200:]
                task.setdefault("log", []).append(line)
                task["log"] = task["log"][-50:]
        proc.wait()
        if proc.returncode != 0:
            task["status"] = "failed"
            task["error"] = f"generator exited with code {proc.returncode}: " + "\n".join(
                task.get("log", [])[-8:]
            )
            return
        for ext, fmt in ((".glb", "glb"), (".obj", "obj")):
            candidate = out_base.with_suffix(ext)
            if candidate.exists() and candidate.stat().st_size > 0:
                task["model_path"] = str(candidate)
                task["model_format"] = fmt
                if fmt == "glb":
                    repair_model(task, candidate)
                task["status"] = "succeeded"
                return
        task["status"] = "failed"
        task["error"] = "generator finished but produced no .glb/.obj output"
    except Exception as exc:  # noqa: BLE001 — task boundary, report everything
        task["status"] = "failed"
        task["error"] = str(exc)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "mock": MOCK,
        "model_ready": MOCK or TRELLIS_PYTHON.exists(),
        "busy": busy_task() is not None,
    }


@app.post("/tasks")
async def create_task(image: UploadFile) -> dict:
    with tasks_lock:
        if busy_task() is not None:
            raise HTTPException(status_code=409, detail="A statue is already being generated")
        if not MOCK and not TRELLIS_PYTHON.exists():
            raise HTTPException(
                status_code=503,
                detail="trellis-mac is not set up — run `bash setup.sh` in statue-service/trellis-mac",
            )
        task_id = uuid.uuid4().hex[:12]
        task_dir = WORK_DIR / task_id
        task_dir.mkdir(parents=True)
        suffix = ".png" if (image.filename or "").lower().endswith(".png") else ".jpg"
        image_path = task_dir / f"input{suffix}"
        image_path.write_bytes(await image.read())
        tasks[task_id] = {"status": "queued", "created_at": time.time(), "detail": "queued"}
    thread = threading.Thread(
        target=run_generation, args=(task_id, image_path, task_dir / "statue"), daemon=True
    )
    thread.start()
    return {"id": task_id}


@app.get("/tasks/{task_id}")
def get_task(task_id: str) -> dict:
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="unknown task")
    elapsed = time.time() - task.get("started_at", task["created_at"])
    return {
        "status": task["status"],
        "detail": task.get("detail", ""),
        "elapsed_seconds": round(elapsed),
        "model_format": task.get("model_format"),
        "error": task.get("error"),
    }


@app.get("/tasks/{task_id}/model")
def get_model(task_id: str) -> Response:
    task = tasks.get(task_id)
    if task is None or task["status"] != "succeeded":
        raise HTTPException(status_code=404, detail="no model for this task")
    media = {
        "glb": "model/gltf-binary",
        "stl": "application/octet-stream",
        "obj": "text/plain",
    }.get(task["model_format"], "application/octet-stream")
    return FileResponse(task["model_path"], media_type=media)


if __name__ == "__main__":
    print(f"ask3d statue service on http://127.0.0.1:{PORT}  (mock={MOCK})")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
