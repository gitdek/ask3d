# Statue task delivery

Written by Invariant for [#27](https://github.com/gitdek/ask3d/issues/27): Check that a finished statue is delivered once and never replaces another.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/27#issuecomment-6757229637). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/StatueTask.tla`](.invariant/specs/StatueTask.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | The hook follows these lifecycle steps within two tasks and two mounts, with direct runs for each regression witness alongside random runs. |
| `DeliveredAtMostOnce` | invariant | Each task has at most one completed delivery callback across all mounts; rejected callbacks do not count. |
| `NamesNeverReplace` | invariant | Completed delivery callbacks for different tasks never use the same statue filename. |
| `OneTaskAtATime` | invariant | Within a mount, start and recovery never enter over in-flight work, and the running guard stays held through download and delivery. |
| `ClearBlocksFutureRecovery` | invariant | Clear prevents later recovery of its task, while work adopted before Clear may still invoke and complete delivery. |
| `ErrorsReleaseTheHook` | invariant | A start, task, download, delivery, or fifth consecutive poll failure settles with its error and releases the hook for another start. |
| `TypeOK` | invariant | The sidecar, mount, hook state, dismissal storage, and observation records stay within their declared types and bounds. |
| `CanSkipCompletedOnReload` | witness | A direct run completes a delivery without Clear, reloads, and observes recovery skip that freshly finished task. |
| `CanRecoverSecondStatue` | witness | A direct run delivers recovered task 1, then reloads and delivers recovered task 2 under a different filename. |
| `CanDeliverAfterClear` | witness | An already-adopted task can complete its delivery callback after Clear. |
| `CanRetryRejectedAfterReload` | witness | A direct run rejects a delivery, reloads, and successfully delivers the same task. |
| `CanRetryRejectedOnSamePage` | witness | A direct run rejects a fresh task delivery and retries it on the same page with its original filename. |
| `CanStartAfterError` | witness | After an error the hook can accept another start. |
| `ReplayCompletedTask` | bug | A mistaken recovery adopts a task whose delivery already completed and delivers it again. |
| `ReuseRecoveredName` | bug | A mistaken recovery gives two different recovered statues the same filename, replacing the first on delivery. |

Checked within `MaxMounts = 2`, `MaxTasks = 2`, `Names = {"source-statue-1.stl", "source-statue-2.stl", "recovered-statue-1.stl", "recovered-statue-2.stl"}`, `PollLimit = 5`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/05-statue-task-delivery
```
