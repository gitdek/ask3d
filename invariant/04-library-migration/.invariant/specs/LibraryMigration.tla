---- MODULE LibraryMigration ----
EXTENDS Naturals, FiniteSets

CONSTANTS Item, MaxLoads
VARIABLES pc, environment, loads, shared, flag, dbOpen, stage,
          metaRead, blobRead, failed, failedLoads, calls, sealed, completed

vars == <<pc, environment, loads, shared, flag, dbOpen, stage,
          metaRead, blobRead, failed, failedLoads, calls, sealed, completed>>

\* Item represents the original item's (kind, name) key. Nonmatching server
\* entries are projected away; shared contains Item only if BOTH match.
\* Loads are sequential, with no external edits to either library or flag.
\* An unavailable-storage browser may still have the original local item.
\* Events are observed after their promise continuations drain. Rejection
\* includes finally/close and return; successful request delivery does NOT
\* include transaction completion. delete counts requests, not completion.
LocalItems == IF environment \in {"library", "unavailable"} THEN {Item} ELSE {}
AllCopied == LocalItems \subseteq shared
CallKinds == {"open", "read", "list", "upload", "mark", "delete"}
ZeroCalls == [k \in CallKinds |-> 0]
Bump(c, k) == [c EXCEPT ![k] = @ + 1]

NoItemLost == (flag \/ calls["delete"] > 0) => AllCopied

FailedLoadsStayRetryable ==
    /\ (metaRead \in {"abort", "error"} \/ blobRead \in {"abort", "error"}) => failed
    /\ failed => (pc = "ready" /\ ~flag /\ ~dbOpen /\ calls["delete"] = 0)

ReadsWaitForCommit ==
    /\ (pc \in {"read", "upload", "delete"}
        \/ (pc = "check" /\ stage \in {"list", "choose", "mark", "close"}))
       => metaRead = "complete"
    /\ pc = "upload" => blobRead = "complete"

CompletedLoadsAreIdle == completed => (flag /\ ~dbOpen /\ calls = sealed)

NoSourceDoesNoMigration ==
    /\ environment = "unavailable" => calls = ZeroCalls
    /\ environment = "absent" => (calls["upload"] = 0 /\ calls["delete"] = 0)

TypeOK ==
    /\ pc \in {"ready", "check", "read", "upload", "delete", "done", "unavailable"}
    /\ environment \in {"library", "empty", "absent", "unavailable"}
    /\ loads \in 0..MaxLoads
    /\ shared \subseteq {Item}
    /\ flag \in BOOLEAN
    /\ dbOpen \in BOOLEAN
    /\ stage \in {"flag", "open", "meta", "list", "choose", "mark", "close", "absent"}
    /\ metaRead \in {"idle", "waiting", "result", "complete", "abort", "error"}
    /\ blobRead \in {"idle", "waiting", "result", "resultMissing", "complete", "missing", "abort", "error"}
    /\ failed \in BOOLEAN
    /\ failedLoads \in 0..MaxLoads
    /\ calls \in [CallKinds -> 0..(2 * MaxLoads)]
    /\ sealed \in [CallKinds -> 0..(2 * MaxLoads)]
    /\ completed \in BOOLEAN

UploadThenSkip ==
    /\ environment = "library" /\ loads = 2 /\ pc = "done"
    /\ completed /\ calls["upload"] = 1 /\ calls["delete"] = 1 /\ failedLoads = 0

RetryThenFinish ==
    /\ environment = "library" /\ loads = 2 /\ pc = "done"
    /\ completed /\ failedLoads = 1 /\ calls["upload"] > 0

AlreadySharedFinishes ==
    /\ environment = "library" /\ pc = "done" /\ completed
    /\ calls["upload"] = 0 /\ calls["delete"] = 1

AbsentFinishes == environment = "absent" /\ pc = "done" /\ completed
UnavailableReturns == environment = "unavailable" /\ pc = "unavailable" /\ loads > 0

Init ==
    /\ pc = "ready"
    /\ environment \in {"library", "empty", "absent", "unavailable"}
    /\ loads = 0
    /\ shared \in SUBSET {Item}
    /\ flag = FALSE
    /\ dbOpen = FALSE
    /\ stage = "flag"
    /\ metaRead = "idle"
    /\ blobRead = "idle"
    /\ failed = FALSE
    /\ failedLoads = 0
    /\ calls = ZeroCalls
    /\ sealed = ZeroCalls
    /\ completed = FALSE

BeginLoad ==
    /\ pc \in {"ready", "done", "unavailable"} /\ loads < MaxLoads
    /\ pc' = "check" /\ loads' = loads + 1 /\ stage' = "flag"
    /\ metaRead' = "idle" /\ blobRead' = "idle" /\ failed' = FALSE
    /\ UNCHANGED <<environment, shared, flag, dbOpen, failedLoads, calls, sealed, completed>>

