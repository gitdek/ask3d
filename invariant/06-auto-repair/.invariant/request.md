# Check that automatic repair stops at two attempts and never ignores a repair's reply

Issue #43 in gitdek/ask3d, opened by @gitdek.

Code: hooks/use-auto-repair.ts

`useAutoRepair` in `hooks/use-auto-repair.ts` takes each finished chat reply's program to a model in the viewer. It lints the program, compiles it, and sends up to two automatic repair messages for one human message when the program, or the geometry it makes, is at fault. Check the hook as it is, without changing a line, against these rules:

- For one human message, at most two automatic repair messages are sent. A human message gives the replies that follow a fresh two.
- Only the latest program counts. A compile result or failure for a program the chat has moved on from changes nothing, and each result and each failure is acted on once.
- While a repair is pending, a reply that carries a program is never ignored: it's compiled, or it counts as another failed attempt, or an error is shown. When the round ends, with a model accepted or an error shown, no attempt is left counted.
- A timeout, and a compiler that didn't load, are shown and never repaired.
- A program that compiled is skipped only while its model is the one in the viewer. Once a statue, a restore or Clear has replaced the model, the same program compiles again.

The hook reaches the chat, the compiler, the linter and the viewer only through what the component passes in: `compile`, `cancel`, `lint`, `sendRepair`, `showError`, `onModel` and `onAccepted`. The driver stands in for all of them, for React's state, refs and effects, and for the chat's status and its replies, around the unchanged hook.

Reading the hook suggests it breaks the third rule. When the reply to a repair re-emits the program that last compiled, the one already in the viewer, the hook returns before anything is shown: the failing program's errors never appear, the attempt stays counted, and the viewer keeps the old model as if the request had been carried out. `lib/__tests__/auto-repair.test.ts` holds that as it is today, in its last test. The check should show it, and the fix comes after, in its own change.

Keep it lean enough to publish in one comment: one human message at a time and at most three programs, about a dozen statements, and a chart of a few named states.
