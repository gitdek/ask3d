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
import random
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response

SERVICE_DIR = Path(__file__).resolve().parent
TRELLIS_DIR = SERVICE_DIR / "trellis-mac"
TRELLIS_PYTHON = TRELLIS_DIR / ".venv" / "bin" / "python"
HUNYUAN_DIR = SERVICE_DIR / "hunyuan-mlx"
HUNYUAN_PYTHON = HUNYUAN_DIR / ".venv" / "bin" / "python"
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
    summary = ""
    try:
        proc = subprocess.run(
            [str(TRELLIS_PYTHON), str(SERVICE_DIR / "repair.py"), str(glb_path), str(repaired_path)],
            capture_output=True,
            text=True,
            timeout=600,
        )
        failure = None if proc.returncode == 0 else (proc.stderr.strip()[-150:] or f"exit {proc.returncode}")
        summary = (proc.stdout.strip().splitlines() or ["repaired"])[-1]
    except subprocess.TimeoutExpired:
        failure = "repair timed out after 600s"
    except OSError as exc:  # e.g. the trellis venv is missing
        failure = str(exc)
    if failure is None and repaired_path.exists() and repaired_path.stat().st_size > 0:
        task["model_path"] = str(repaired_path)
        task["model_format"] = "stl"
        task["detail"] = summary
    else:
        # The statue still ships, but the app tells the user it may not be
        # watertight — a transient detail string used to be the only trace.
        task["repair_warning"] = failure or "repair produced no output"
        task["detail"] = f"mesh repair failed, serving unrepaired mesh: {task['repair_warning']}"


GENERATION_TIMEOUT_S = int(os.environ.get("STATUE_TASK_TIMEOUT", "3600"))


