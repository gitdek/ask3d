# Check that the fixed library migration never loses an item

Issue #23 in gitdek/ask3d, opened by @gitdek.

Code: lib/history.ts

`migrateLocalLibrary` in `lib/history.ts` moves the old per-browser IndexedDB library into the shared server store, once. #13 fixed the three ways it lost or stranded items, which #4's check found. Check it as it is now, without changing a line, against #4's rules:

- The local library is deleted only once every item in it is in the shared library, either uploaded now or already there under the same kind and name.
- An item that wasn't copied, because its bytes couldn't be read or its upload failed, stays in the local library, and a later load tries it again.
- Once every item is in the shared library, the migration is done, and later loads change nothing.
- A browser without the old library, or without local storage, migrates nothing and deletes nothing.

The code reaches IndexedDB and localStorage directly, and the shared library through `listHistory` and `saveHistoryItem`, which call the server's API. The driver stands in for all three around the unchanged function. Each IndexedDB read now settles on its transaction's `oncomplete`, or rejects on its `onabort` or the request's `onerror`; a missing blob throws; and any failure returns without setting the flag, closing the database first.

Keep it lean enough to publish in one comment, as #4's last draft was: about a dozen statements, a chart of about seven named states (ready for a browser load, check and migrate, read the item's bytes, upload the item, request deletion, marked complete, local storage unavailable) with the transaction events hidden inside reading the bytes, and bounds of one library item and two loads.

This replaces #4, whose drafts couldn't be published: each had to carry a comparison with #4's first ratified draft, written against the code before #13, and that comparison alone was over 300 KB.
