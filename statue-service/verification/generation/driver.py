"""Explores the statue service's generation slot through its real entries.

server.py runs unchanged, in mock mode, which its invocation sets. POST
/tasks is create_task, held at the start of the worker it starts, so the
queued task is observed before run_generation runs. Finish releases that
worker, Download asks GET /tasks/{id}/model for the i-th task, and Idle
reads /health.
"""

from tempfile import SpooledTemporaryFile

from fastapi import UploadFile
from invariant_observe import Refusal, Step, explore, module
from starlette.requests import Request

import server as app

MaxTasks = 2


def busy(state):
    return any(s in ("queued", "running") for s in state["status"])


def start():
    app.tasks.clear()
    return module(app.run_generation, fields={"status": "tasks[*].status"},
                  expected_initial={"status": []}, timeout=20.0)


def photo():
    # An unrolled spooled file is read in memory, as a small upload is,
    # rather than on a thread of the server's pool.
    f = SpooledTemporaryFile()
    f.write(b"\x89PNG\r\n\x1a\n")
    f.seek(0)
    return UploadFile(f, filename="input.png")


def submit(life, state):
    if len(state["status"]) >= MaxTasks and not busy(state):
        return
    request = Request({"type": "http", "method": "POST", "path": "/tasks", "headers": []})
    after = state if busy(state) else {"status": state["status"] + ["queued"]}
    life.hold(app.create_task, request, photo(), engine="space",
              expected_before=state, expected_after=after)


def finish(life, state):
    after = {"status": ["succeeded" if s == "queued" else s for s in state["status"]]}
    life.release(expected_before=state, expected_after=after)


def download(life, state, i):
    ids = list(app.tasks)
    task_id = ids[i - 1] if i <= len(ids) else "absent"
    life.step(app.get_model, task_id, expected_before=state, expected_after=state)


def idle(life, state):
    life.step(app.health, expected_before=state, expected_after=state)


def drive():
    explore(start, [
        Step("Submit", submit, refusal=Refusal(app.HTTPException, status_code=409)),
        Step("Finish", finish),
        Step("Download", download, [[i] for i in range(1, MaxTasks + 1)],
             refusal=Refusal(app.HTTPException, status_code=404)),
        Step("Idle", idle),
    ])


if __name__ == "__main__":
    drive()
