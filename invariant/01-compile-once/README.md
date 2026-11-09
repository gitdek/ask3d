# One-off compile settlement

Written by Invariant for [#5](https://github.com/gitdek/ask3d/issues/5): Check that a one-off compile settles exactly once.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/5#issuecomment-6745206516). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/CompileOnce.tla`](.invariant/specs/CompileOnce.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | The compile starts in Init, and every step is a Next step. |
| `SingleSettlement` | invariant | The promise has no settlements while pending and exactly one once it resolves or rejects. |
| `FirstSignalWins` | invariant | The first delivered signal determines whether the promise resolves with its model or rejects with its prescribed error, and later signals preserve that outcome. |
| `WorkerTerminatedAfterSettlement` | invariant | Whenever the promise has settled, its worker has been terminated. |
| `TimerInactiveAfterSettlement` | invariant | Whenever the promise has settled, its timer is inactive because it was cleared or its one-shot timeout expired. |
| `TypeOK` | invariant | Every recorded event, promise outcome, counter and resource flag has its declared type. |
| `DoneWins` | witness | A worker's done response can arrive first and resolve the promise with its model. |
| `FailureWins` | witness | A non-done worker response can arrive first and reject the promise with the compile-failure error. |
| `ErrorWins` | witness | A worker error can arrive first and reject the promise. |
| `TimeoutWins` | witness | The timeout can arrive first and reject the promise with the timeout error. |
| `EmptyErrorUsesFallback` | witness | A worker error with an empty message can reject the promise with the fallback message worker error. |
| `LaterModelIgnored` | witness | A second done response carrying a different model can arrive without replacing the first model. |
| `LateFailureIgnored` | witness | A failure response can arrive after success without changing the resolved outcome. |
| `LateErrorIgnored` | witness | A worker error can arrive after success without changing the resolved outcome. |
| `LateDoneAfterTimeoutIgnored` | witness | A done response can arrive after timeout without changing the timeout rejection. |
| `EventuallySettles` | property | The invocation eventually resolves or rejects. |
| `TimeoutProgress` | fairness | An active timer eventually runs its timeout callback if it stays active. |
| `BugSecondSettlement` | bug | A repeated done response incorrectly causes a second actual promise settlement. |
| `BugLateDoneOverwrites` | bug | A late done response incorrectly replaces the first outcome with its own model. |
| `BugTimeoutLeavesWorker` | bug | The timeout rejects the promise but forgets to terminate the worker. |
| `BugDoneLeavesTimer` | bug | A done response resolves the promise but forgets to clear the active timer. |

Decided on the issue:

- When timeout wins, does an expired one-shot timer satisfy “timer cleared,” or must the unchanged code be reported as nonconforming because its timeout callback never calls clearTimeout? **A.** An expired one-shot timer satisfies cleanup, so timeout may reject without an explicit clearTimeout call. (@gitdek)

Checked within `ErrorMessages = {"", "worker crashed"}`, `MaxDeliveries = 2`, `Models = {model1, model2}`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/01-compile-once
```
