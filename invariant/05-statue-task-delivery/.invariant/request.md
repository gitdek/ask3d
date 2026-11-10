# Check that a finished statue is delivered once and never replaces another

Issue #27 in gitdek/ask3d, opened by @gitdek.

Code: hooks/use-statue-task.ts

`useStatueTask` in `hooks/use-statue-task.ts` starts statue tasks on the sidecar, polls them, recovers a running or freshly finished task after a reload, and hands each finished statue to the delivery callback, which saves it to the shared library. Check the hook as it is, without changing a line, against these rules:

- A statue task is delivered at most once, across reloads too: a task already delivered, or dismissed with Clear, is never delivered again.
- Two different tasks are never delivered under the same name, since the library keeps one item per kind and name, and a second save under a name replaces the first.
- One task at a time: starting is refused while one is in flight, and recovery never adopts a task over one that's running.
- A task that fails, whose download or delivery fails, or whose polls fail five times in a row ends with its error, and the hook can then start another.

The hook reaches the sidecar and localStorage only through `lib/statue.ts`, which keeps the dismissed task with `getDismissedStatueTaskId` and `setDismissedStatueTaskId`. The driver stands in for both, for React's state, refs and effects, and for the delivery callback, around the unchanged hook. A reload is a fresh mount of the hook against the same sidecar and the same localStorage.

Reading the hook suggests it breaks the first two rules: every recovered statue is named `recovered-statue.stl`, and a reload within ten minutes of a delivered statue recovers it again. The check should show both, and the fix comes after, in its own change.

Keep it lean enough to publish in one comment: at most two tasks and two mounts, about a dozen statements, and a chart of a few named states.

## Discussion

**@gitdek:**

Check the hook against the issue's rules with these two answers, and no alternatives to choose from:

- F1, B: Clear stops future recovery of the task it dismisses, but work already adopted may still invoke and finish the delivery callback, as the hook does. The extraction in #21 kept that on purpose.
- F2, B: only a delivery callback that completes counts as delivered. A rejected attempt may be retried, and its name reused, since the callback rejects before it saves anything to the library.

Keep it lean enough for one comment: about a dozen statements, a chart of a few named states, and the bounds you had: two tasks, two mounts, five poll failures.

**@gitdek:**

I closed #28: its sampled run never reached either bug, so it would have merged as passing while the hook breaks both rules. #29 fixes the hook; after it merges, this check is drafted again against the fixed hook.

**@gitdek:**

Draft this again against the fixed hook: #29 merged, so a completed delivery is remembered and recovery skips it, a fresh statue is named `<photo>-statue-<task id>.stl`, and a recovered one `recovered-statue-<task id>.stl`. Keep the issue's rules and the same two answers (F1, B; F2, B), with no alternatives.

- The two known bugs described the unchanged hook, which no longer does either. Keep known bugs that each must break a rule, written as mistakes a hook could make: recovery adopting a task whose delivery completed, and two recovered statues sharing one name.
- The last build's sampled run never reached the paths these rules are about, so the driver also runs them directly, beside its random runs: a reload after a completed delivery, a second task recovered after a first was delivered, and a rejected delivery retried after a reload and on the same page. Then a pass shows the fix holds on those paths.
- Keep it lean enough for one comment: about a dozen statements, and the bounds you had: two tasks, two mounts, five poll failures.