CheckFlag ==
    /\ pc = "check" /\ stage = "flag"
    /\ pc' = IF environment = "unavailable" THEN "unavailable"
              ELSE IF flag THEN "done" ELSE "check"
    /\ stage' = IF environment = "unavailable" \/ flag THEN stage ELSE "open"
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen, metaRead, blobRead,
                   failed, failedLoads, calls, sealed, completed>>

OpenDatabase ==
    /\ pc = "check" /\ stage = "open"
    /\ calls' = Bump(calls, "open")
    /\ stage' = IF environment = "absent" THEN "absent" ELSE "meta"
    /\ dbOpen' = (environment # "absent")
    /\ metaRead' = "idle"
    /\ UNCHANGED <<pc, environment, loads, shared, flag, blobRead,
                   failed, failedLoads, sealed, completed>>

OpenFails ==
    /\ pc = "check" /\ stage = "open"
    /\ pc' = "ready" /\ failed' = TRUE /\ failedLoads' = failedLoads + 1
    /\ calls' = Bump(calls, "open")
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen, stage,
                   metaRead, blobRead, sealed, completed>>

StartMetadataRead ==
    /\ pc = "check" /\ stage = "meta" /\ metaRead = "idle"
    /\ metaRead' = "waiting" /\ calls' = Bump(calls, "read")
    /\ UNCHANGED <<pc, environment, loads, shared, flag, dbOpen, stage,
                   blobRead, failed, failedLoads, sealed, completed>>

MetadataRequestSuccess ==
    /\ pc = "check" /\ stage = "meta" /\ metaRead = "waiting"
    /\ metaRead' = "result"
    /\ UNCHANGED <<pc, environment, loads, shared, flag, dbOpen, stage,
                   blobRead, failed, failedLoads, calls, sealed, completed>>

MetadataTransactionComplete ==
    /\ pc = "check" /\ stage = "meta" /\ metaRead = "result"
    /\ metaRead' = "complete" /\ stage' = "list"
    /\ UNCHANGED <<pc, environment, loads, shared, flag, dbOpen,
                   blobRead, failed, failedLoads, calls, sealed, completed>>

ReadRejects(which, reason) ==
    /\ reason \in {"abort", "error"}
    /\ IF which = "meta"
          THEN pc = "check" /\ stage = "meta"
               /\ metaRead \in (IF reason = "abort" THEN {"waiting", "result"} ELSE {"waiting"})
          ELSE pc = "read"
               /\ blobRead \in (IF reason = "abort" THEN {"waiting", "result", "resultMissing"} ELSE {"waiting"})
    /\ pc' = "ready" /\ failed' = TRUE /\ failedLoads' = failedLoads + 1 /\ dbOpen' = FALSE
    /\ metaRead' = IF which = "meta" THEN reason ELSE metaRead
    /\ blobRead' = IF which = "bytes" THEN reason ELSE blobRead
    /\ UNCHANGED <<environment, loads, shared, flag, stage, calls, sealed, completed>>

ListShared ==
    /\ pc = "check" /\ stage = "list"
    /\ stage' = "choose" /\ calls' = Bump(calls, "list")
    /\ UNCHANGED <<pc, environment, loads, shared, flag, dbOpen,
                   metaRead, blobRead, failed, failedLoads, sealed, completed>>

ListFails ==
    /\ pc = "check" /\ stage = "list"
    /\ pc' = "ready" /\ failed' = TRUE /\ failedLoads' = failedLoads + 1 /\ dbOpen' = FALSE
    /\ calls' = Bump(calls, "list")
    /\ UNCHANGED <<environment, loads, shared, flag, stage, metaRead, blobRead, sealed, completed>>

ChooseItem ==
    /\ pc = "check" /\ stage = "choose"
    /\ pc' = IF AllCopied THEN "check" ELSE "read"
    /\ stage' = IF AllCopied THEN "mark" ELSE stage
    /\ blobRead' = IF AllCopied THEN blobRead ELSE "waiting"
    /\ calls' = IF AllCopied THEN calls ELSE Bump(calls, "read")
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen,
                   metaRead, failed, failedLoads, sealed, completed>>

BlobRequestSuccess(result) ==
    /\ pc = "read" /\ blobRead = "waiting" /\ result \in {"result", "resultMissing"}
    /\ blobRead' = result
    /\ UNCHANGED <<pc, environment, loads, shared, flag, dbOpen, stage,
                   metaRead, failed, failedLoads, calls, sealed, completed>>

BlobTransactionComplete ==
    /\ pc = "read" /\ blobRead = "result"
    /\ blobRead' = "complete" /\ pc' = "upload"
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen, stage,
                   metaRead, failed, failedLoads, calls, sealed, completed>>

MissingBlob ==
    /\ pc = "read" /\ blobRead = "resultMissing"
    /\ blobRead' = "missing" /\ pc' = "ready" /\ dbOpen' = FALSE
    /\ failed' = TRUE /\ failedLoads' = failedLoads + 1
    /\ UNCHANGED <<environment, loads, shared, flag, stage,
                   metaRead, calls, sealed, completed>>

