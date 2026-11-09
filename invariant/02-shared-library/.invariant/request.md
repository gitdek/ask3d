# Check that the shared library never lists an item without its bytes

Issue #11 in gitdek/ask3d, opened by @gitdek.

Code: app/api/library/route.ts

The shared library route keeps its state in three places: an index file listing each item's kind, name, id and time, one blob file per item, and an in-process promise chain that orders writes (`withIndexLock`). POST upserts by kind and name and trims the oldest items beyond the cap, DELETE removes one item or all of them, and GET lists or serves them. Check the route as it is, without changing a line, against these rules:

- Every item the index lists has its bytes, even when a save, a trim or a delete stops partway because a write, rename or removal fails.
- A failure to read the index never makes the library forget its items: the next save keeps every item that was listed.
- The index holds at most one item for each kind and name, and never more than the cap.
- A save that succeeds lists its item first, with the bytes it was given. A delete that succeeds removes that item from the index.

The route reaches the file system through `fs/promises`. The driver stands in for it, failing chosen operations, around the unchanged handlers.

## Discussion

**@gitdek:**

Check the route against the issue's rules as written, with no alternatives to choose from. The current code may fail conformance where a write, rename or removal fails partway, and that's the finding: the fix comes after, in its own change.

Keep the bounds small enough for a drawn chart and a short proposal: two kinds or names, a cap of two items, and at most one failed file operation per run.