def run_generation(task_id: str, image_path: Path, out_base: Path) -> None:
    """Thread entry point. Whatever happens inside, the task ends in a
    terminal state: one stuck at "running" keeps the sidecar "busy" for
    every later request and the app polling forever."""
    task = tasks[task_id]
    task["status"] = "running"
    task["started_at"] = time.time()
    try:
        _generate(task, image_path, out_base)
    except Exception as exc:  # noqa: BLE001 — task boundary, report everything
        task["status"] = "failed"
        task["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        if task["status"] == "running":
            task["status"] = "failed"
            task.setdefault("error", "generation ended without a result")


def _generate(task: dict, image_path: Path, out_base: Path) -> None:
    if MOCK:
        time.sleep(3)
        glb_path = out_base.with_suffix(".glb")
        glb_path.write_bytes(make_mock_glb())
        task["model_path"] = str(glb_path)
        task["model_format"] = "glb"
        task["status"] = "succeeded"
        return

    # Modes:
    #   "space" (default): full TRELLIS.2 on the free HF ZeroGPU Space
    #     (~2 statues/day free quota, ~40s GPU each; needs `hf auth login`).
    #   "hunyuan" / "local": Hunyuan3D-2.1 via the native MLX port —
    #     unlimited, ~2 min/statue, near-Space quality. Needs a rembg
    #     cutout pre-step (the port does no background removal itself).
    #     Extra photos (back/left/right) switch to token-concat multiview
    #     conditioning — markedly better body mass/depth than one photo.
    #   "trellis": legacy trellis-mac on-device — erratic quality, kept
    #     for experiments only.
    mode = task.get("engine") or os.environ.get("STATUE_MODE", "space")
    cwd = TRELLIS_DIR
    cmd_for_seed = None  # set by engines that support seed re-rolls
    if mode == "space":
        task["detail"] = "generating on HF ZeroGPU (full TRELLIS.2)…"
        cmd = [
            str(TRELLIS_PYTHON),
            str(SERVICE_DIR / "space_generate.py"),
            str(image_path),
            str(out_base.parent),
        ]
    elif mode == "hunyuan-space":
        n = 1 + len(task.get("extra_images", []))
        task["detail"] = f"generating on HF ZeroGPU (Hunyuan3D-2.1, {n} photo{'s' if n > 1 else ''})…"
        cmd = [
            str(TRELLIS_PYTHON),
            str(SERVICE_DIR / "hunyuan_space_generate.py"),
            str(out_base.parent),
            f"front={image_path}",
            *(f"{Path(p).stem}={p}" for p in task.get("extra_images", [])),
        ]
    elif mode in ("hunyuan", "local"):
        # views: primary photo is "front"; extras carry their view in the
        # file stem (back/left/right, set by _save_upload). Multi-photo uses
        # the token-concat MV runner (see hunyuan_mv.py); STATUE_MV=0
        # disables it and falls back to front-photo-only.
        views = {"front": image_path}
        if os.environ.get("STATUE_MV", "1") != "0":
            for extra in task.get("extra_images", []):
                views[Path(extra).stem] = Path(extra)
        cutouts = {}
        for view, path in views.items():
            task["detail"] = f"removing background ({view})…"
            cutout_path = image_path.with_name(f"cutout-{view}.png")
            pre = subprocess.run(
                [str(HUNYUAN_PYTHON), str(SERVICE_DIR / "cutout.py"), str(path), str(cutout_path)],
                cwd=HUNYUAN_DIR, capture_output=True, text=True, timeout=300,
            )
            if pre.returncode != 0 or not cutout_path.exists():
                task["status"] = "failed"
                task["error"] = f"background removal failed ({view}): {pre.stderr.strip()[-200:]}"
                return
            cutouts[view] = cutout_path
        cwd = HUNYUAN_DIR
        # A fresh seed per task: retries of a hard photo should roll new
        # dice, not reproduce the same bad head. STATUE_HY_SEED pins the
        # first attempt; the seed is logged in the task detail either way.
        seed = int(os.environ.get("STATUE_HY_SEED") or random.randrange(1_000_000))
        task["seed"] = seed

        def build_hunyuan_cmd(seed: int) -> list:
            if len(cutouts) > 1:
                return [
                    str(HUNYUAN_PYTHON),
                    str(SERVICE_DIR / "hunyuan_generate_mv.py"),
                    str(out_base.with_suffix(".glb")),
                    *(f"{view}={path}" for view, path in cutouts.items()),
                    "--steps", os.environ.get("STATUE_HY_STEPS", "50"),
                    "--octree", os.environ.get("STATUE_HY_OCTREE", "1024"),
                    "--seed", str(seed),
                ]
            return [
                str(HUNYUAN_PYTHON),
                str(SERVICE_DIR / "hunyuan_generate.py"),
                str(cutouts["front"]),
                str(out_base.with_suffix(".glb")),
                os.environ.get("STATUE_HY_STEPS", "50"),
                os.environ.get("STATUE_HY_OCTREE", "1024"),
                "7.5",
                str(seed),
            ]

        cmd_for_seed = build_hunyuan_cmd
        cmd = build_hunyuan_cmd(seed)
        photos = f"{len(cutouts)} photos, " if len(cutouts) > 1 else ""
        octree = os.environ.get("STATUE_HY_OCTREE", "1024")
        task["octree"] = octree
        task["detail"] = f"generating with Hunyuan3D-2.1 (MLX, {photos}octree {octree}, seed {seed})…"
    else:
        # 32 sampler steps by default: the port's approximated compute paths
        # need more steps to converge than the upstream default of 12 —
        # at 12, thin structures come out as disconnected fragments.
        cmd = [
            str(TRELLIS_PYTHON),
            "generate.py",
            str(image_path),
            "--no-texture",
            "--pipeline-type",
            os.environ.get("STATUE_PIPELINE", "1024"),
            "--steps",
            os.environ.get("STATUE_STEPS", "32"),
            "--output",
            str(out_base),
        ]
    # Up to 3 attempts: hard photos card on ~half of all seeds, so one
    # re-roll still fails a quarter of tasks.
    for attempt in range(3):
        proc = subprocess.Popen(
            cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        task["pid"] = proc.pid
        # A wedged generator (stalled weight download, hung Metal kernel)
        # would otherwise hold the sidecar's single slot forever.
        timed_out = threading.Event()

        def _kill(p=proc, flag=timed_out):
            flag.set()
            p.kill()

        watchdog = threading.Timer(GENERATION_TIMEOUT_S, _kill)
        watchdog.daemon = True
        watchdog.start()
        try:
            for line in proc.stdout or []:
                line = line.rstrip()
                if line:
                    task["detail"] = line[-200:]
                    task.setdefault("log", []).append(line)
                    task["log"] = task["log"][-50:]
            proc.wait()
        finally:
            watchdog.cancel()
        if timed_out.is_set():
            task["status"] = "failed"
            task["error"] = (
                f"generator ran for more than {GENERATION_TIMEOUT_S // 60} minutes and was "
                "killed (STATUE_TASK_TIMEOUT raises the limit)"
            )
            return
        # Exit code 3 = the generator's flat-card guard: the seed
        # collapsed the subject into a sheet. One re-roll with fresh
        # dice usually recovers (validated: seed-dependent, not
        # subject-dependent).
        if proc.returncode == 3 and cmd_for_seed is not None and attempt < 2:
            seed = random.randrange(1_000_000)
            task["seed"] = seed
            task["detail"] = f"flat output detected — re-rolling seed ({seed})…"
            cmd = cmd_for_seed(seed)
            continue
        break
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


VALID_ENGINES = {"space", "hunyuan", "local", "trellis", "hunyuan-space"}


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "mock": MOCK,
        "default_engine": os.environ.get("STATUE_MODE", "space"),
        "engines": {
            "space": TRELLIS_PYTHON.exists(),
            "hunyuan": HUNYUAN_PYTHON.exists(),
        },
        "busy": busy_task() is not None,
    }


async def _save_upload(upload: UploadFile, task_dir: Path, name: str) -> Path:
    suffix = ".png" if (upload.filename or "").lower().endswith(".png") else ".jpg"
    path = task_dir / f"{name}{suffix}"
    path.write_bytes(await upload.read())
    return path


@app.post("/tasks")
async def create_task(
    request: Request,
    image: UploadFile,
    engine: str = Form(""),
    image_back: UploadFile | None = None,
    image_left: UploadFile | None = None,
    image_right: UploadFile | None = None,
) -> dict:
    # Browsers label cross-site requests, and CORS only stops a foreign page
    # from READING the reply — without this, any web page could start
    # generations on this machine. The app's /statue proxy arrives same-origin.
    site = request.headers.get("sec-fetch-site")
    if site not in (None, "same-origin", "none"):
        raise HTTPException(status_code=403, detail="cross-site request refused")
    requested = engine or os.environ.get("STATUE_MODE", "space")
    if requested not in VALID_ENGINES:
        raise HTTPException(status_code=400, detail=f"unknown engine '{requested}'")
    # Reserve the single generation slot under the lock, but receive the
    # uploads outside it: awaiting while holding a threading.Lock parks the
    # event loop for any second request, which then can never be released.
    with tasks_lock:
        if busy_task() is not None:
            raise HTTPException(status_code=409, detail="A statue is already being generated")
        needed = HUNYUAN_PYTHON if requested in ("hunyuan", "local") else TRELLIS_PYTHON
        if not MOCK and not needed.exists():
            raise HTTPException(
                status_code=503,
                detail=f"engine '{requested}' is not set up (missing {needed.parent.parent.name} venv)",
            )
        task_id = uuid.uuid4().hex[:12]
        tasks[task_id] = {
            "status": "queued",
            "created_at": time.time(),
            "detail": "receiving photos…",
            "engine": requested,
            "extra_images": [],
        }
    task_dir = WORK_DIR / task_id
    try:
        task_dir.mkdir(parents=True)
        image_path = await _save_upload(image, task_dir, "input")
        extra_paths = []
        for name, upload in (("back", image_back), ("left", image_left), ("right", image_right)):
            if upload is not None:
                extra_paths.append(str(await _save_upload(upload, task_dir, name)))
    except Exception as exc:  # noqa: BLE001 — release the slot whatever went wrong
        tasks[task_id]["status"] = "failed"
        tasks[task_id]["error"] = f"upload failed: {exc}"
        raise HTTPException(status_code=400, detail=f"upload failed: {exc}") from exc
    tasks[task_id]["extra_images"] = extra_paths
    tasks[task_id]["detail"] = "queued"
    thread = threading.Thread(
        target=run_generation, args=(task_id, image_path, task_dir / "statue"), daemon=True
    )
    thread.start()
    return {"id": task_id}


@app.get("/tasks-latest")
def latest_task() -> dict:
    if not tasks:
        raise HTTPException(status_code=404, detail="no tasks yet")
    task_id = max(tasks, key=lambda t: tasks[t]["created_at"])
    task = tasks[task_id]
    return {
        "id": task_id,
        "status": task["status"],
        "detail": task.get("detail", ""),
        "created_at": task["created_at"],
        "age_seconds": round(time.time() - task["created_at"]),
        "model_format": task.get("model_format"),
        "engine": task.get("engine"),
    }


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
        # Generation provenance — lets the app record how to reproduce it.
        "engine": task.get("engine"),
        "seed": task.get("seed"),
        "octree": task.get("octree"),
        "repair_warning": task.get("repair_warning"),
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
