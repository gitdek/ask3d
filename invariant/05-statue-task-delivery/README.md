# Statue task delivery

Written by Invariant for [#27](https://github.com/gitdek/ask3d/issues/27): Check that a finished statue is delivered once and never replaces another.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/27#issuecomment-6753174817). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/StatueTask.tla`](.invariant/specs/StatueTask.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | The hook follows these lifecycle steps across at most two tasks and two page mounts. |
| `DeliveredAtMostOnce` | invariant | Each task has at most one completed delivery callback across all mounts; rejected callbacks do not count. |
| `NamesNeverReplace` | invariant | Completed delivery callbacks for different tasks never use the same statue filename. |
| `OneTaskAtATime` | invariant | Within a mount, start and recovery never enter over in-flight work, and the running guard stays held through download and delivery. |
| `ClearBlocksFutureRecovery` | invariant | Clear prevents later recovery of its task, while work adopted before Clear may still invoke and complete delivery. |
| `ErrorsReleaseTheHook` | invariant | A start, task, download, delivery, or fifth consecutive poll failure settles with its error and releases the hook for another start. |
| `TypeOK` | invariant | The sidecar, mount, hook state, dismissal storage, and observation records stay within their declared types and bounds. |
| `CanDeliver` | witness | A successful task can complete its delivery callback. |
| `CanDeliverAfterClear` | witness | An already-adopted task can complete its delivery callback after Clear. |
| `CanRetryRejectedDelivery` | witness | A rejected delivery can later complete for the same task using the same filename. |
| `CanStartAfterError` | witness | After an error the hook can accept another start. |
| `ReplayCompletedTask` | bug | After a reload the unchanged hook recovers a previously delivered task and completes its delivery callback again. |
| `ReuseRecoveredName` | bug | The unchanged hook completes a recovered task under recovered-statue.stl after a different task was delivered under that name. |

Checked within `MaxMounts = 2`, `MaxTasks = 2`, `Names = {"source-statue.stl", "recovered-statue.stl"}`, `PollLimit = 5`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/05-statue-task-delivery
```
