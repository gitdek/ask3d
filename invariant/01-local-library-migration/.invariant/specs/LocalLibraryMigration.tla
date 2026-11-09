---- MODULE LocalLibraryMigration ----
EXTENDS Naturals, Sequences, FiniteSets

\* ItemKeys lists local items in createdAt order; each key is <<kind, name>>.
\* Calls are sequential browser loads; API outcomes and flag writes may fail.
\* This is the no-loss contract chosen in F1/A, not a claim that the current
\* function conforms: its premature completion/deletion paths are bugs below.
\* shared records only server keys matching an original local item's exact
\* <<kind, name>>; seen is the same projection of one listHistory snapshot.
\* Other server entries (including same-kind/different-name and
\* different-kind/same-name entries) project away: neither counts as a copy.
\* This observational projection preserves every migration decision while
\* avoiding independent state copies for irrelevant server entries.
\* localItems records the original database; the function never removes one row.
\* deleteIssued records deleteDatabase invocation, not asynchronous completion.
\* writes counts attempted uploads, marker writes, and deletion requests.
\* retryItems records first-load failures still absent from the shared store.
\* No fairness is assumed for another browser load or a successful I/O response.
CONSTANTS ItemCount, MaxLoads, FirstKind, SecondKind, FirstName, SecondName

ItemKeys == [i \in 1..ItemCount |->
    <<IF i = 1 THEN FirstKind ELSE SecondKind, FirstName>>]

ServerKeys == {<<FirstKind, FirstName>>, <<SecondKind, FirstName>>,
    <<FirstKind, SecondName>>}
VARIABLES storage, oldDatabase, localItems, shared, flag, deleteIssued,
    phase, loads, todo, seen, unreadable, failed, metadataOK,
    writes, entryDone, entryWrites, retryItems

vars == <<storage, oldDatabase, localItems, shared, flag, deleteIssued,
    phase, loads, todo, seen, unreadable, failed, metadataOK,
    writes, entryDone, entryWrites, retryItems>>

Items == 1..ItemCount

LocalKeys == {ItemKeys[i] : i \in localItems}

Phases == {"idle", "flag", "open", "metadata", "list", "scan", "read",
    "upload", "mark", "markEmpty", "delete", "return"}

WriteCounts == [upload : 0..(ItemCount * MaxLoads),
    mark : 0..MaxLoads, delete : 0..MaxLoads]

ZeroWrites == [upload |-> 0, mark |-> 0, delete |-> 0]

Current == CHOOSE i \in todo : \A j \in todo : i <= j

Missing == {i \in localItems : ItemKeys[i] \notin shared}

AllShared == Missing = {}

