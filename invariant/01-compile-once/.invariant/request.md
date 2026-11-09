# Check that a one-off compile settles exactly once

Issue #5 in gitdek/ask3d, opened by @gitdek.

Code: lib/scad/compile-once.ts

`compileOnce` in `lib/scad/compile-once.ts` runs one OpenSCAD compile on a fresh worker and races its result, a worker error and a timeout. Check it as it is, without changing a line, against these rules:

- The promise settles exactly once. It resolves with the model when the worker reports done, and rejects when the worker reports a failure, raises an error or runs out of time, whichever comes first.
- Whatever settles it, the worker is terminated and the timer cleared, and nothing that arrives afterwards changes the outcome.

The code creates a `Worker` and uses `setTimeout`. The driver stands in for both around the unchanged function.

## Decided

- **F1. When timeout wins, does an expired one-shot timer satisfy “timer cleared,” or must the unchanged code be reported as nonconforming because its timeout callback never calls clearTimeout?** A. An expired one-shot timer satisfies cleanup, so timeout may reject without an explicit clearTimeout call. (decided by @gitdek: https://github.com/gitdek/ask3d/issues/5#issuecomment-6743973883)
