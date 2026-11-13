# Automatic repair checks

Written by Invariant for [#43](https://github.com/gitdek/ask3d/issues/43): Check that automatic repair stops at two attempts and never ignores a repair's reply.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/43#issuecomment-6856126836). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/AutoRepair.tla`](.invariant/specs/AutoRepair.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | The hook starts idle and each settled input or callback follows the bounded model. |
| `RepairReplyAccounted` | invariant | A finished reply containing a program during a pending repair must start a compile, send another counted repair, or show an error. |
| `TwoRepairsPerHuman` | invariant | At most two repair messages are sent per human message, and a new human message cancels the active compile and resets the allowance and repair state. |
| `CurrentAndOnce` | invariant | A result or failure for a superseded program, or the same previously handled object delivered again, makes no callback call and changes no round or viewer state. |
| `FinishedRoundIsClear` | invariant | The displayed attempt matches the internal counter, and accepting a model or showing an error leaves neither a counted attempt nor pending repair errors. |
| `InfrastructureIsNotRepaired` | invariant | A fresh timeout or compiler-loading failure for the current program shows an error and sends no automatic repair. |
| `SkipOnlyVisibleModel` | invariant | A program reply can be skipped only when its previously accepted model is still displayed and no repair is pending, so replacing that model removes the skip exemption. |
| `TypeOK` | invariant | All sources, counters, phases, pending state and observed callback calls stay within their declared types for three programs and a two-repair limit. |
| `ModelAccepted` | witness | A compiled model can be displayed and accepted. |
| `BudgetExhausted` | witness | A program fault can show an error after both automatic repairs have been sent. |
| `TimeoutShown` | witness | A timeout can be shown as an error. |
| `CompilerUnavailableShown` | witness | A compiler-loading failure can be shown as an error. |
| `RepairReplyCompiled` | witness | A program in a pending repair's reply can start a new compile. |
| `IgnoreCachedRepairReply` | bug | The hook silently returns when a repair reply repeats the successful program still displayed, leaving the failing program's pending errors and counted attempt untouched. |
| `KeepAttemptAfterError` | bug | A timeout during a repair shows an error but leaves the attempt counter set, as the current hook does. |

Checked within `MaxRepairs = 2`, `NoProgram = none`, `Programs = {p1, p2, p3}`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/06-auto-repair
```
