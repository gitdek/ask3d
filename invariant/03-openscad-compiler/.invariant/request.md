# Check that the compiler only ever applies its latest compile

Issue #16 in gitdek/ask3d, opened by @gitdek.

Code: hooks/use-openscad-compiler.ts

`useOpenScadCompiler` in `hooks/use-openscad-compiler.ts` runs each compile on a fresh OpenSCAD worker and keeps its state in React state and refs: `status` (idle, compiling, done, error or timeout), the result and failure, `workerRef`, `timeoutRef` and `jobIdRef`. Each compile gets a new job id, cancelling and timing out both terminate the worker, and results carry their source so consumers can drop stale ones. Check the hook as it is, without changing a line, against these rules:

- Only the latest compile's outcome is ever applied. A result, failure or timeout from a compile that a newer compile or a cancel replaced never changes the status, the result or the failure.
- Starting a compile, cancelling and timing out each terminate the worker before it, so at most one worker is ever live, and none is once the hook has stopped compiling.
- A compile that isn't replaced ends exactly once: done with its result, error with its failure, or timeout. Its timer is cleared once it ends.
- After a cancel, the status is idle and nothing from the cancelled compile arrives afterward.

The hook uses React's state, refs, callbacks and effects, `Worker` and `setTimeout`. The driver stands in for all of them around the unchanged hook.

## Discussion

**@gitdek:**

Check the hook against the issue's rules as written, with no alternatives to choose from.

One point the rules leave open: the last completed compile's result may stay in `result` while a newer compile runs and after a cancel, since `compile` clears only the failure. That isn't applying a stale outcome. What must never happen is a result, failure or timeout from a compile that was replaced or cancelled changing the status, the result or the failure.

Keep the bounds small enough for a drawn chart and a short proposal: at most two compiles, one cancel and one timeout per run.

**@gitdek:**

The last draft was too big to publish: 35 statements, and a model whose chart arrows carried 135 KB of transition evidence. Keep it lean enough to fit in one comment:

- Model only what the rules need: the status, which job is current, which workers are still alive, whether a timer is armed, and the callbacks still able to arrive. Leave out the result and failure contents, error messages and stderr.
- Use about a dozen statements: one invariant for each rule in the issue, two or three witnesses, and two or three known bugs.
- Keep the bounds to two compiles, one cancel and one timeout, small enough for a few dozen states.
