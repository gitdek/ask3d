# Local library migration

Written by Invariant for [#23](https://github.com/gitdek/ask3d/issues/23): Check that the fixed library migration never loses an item.

@gitdek ratified these statements [on the issue](https://github.com/gitdek/ask3d/issues/23#issuecomment-6751196709). They're pinned by hash in [`ratified.lock`](.invariant/ratified.lock), and their text is in [`.invariant/specs/LibraryMigration.tla`](.invariant/specs/LibraryMigration.tla).

| Statement | Kind | Says |
| :-- | :-- | :-- |
| `Spec` | spec | Sequential browser loads follow the migration, with one local item identified by its kind and name and at most two loads. |
| `NoItemLost` | invariant | The completion flag is set and local deletion is requested only after every local item is shared under the same kind and name. |
| `FailedLoadsStayRetryable` | invariant | A read abort or error settles as a failure, and a failed load returns with its database closed, its local library retained and its completion flag unset for retry. |
| `ReadsWaitForCommit` | invariant | Metadata and bytes are used only after their read transactions complete, never on request success alone. |
| `CompletedLoadsAreIdle` | invariant | After a completed migration returns, later loads keep its flag and make no database, shared-library or flag-write calls. |
| `NoSourceDoesNoMigration` | invariant | Unavailable local storage causes no migration work, and an absent old database causes no uploads or deletion requests. |
| `TypeOK` | invariant | Every phase, transaction status, library key, flag and call count stays within its declared type and bounds. |
| `UploadThenSkip` | witness | An item can upload successfully, permit deletion and make the next load do nothing. |
| `RetryThenFinish` | witness | A failed first load can retry and finish migration on the second load. |
| `AlreadySharedFinishes` | witness | An item already shared under the same kind and name can complete migration without an upload. |
| `AbsentFinishes` | witness | A browser without the old database can mark migration complete without uploading or requesting deletion. |
| `UnavailableReturns` | witness | A browser without local storage can return without doing migration work. |
| `MissingBytesSkipped` | bug | Skipping a missing blob lets migration mark an uncopied item complete. |
| `AbortIgnored` | bug | Ignoring a read transaction abort leaves the invocation stranded with its database open. |
| `RequestSuccessUsed` | bug | Resolving a read on request success uses its result before the transaction completes. |

Checked within `Item = item`, `MaxLoads = 2`. To run the gate yourself:

```bash
go run ./cmd/invariant verify invariant/04-library-migration
```