UploadSucceeds ==
    /\ pc = "upload"
    /\ shared' = shared \cup {Item} /\ pc' = "check" /\ stage' = "mark"
    /\ calls' = Bump(calls, "upload")
    /\ UNCHANGED <<environment, loads, flag, dbOpen, metaRead, blobRead,
                   failed, failedLoads, sealed, completed>>

UploadFails ==
    /\ pc = "upload"
    /\ pc' = "ready" /\ dbOpen' = FALSE /\ failed' = TRUE /\ failedLoads' = failedLoads + 1
    /\ calls' = Bump(calls, "upload")
    /\ UNCHANGED <<environment, loads, shared, flag, stage,
                   metaRead, blobRead, sealed, completed>>

MarkComplete ==
    /\ pc = "check" /\ stage = "mark"
    /\ flag' = TRUE /\ stage' = "close" /\ calls' = Bump(calls, "mark")
    /\ UNCHANGED <<pc, environment, loads, shared, dbOpen, metaRead, blobRead,
                   failed, failedLoads, sealed, completed>>

MarkAbsent ==
    /\ pc = "check" /\ stage = "absent"
    /\ flag' = TRUE /\ pc' = "done" /\ completed' = TRUE
    /\ calls' = Bump(calls, "mark") /\ sealed' = calls'
    /\ UNCHANGED <<environment, loads, shared, dbOpen, stage, metaRead, blobRead, failed, failedLoads>>

MarkFails ==
    /\ pc = "check" /\ stage \in {"mark", "absent"}
    /\ pc' = "ready" /\ dbOpen' = FALSE /\ failed' = TRUE /\ failedLoads' = failedLoads + 1
    /\ calls' = Bump(calls, "mark")
    /\ UNCHANGED <<environment, loads, shared, flag, stage, metaRead, blobRead, sealed, completed>>

CloseDatabase ==
    /\ pc = "check" /\ stage = "close"
    /\ dbOpen' = FALSE /\ pc' = "delete"
    /\ UNCHANGED <<environment, loads, shared, flag, stage, metaRead, blobRead,
                   failed, failedLoads, calls, sealed, completed>>

RequestDeletion ==
    /\ pc = "delete"
    /\ calls' = Bump(calls, "delete") /\ pc' = "done"
    /\ completed' = TRUE /\ sealed' = calls'
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen, stage,
                   metaRead, blobRead, failed, failedLoads>>

Idle == pc \in {"ready", "done", "unavailable"} /\ UNCHANGED vars

Next ==
    \/ BeginLoad \/ CheckFlag \/ OpenDatabase \/ OpenFails \/ StartMetadataRead
    \/ MetadataRequestSuccess \/ MetadataTransactionComplete
    \/ \E which \in {"meta", "bytes"}, reason \in {"abort", "error"} : ReadRejects(which, reason)
    \/ ListShared \/ ListFails \/ ChooseItem
    \/ \E result \in {"result", "resultMissing"} : BlobRequestSuccess(result)
    \/ BlobTransactionComplete \/ MissingBlob \/ UploadSucceeds \/ UploadFails
    \/ MarkComplete \/ MarkAbsent \/ MarkFails \/ CloseDatabase \/ RequestDeletion \/ Idle

\* Old missing-blob continue: normal completion then forgets the uncopied item.
MissingBytesSkipped ==
    /\ pc = "read" /\ blobRead = "resultMissing"
    /\ pc' = "check" /\ stage' = "mark" /\ blobRead' = "missing"
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen, metaRead,
                   failed, failedLoads, calls, sealed, completed>>

\* No transaction abort handler leaves the invocation waiting forever.
AbortIgnored ==
    /\ ((pc = "check" /\ stage = "meta" /\ metaRead \in {"waiting", "result"})
        \/ (pc = "read" /\ blobRead \in {"waiting", "result", "resultMissing"}))
    /\ metaRead' = IF pc = "check" THEN "abort" ELSE metaRead
    /\ blobRead' = IF pc = "read" THEN "abort" ELSE blobRead
    /\ UNCHANGED <<pc, environment, loads, shared, flag, dbOpen, stage,
                   failed, failedLoads, calls, sealed, completed>>

\* Request onsuccess resolves a read before its transaction can still abort.
RequestSuccessUsed ==
    /\ ((pc = "check" /\ stage = "meta" /\ metaRead = "result")
        \/ (pc = "read" /\ blobRead = "result"))
    /\ pc' = IF pc = "read" THEN "upload" ELSE pc
    /\ stage' = IF pc = "check" THEN "list" ELSE stage
    /\ UNCHANGED <<environment, loads, shared, flag, dbOpen, metaRead, blobRead,
                   failed, failedLoads, calls, sealed, completed>>

Spec == Init /\ [][Next]_vars
====
