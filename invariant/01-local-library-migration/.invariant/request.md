# Check that migrating the local library never loses an item

Issue #4 in gitdek/ask3d, opened by @gitdek.

Code: lib/history.ts

`migrateLocalLibrary` in `lib/history.ts` moves the old per-browser IndexedDB library into the shared server store, once. Check it as it is, without changing a line, against these rules:

- The local library is deleted only once every item in it is in the shared library, either uploaded now or already there under the same kind and name.
- An item that wasn't copied, because its bytes couldn't be read or its upload failed, stays in the local library, and a later load tries it again.
- Once every item is in the shared library, the migration is done, and later loads change nothing.
- A browser without the old library, or without local storage, migrates nothing and deletes nothing.

The code reaches IndexedDB and localStorage directly, and the shared library through `listHistory` and `saveHistoryItem`, which call the server's API. The driver stands in for all three around the unchanged function.

## Discussion

**@gitdek:**

Choose A: check the unchanged function against the issue's no-loss and retry rules, so the check shows the current code losing items. The fix comes after, in its own change.

Keep the ratified bounds small enough for a drawn state chart, at most 500 states. One library item and two loads are enough to show both losses: an item whose bytes can't be read is deleted with the local library, and an item whose upload failed is never tried again.
