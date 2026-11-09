# OpenSCAD compile ownership

Written by Invariant for [#16](https://github.com/gitdek/ask3d/issues/16): Check that the compiler only ever applies its latest compile.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/16#issuecomment-6750048506). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/OpenScadCompiler.tla`](.invariant/specs/OpenScadCompiler.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | The hook starts idle and follows the bounded compile, cancel and callback steps. |
| `LatestOutcomeOnly` | invariant | Only the current compile may write an outcome to status, result or failure, while a previously committed result may remain visible. |
| `WorkerLifecycle` | invariant | The old worker is terminated before its replacement is created, at most one worker is ever alive, and none remains when compiling stops. |
| `SingleEndAndTimerCleared` | invariant | A compile ends at most once, and every done, error or timeout outcome clears its timer. |
| `CancelStaysIdle` | invariant | After cancel, the hook stays idle with no worker, timer or newly applied outcome until another compile starts. |
| `TypeOK` | invariant | Hook state and driver observations stay within two compiles, one cancel and one timer dispatch. |
| `LatestCanSucceed` | witness | A second compile can succeed while an older compile still has a stale callback available. |
| `CanFailAfterCancel` | witness | A compile started after a cancel can finish with an error. |
| `CanTimeOut` | witness | A compile can finish with a timeout. |
| `UnreplacedEventuallyEnds` | property | Every compile eventually ends exactly once with done, error or timeout unless another compile or cancel replaces it. |
| `DispatchProgress` | fairness | The driver's scheduler eventually dispatches a terminal callback that remains enabled for the current compile. |
| `BugAcceptStale` | bug | A stale callback applies its outcome without checking whether its job is still current. |
| `BugOverlapWorkers` | bug | Starting a replacement briefly creates a second live worker before terminating the first. |
| `BugLeaveTimerArmed` | bug | A successful compile leaves its timeout armed. |

Checked within `MaxCompiles = 2`, `MaxTimeouts = 1`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/03-openscad-compiler
```