TypeOK ==
    /\ storage \in BOOLEAN
    /\ oldDatabase \in BOOLEAN
    /\ localItems \in SUBSET Items
    /\ shared \in SUBSET LocalKeys
    /\ flag \in BOOLEAN
    /\ deleteIssued \in BOOLEAN
    /\ phase \in Phases
    /\ loads \in 0..MaxLoads
    /\ todo \in SUBSET localItems
    /\ seen \in SUBSET LocalKeys
    /\ unreadable \in SUBSET localItems
    /\ failed \in SUBSET localItems
    /\ metadataOK \in BOOLEAN
    /\ writes \in WriteCounts
    /\ entryDone \in BOOLEAN
    /\ entryWrites \in WriteCounts
    /\ retryItems \in SUBSET localItems
    /\ (phase \in {"read", "upload"} => todo # {})

DeleteOnlyWhenShared == deleteIssued => AllShared

CompletionRequiresAllShared == flag => AllShared

CompletedLoadsQuiet == entryDone => writes = entryWrites

NoStorageWork == ~storage => writes = ZeroWrites

NoAbsentLibraryCopy ==
    ~oldDatabase => (writes.upload = 0 /\ writes.delete = 0)

UploadOnlyNewKeys ==
    phase \in {"read", "upload"} => ItemKeys[Current] \notin seen

CopiedAndCompleted ==
    /\ phase = "idle" /\ flag /\ deleteIssued /\ AllShared
    /\ localItems # {} /\ writes.upload > 0

AlreadySharedCompleted ==
    /\ phase = "idle" /\ flag /\ deleteIssued
    /\ localItems # {} /\ writes.upload = 0

UnreadableRetained ==
    /\ phase = "idle" /\ loads = 1
    /\ unreadable \intersect Missing # {}
    /\ ~flag /\ ~deleteIssued

FailedUploadRetained ==
    /\ phase = "idle" /\ loads = 1
    /\ failed \intersect Missing # {}
    /\ ~flag /\ ~deleteIssued

FailedItemRetried ==
    /\ phase = "read" /\ loads = 2
    /\ Current \in retryItems

LaterLoadQuiet ==
    /\ phase = "idle" /\ loads = 2 /\ entryDone
    /\ writes = entryWrites

AbsentLibrarySkipped ==
    /\ phase = "idle" /\ loads > 0 /\ ~oldDatabase /\ flag
    /\ writes.upload = 0 /\ writes.delete = 0

AbsentStorageSkipped ==
    /\ phase = "idle" /\ loads > 0 /\ ~storage
    /\ writes = ZeroWrites

EmptyLibraryCompleted ==
    /\ phase = "idle" /\ oldDatabase /\ localItems = {}
    /\ flag /\ deleteIssued /\ writes.upload = 0

MetadataFailureRetained ==
    /\ phase = "idle" /\ ~metadataOK /\ Missing # {}
    /\ ~flag /\ ~deleteIssued

Init ==
    /\ storage \in BOOLEAN
    /\ oldDatabase \in BOOLEAN
    /\ localItems \in {1..n : n \in 0..ItemCount}
    /\ (~oldDatabase => localItems = {})
    /\ shared \in SUBSET LocalKeys
    /\ flag = FALSE /\ deleteIssued = FALSE
    /\ phase = "idle" /\ loads = 0
    /\ todo = {} /\ seen = {} /\ unreadable = {} /\ failed = {}
    /\ metadataOK = TRUE
    /\ writes = ZeroWrites /\ entryDone = FALSE /\ entryWrites = ZeroWrites
    /\ retryItems = {}

StartLoad ==
    /\ phase = "idle" /\ loads < MaxLoads
    /\ loads' = loads + 1 /\ phase' = "flag"
    /\ entryDone' = flag /\ entryWrites' = writes
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, todo, seen, unreadable, failed, metadataOK, writes, retryItems>>

ReadFlag ==
    /\ phase = "flag"
    /\ phase' = IF ~storage \/ flag THEN "return" ELSE "open"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

OpenDatabase ==
    /\ phase = "open" /\ oldDatabase
    /\ phase' = "metadata"
    /\ todo' = {} /\ seen' = {} /\ unreadable' = {} /\ failed' = {}
    /\ metadataOK' = TRUE
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, writes, entryDone, entryWrites, retryItems>>

NoDatabase ==
    /\ phase = "open" /\ ~oldDatabase
    /\ phase' = "markEmpty"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

OpenError ==
    /\ phase = "open" /\ oldDatabase
    /\ phase' = "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

OpenThrows ==
    /\ phase = "open"
    /\ phase' = "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

ReadMetadata ==
    /\ phase = "metadata"
    /\ todo' = localItems /\ metadataOK' = TRUE /\ phase' = "list"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, seen, unreadable, failed,
        writes, entryDone, entryWrites, retryItems>>

MetadataError ==
    /\ phase = "metadata"
    /\ todo' = {} /\ metadataOK' = FALSE /\ phase' = "list"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, seen, unreadable, failed,
        writes, entryDone, entryWrites, retryItems>>

ListShared ==
    /\ phase = "list"
    /\ seen' = shared /\ phase' = "scan"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

ListError ==
    /\ phase = "list" /\ phase' = "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

SkipExisting ==
    /\ phase = "scan" /\ todo # {} /\ ItemKeys[Current] \in seen
    /\ todo' = todo \ {Current}
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, phase, loads, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

StartRead ==
    /\ phase = "scan" /\ todo # {} /\ ItemKeys[Current] \notin seen
    /\ phase' = "read"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

ReadBytes ==
    /\ phase = "read" /\ phase' = "upload"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

BytesUnavailable ==
    /\ phase = "read"
    /\ unreadable' = unreadable \union {Current}
    /\ todo' = todo \ {Current} /\ phase' = "scan"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, seen, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

UploadSuccess ==
    /\ phase = "upload"
    /\ shared' = shared \union {ItemKeys[Current]}
    /\ writes' = [writes EXCEPT !.upload = @ + 1]
    /\ todo' = todo \ {Current} /\ phase' = "scan"
    /\ UNCHANGED <<storage, oldDatabase, localItems, flag,
        deleteIssued, loads, seen, unreadable, failed, metadataOK,
        entryDone, entryWrites, retryItems>>

UploadFailure ==
    /\ phase = "upload"
    /\ failed' = failed \union {Current}
    /\ writes' = [writes EXCEPT !.upload = @ + 1]
    /\ todo' = todo \ {Current} /\ phase' = "scan"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, seen, unreadable, metadataOK,
        entryDone, entryWrites, retryItems>>

FinishItems ==
    /\ phase = "scan" /\ todo = {}
    /\ phase' = IF metadataOK /\ unreadable = {} /\ failed = {}
        THEN "mark" ELSE "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

MarkerWritten ==
    /\ phase \in {"mark", "markEmpty"}
    /\ flag' = TRUE /\ writes' = [writes EXCEPT !.mark = @ + 1]
    /\ phase' = IF phase = "mark" /\ failed = {} THEN "delete" ELSE "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        entryDone, entryWrites, retryItems>>

MarkerError ==
    /\ phase \in {"mark", "markEmpty"}
    /\ writes' = [writes EXCEPT !.mark = @ + 1] /\ phase' = "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        entryDone, entryWrites, retryItems>>

DeleteDatabase ==
    /\ phase = "delete"
    /\ deleteIssued' = TRUE /\ writes' = [writes EXCEPT !.delete = @ + 1]
    /\ phase' = "return"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        loads, todo, seen, unreadable, failed, metadataOK,
        entryDone, entryWrites, retryItems>>

ReturnFromLoad ==
    /\ phase = "return" /\ phase' = "idle"
    /\ retryItems' = IF loads = 1
        THEN (unreadable \union failed) \intersect Missing ELSE retryItems
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites>>

Idle == phase = "idle" /\ UNCHANGED vars

Next ==
    \/ StartLoad \/ ReadFlag \/ OpenDatabase \/ NoDatabase \/ OpenError \/ OpenThrows
    \/ ReadMetadata \/ MetadataError \/ ListShared \/ ListError
    \/ SkipExisting \/ StartRead \/ ReadBytes \/ BytesUnavailable
    \/ UploadSuccess \/ UploadFailure \/ FinishItems
    \/ MarkerWritten \/ MarkerError \/ DeleteDatabase \/ ReturnFromLoad \/ Idle

DeleteIncomplete ==
    /\ phase = "scan" /\ todo = {} /\ ~AllShared
    /\ deleteIssued' = TRUE /\ writes' = [writes EXCEPT !.delete = @ + 1]
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        phase, loads, todo, seen, unreadable, failed, metadataOK,
        entryDone, entryWrites, retryItems>>

CompleteDespiteUnreadableBytes ==
    /\ phase = "scan" /\ todo = {} /\ unreadable \intersect Missing # {}
    /\ phase' = "mark"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

CompleteDespiteUploadFailure ==
    /\ phase = "scan" /\ todo = {} /\ failed \intersect Missing # {}
    /\ phase' = "mark"
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, loads, todo, seen, unreadable, failed, metadataOK,
        writes, entryDone, entryWrites, retryItems>>

WriteAfterCompletion ==
    /\ phase = "flag" /\ entryDone /\ writes.mark < MaxLoads
    /\ writes' = [writes EXCEPT !.mark = @ + 1]
    /\ UNCHANGED <<storage, oldDatabase, localItems, shared, flag,
        deleteIssued, phase, loads, todo, seen, unreadable, failed, metadataOK,
        entryDone, entryWrites, retryItems>>

Spec == Init /\ [][Next]_vars
====
