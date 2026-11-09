# Shared library safety

Written by Invariant for [#11](https://github.com/gitdek/ask3d/issues/11): Check that the shared library never lists an item without its bytes.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/11#issuecomment-6748015710). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/SharedLibrary.tla`](.invariant/specs/SharedLibrary.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | Starting from a valid bounded library fixture, every observed step follows the library safety model. |
| `ListedItemsHaveBytes` | invariant | Every item in the published index has a complete blob, including during operations and after a file operation fails. |
| `ReadFailurePreservesItems` | invariant | An index read failure preserves every previously listed item through the next save in the recovery scenario. |
| `UniqueKindName` | invariant | The index contains at most one item with any given kind and name. |
| `WithinCap` | invariant | The index never exceeds its item cap. |
| `SaveRetainsOtherItems` | invariant | Publishing a save preserves every other item except the oldest entries that must be trimmed to make room. |
| `SuccessfulSaveIsFirst` | invariant | At a successful save response, the saved item is first in the index. |
| `SuccessfulSaveHasGivenBytes` | invariant | At a successful save response, the saved item's blob contains exactly the supplied bytes. |
| `SuccessfulDeleteRemovesItem` | invariant | At a successful delete response, the selected item is absent from the index, or the index is empty for delete-all. |
| `OneWriter` | invariant | Only the current lock owner can be executing an index mutation, and at most one request executes one at a time. |
| `TypeOK` | invariant | All state has the declared bounded types, with two tracked kinds and names, two exposed capacity slots beside 58 fixed background entries, two requests and at most one failed file operation. |
| `SaveSucceeds` | witness | A save can succeed. |
| `UpsertSucceeds` | witness | Saving an existing kind and name can successfully replace its previous item. |
| `TrimSucceeds` | witness | Saving into a full library can succeed while trimming the oldest item. |
| `DeleteOneSucceeds` | witness | Deleting one item can succeed while preserving another item. |
| `DeleteAllSucceeds` | witness | Deleting all items can successfully empty the index. |
| `ConcurrentSavesSurvive` | witness | Two queued saves of different keys can both succeed and remain listed. |
| `ReadErrorThenSaveSucceeds` | witness | After one save fails to read the index, the next queued save can succeed and retain the previously listed item. |
| `WriteErrorThenSaveSucceeds` | witness | After a blob write fails, the promise chain can run the next queued save successfully. |
| `RenameFailureKeepsIndex` | witness | An index rename can fail while leaving the previously published index intact. |
| `RemovalFailureKeepsIndexSafe` | witness | Removing an obsolete blob can fail while the published index remains valid. |
| `RemoveBeforePublishing` | bug | An upsert, trim or delete removes a blob while the published index still lists it. |
| `DiscardIndexOnReadError` | bug | A save treats an index read error as an empty library and publishes a replacement index that forgets existing items. |
| `PublishStaleSave` | bug | A concurrent save publishes a stale snapshot that drops the previous save's unrelated item. |
| `WriteWrongBytes` | bug | A save writes different bytes from those supplied and still reports success. |

Checked within `BackgroundItems = 58`, `Cap = 2`, `Kinds = {image, mesh}`, `MaxFailures = 1`, `Names = {one, two}`, `Payloads = {bytesA, bytesB}`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/02-shared-library
```
