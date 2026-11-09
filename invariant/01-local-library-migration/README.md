# Local library migration

Written by Invariant for [#4](https://github.com/gitdek/ask3d/issues/4): Check that migrating the local library never loses an item.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/4#issuecomment-6745206136). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/LocalLibraryMigration.tla`](.invariant/specs/LocalLibraryMigration.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | Each browser load follows the modeled migration steps within the checked bounds. |
| `DeleteOnlyWhenShared` | invariant | Deletion of the old database is requested only when every original local item is present in the shared library under the same kind and name. |
| `CompletionRequiresAllShared` | invariant | The completion flag is never set while any original local item is still absent from the shared library. |
| `CompletedLoadsQuiet` | invariant | A load that starts with the completion flag makes no upload, flag-write, or database-deletion attempt. |
| `NoStorageWork` | invariant | When reading local storage is unavailable, migration makes no upload, flag-write, or database-deletion attempt. |
| `NoAbsentLibraryCopy` | invariant | A browser with no old database uploads no items and requests no database deletion. |
| `UploadOnlyNewKeys` | invariant | An item is read for upload only if the shared-library listing lacks its exact kind and name. |
| `TypeOK` | invariant | All stored values, migration phases, item sets, and observed operation counts stay within their declared types and bounds. |
| `CopiedAndCompleted` | witness | Migration can upload local items, mark completion, and request deletion after every local item is shared. |
| `AlreadySharedCompleted` | witness | Migration can finish without uploads when every local item already exists under its kind and name. |
| `LaterLoadQuiet` | witness | A second load after completion can return without making any further writes. |
| `AbsentLibrarySkipped` | witness | A load with no old database can record completion without uploading or deleting anything. |
| `AbsentStorageSkipped` | witness | A load without readable local storage can return without writing anything. |
| `EmptyLibraryCompleted` | witness | An existing empty local database can be marked complete and scheduled for deletion without uploads. |
| `UnreadableRetained` | witness | An item with unreadable bytes can remain local with migration still eligible for a later load. |
| `FailedUploadRetained` | witness | An item whose upload failed can remain local with migration still eligible for a later load. |
| `FailedItemRetried` | witness | A second load can attempt to read an item left uncopied by a first-load read or upload failure. |
| `MetadataFailureRetained` | witness | A metadata-read failure can leave an incomplete local library intact and unmarked for a later load. |
| `DeleteIncomplete` | bug | Migration requests deletion while at least one local item has no shared copy. |
| `CompleteDespiteUnreadableBytes` | bug | Migration proceeds to mark completion after silently skipping an unreadable item that has no shared copy. |
| `CompleteDespiteUploadFailure` | bug | Migration proceeds to mark completion even though an upload failed and the item is still absent from the shared library. |
| `WriteAfterCompletion` | bug | A later load writes the completion flag again despite finding it already set. |

Checked within `FirstKind = "image"`, `FirstName = "part"`, `ItemCount = 1`, `MaxLoads = 2`, `SecondKind = "mesh"`, `SecondName = "other"`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/01-local-library-migration
```
