---- MODULE SharedLibrary ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Kinds, Names, Payloads, Cap, BackgroundItems, MaxFailures

VARIABLES scenario, index, blobs, queue, owner, status, pc,
          base, loaded, target, garbage, temporary,
          failures, failedAt, protected, background

vars == <<scenario, index, blobs, queue, owner, status, pc,
          base, loaded, target, garbage, temporary,
          failures, failedAt, protected, background>>

\* This is the ratifiable safety contract, not a claim that route.ts passes.
\* The normal path publishes metadata before reclaiming obsolete blobs.
\* The unchanged route's opposite ordering is RemoveBeforePublishing below;
\* returning [] after a read error is DiscardIndexOnReadError below.
\* These counterexample actions are deliberately absent from Next.
\*
\* Observation boundary: completion/rejection of each fs/promises operation,
\* lock entry/exit, and handler response. Local computation is folded into
\* the preceding observation. GET reads do not mutate the represented store
\* and are stuttering observations; neither GET errors nor malformed HTTP
\* input authorize changing it. No process crash, external writer, clock
\* reversal, or id collision is injected. IDs and times are fresh increasing
\* tokens; the two payload values stand for distinct nonempty byte strings.
\*
\* Each fixture has at most two queued, valid requests and one failing file
\* operation. Partial blob/temp writes and removal-before-rejection are
\* included. An index rename either publishes the whole temp file or fails
\* without publication. Existing valid index files seed the fixtures.
\*
\* route.ts has MAX_ITEMS = 60. The unchanged-code driver must implement
\* Cap = 2 by seeding 58 distinct, valid background records, newer than the
\* tracked initial records and older than new saves. Their bytes exist.
\* Project their metadata out of index, base and target; background.listed
\* says the group is indexed and background.complete says all its bytes
\* exist. Its keys are fixed, pairwise distinct and outside the tracked keys.
\* They survive every bounded save; delete-all removes them as well, with
\* their cleanup represented by RemoveBackgroundBlobs and stutters.
\* Do not rewrite the source constant. Map the two exposed capacity slots,
\* not the raw index length, to Cap. WithinCap checks both counts.
\* A driver must refuse a projection if the fixed background metadata has
\* changed, is partly indexed or is reordered inconsistently with its times.
\* Directory operations are phases; directory contents other than the index,
\* its temp file and item blobs are immaterial to these rules.

IDs == 1..4

Calls == 1..2

Scenarios == {"concurrent", "upsert", "trim", "delete-one", "delete-all", "recover"}

KindA == CHOOSE k \in Kinds : TRUE

KindB == CHOOSE k \in Kinds : k # KindA

NameA == CHOOSE n \in Names : TRUE

NameB == CHOOSE n \in Names : n # NameA

BytesA == CHOOSE b \in Payloads : TRUE

BytesB == CHOOSE b \in Payloads : b # BytesA

Members(s) == {s[i] : i \in 1..Len(s)}

SmallSeq(S) == UNION {[1..n -> S] : n \in 0..4}

Key(id) ==
    <<IF id \in {1, 2} \/ scenario = "upsert"
          \/ (scenario = "concurrent" /\ id = 3)
      THEN KindA ELSE KindB,
      IF id = 2 THEN NameB ELSE NameA>>

BytesFor(id) ==
    IF id = 2 \/ id = 4 \/ (scenario = "upsert" /\ id = 3)
    THEN BytesB ELSE BytesA

\* An index token denotes exactly this observable metadata record.
Record(id) == [id |-> id, kind |-> Key(id)[1], name |-> Key(id)[2], time |-> id]

IsPost(call) == call \in Calls /\ scenario \notin {"delete-one", "delete-all"}

NewID(call) == call + 2

DeleteAll == scenario = "delete-all"

Seed ==
    CASE scenario = "concurrent" -> <<>>
      [] scenario \in {"upsert", "recover"} -> <<1>>
      [] OTHER -> <<2, 1>>

InitialQueue ==
    IF scenario \in {"concurrent", "recover"} THEN <<1, 2>> ELSE <<1>>

OtherKeys(items, call) == SelectSeq(items, LAMBDA id : Key(id) # Key(NewID(call)))

Survivors(items, call) ==
    LET other == OtherKeys(items, call)
    IN SubSeq(other, 1, IF Len(other) < Cap THEN Len(other) ELSE Cap - 1)

Desired(items, call) ==
    IF IsPost(call)
    THEN <<NewID(call)>> \o Survivors(items, call)
    ELSE IF DeleteAll THEN <<>> ELSE SelectSeq(items, LAMBDA id : id # 1)

Obsolete(items, next) == SelectSeq(items, LAMBDA id : id \notin Members(next))

ListedItemsHaveBytes ==
    /\ \A id \in Members(index) : blobs[id] \in Payloads
    /\ background.listed => background.complete

\* No later request in these fixtures replaces or evicts the entries saved
\* in protected: the recovery fixture's next save uses the other key and
\* has a free slot. Thus this is the literal no-loss rule without making a
\* new policy choice about a later intentional deletion/upsert/eviction.
ReadFailurePreservesItems ==
    failedAt = "read" => (protected \subseteq Members(index) /\ background.listed)

UniqueKindName ==
    \A i, j \in 1..Len(index) : i # j => Key(index[i]) # Key(index[j])

WithinCap ==
    /\ Len(index) <= Cap
    /\ Len(index) + (IF background.listed THEN BackgroundItems ELSE 0) <= 60

SaveRetainsOtherItems ==
    (IsPost(owner) /\ pc \in {"cleanup", "success"}) =>
        (Tail(index) = Survivors(base, owner) /\ background.listed)

SuccessfulSaveIsFirst ==
    (IsPost(owner) /\ pc = "success") =>
        (Len(index) > 0 /\ index[1] = NewID(owner))

SuccessfulSaveHasGivenBytes ==
    (IsPost(owner) /\ pc = "success") =>
        blobs[NewID(owner)] = BytesFor(NewID(owner))

SuccessfulDeleteRemovesItem ==
    (owner \in Calls /\ ~IsPost(owner) /\ pc = "success") =>
        (IF DeleteAll THEN index = <<>> /\ ~background.listed ELSE 1 \notin Members(index))

OneWriter ==
    /\ Cardinality({c \in Calls : status[c] = "running"}) <= 1
    /\ \A c \in Calls : status[c] = "running" => owner = c
    /\ (pc \in {"idle", "done"}) = (owner = 0)

TypeOK ==
    /\ Cardinality(Kinds) = 2 /\ Cardinality(Names) = 2
    /\ Cardinality(Payloads) = 2 /\ Cap = 2 /\ BackgroundItems = 58 /\ MaxFailures = 1
    /\ scenario \in Scenarios
    /\ index \in SmallSeq(IDs)
    /\ blobs \in [IDs -> Payloads \cup {"missing", "partial"}]
    /\ queue \in SmallSeq(Calls)
    /\ owner \in {0} \cup Calls
    /\ status \in [Calls -> {"unused", "queued", "running", "ok", "error"}]
    /\ pc \in {"idle", "read", "blob-mkdir", "blob-write", "index-mkdir",
                 "index-write", "index-rename", "cleanup", "success", "error", "done"}
    /\ base \in SmallSeq(IDs) /\ loaded \in SmallSeq(IDs)
    /\ target \in SmallSeq(IDs) /\ garbage \in SmallSeq(IDs)
    /\ temporary \in [state : {"none", "partial", "ready"},
                        items : SmallSeq(IDs), keepBackground : BOOLEAN]
    /\ failures \in 0..MaxFailures
    /\ failedAt \in {"none", "read", "blob-mkdir", "blob-write", "index-mkdir",
                       "index-write", "index-rename", "remove"}
    /\ protected \subseteq IDs
    /\ background \in [listed : BOOLEAN, complete : BOOLEAN,
                         pending : BOOLEAN, targetListed : BOOLEAN]

SaveSucceeds == pc = "success" /\ IsPost(owner)

UpsertSucceeds == scenario = "upsert" /\ pc = "success" /\ index = <<3>>

TrimSucceeds == scenario = "trim" /\ pc = "success" /\ index = <<3, 2>>

DeleteOneSucceeds == scenario = "delete-one" /\ pc = "success" /\ index = <<2>>

DeleteAllSucceeds == scenario = "delete-all" /\ pc = "success" /\ index = <<>>

ConcurrentSavesSurvive ==
    scenario = "concurrent" /\ status[1] = "ok" /\ status[2] = "ok" /\ index = <<4, 3>>

ReadErrorThenSaveSucceeds ==
    /\ scenario = "recover" /\ failedAt = "read"
    /\ status[1] = "error" /\ status[2] = "ok" /\ index = <<4, 1>>

WriteErrorThenSaveSucceeds ==
    /\ scenario = "concurrent" /\ failedAt = "blob-write"
    /\ status[1] = "error" /\ status[2] = "ok" /\ index = <<4>>

RenameFailureKeepsIndex == pc = "error" /\ failedAt = "index-rename" /\ index = base

RemovalFailureKeepsIndexSafe == pc = "error" /\ failedAt = "remove" /\ index = target

Init ==
    /\ scenario \in Scenarios
    /\ index = Seed
    /\ blobs = [id \in IDs |-> IF id \in Members(Seed) THEN BytesFor(id) ELSE "missing"]
    /\ queue = InitialQueue
    /\ owner = 0
    /\ status = [c \in Calls |-> IF c \in Members(InitialQueue) THEN "queued" ELSE "unused"]
    /\ pc = "idle"
    /\ base = <<>> /\ loaded = <<>> /\ target = <<>> /\ garbage = <<>>
    /\ temporary = [state |-> "none", items |-> <<>>, keepBackground |-> FALSE]
    /\ failures = 0 /\ failedAt = "none" /\ protected = {}
    /\ background = [listed |-> TRUE, complete |-> TRUE,
                       pending |-> FALSE, targetListed |-> TRUE]

Acquire ==
    /\ pc = "idle" /\ queue # <<>>
    /\ owner' = Head(queue) /\ queue' = Tail(queue)
    /\ status' = [status EXCEPT ![Head(queue)] = "running"]
    /\ pc' = "read" /\ base' = index
    /\ loaded' = <<>> /\ target' = <<>> /\ garbage' = <<>>
    /\ UNCHANGED <<scenario, index, blobs, temporary, failures, failedAt, protected, background>>

ReadIndex ==
    /\ pc = "read"
    /\ loaded' = index /\ target' = Desired(index, owner)
    /\ garbage' = Obsolete(index, Desired(index, owner))
    /\ pc' = IF IsPost(owner) THEN "blob-mkdir" ELSE "index-mkdir"
    /\ background' = [background EXCEPT !.targetListed = ~DeleteAll]
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, status, base,
                    temporary, failures, failedAt, protected>>

ReadIndexFailure ==
    /\ pc = "read" /\ failures < MaxFailures
    /\ pc' = "error" /\ status' = [status EXCEPT ![owner] = "error"]
    /\ failures' = failures + 1 /\ failedAt' = "read" /\ protected' = Members(index)
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, base, loaded, target,
                    garbage, temporary, background>>

MakeDirectory ==
    /\ pc \in {"blob-mkdir", "index-mkdir"}
    /\ pc' = IF pc = "blob-mkdir" THEN "blob-write" ELSE "index-write"
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, status, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected, background>>

WriteBlob ==
    /\ pc = "blob-write"
    /\ blobs' = [blobs EXCEPT ![NewID(owner)] = BytesFor(NewID(owner))]
    /\ pc' = "index-mkdir"
    /\ UNCHANGED <<scenario, index, queue, owner, status, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected, background>>

WriteTemporaryIndex ==
    /\ pc = "index-write"
    /\ temporary' = [state |-> "ready", items |-> target,
                       keepBackground |-> background.targetListed]
    /\ pc' = "index-rename"
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, status, base, loaded,
                    target, garbage, failures, failedAt, protected, background>>

PublishIndex ==
    /\ pc = "index-rename" /\ temporary.state = "ready" /\ temporary.items = target
    /\ index' = temporary.items
    /\ temporary' = [state |-> "none", items |-> <<>>, keepBackground |-> FALSE]
    /\ pc' = "cleanup"
    /\ background' = [background EXCEPT !.listed = temporary.keepBackground,
                         !.pending = background.listed /\ ~temporary.keepBackground]
    /\ UNCHANGED <<scenario, blobs, queue, owner, status, base, loaded,
                    target, garbage, failures, failedAt, protected>>

RemoveObsoleteBlob ==
    /\ pc = "cleanup" /\ garbage # <<>>
    /\ Head(garbage) \notin Members(index)
    /\ blobs' = [blobs EXCEPT ![Head(garbage)] = "missing"]
    /\ garbage' = Tail(garbage)
    /\ UNCHANGED <<scenario, index, queue, owner, status, pc, base, loaded,
                    target, temporary, failures, failedAt, protected, background>>

\* The background is one aggregate: once its first blob disappears,
\* complete is false; further rm calls can stutter before the loop ends.
RemoveBackgroundBlobs ==
    /\ pc = "cleanup" /\ background.pending /\ ~background.listed
    /\ background' \in {[background EXCEPT !.complete = FALSE],
                          [background EXCEPT !.complete = FALSE, !.pending = FALSE]}
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, status, pc, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected>>

FileOperationFailure ==
    /\ failures < MaxFailures
    /\ pc \in {"blob-mkdir", "blob-write", "index-mkdir", "index-write", "index-rename", "cleanup"}
    /\ pc = "cleanup" => (garbage # <<>> \/ background.pending)
    /\ pc' = "error" /\ status' = [status EXCEPT ![owner] = "error"]
    /\ failures' = failures + 1
    /\ failedAt' = IF pc = "cleanup" THEN "remove" ELSE pc
    /\ IF pc = "cleanup"
       THEN \/ /\ garbage # <<>>
               /\ blobs' \in {blobs, [blobs EXCEPT ![Head(garbage)] = "missing"]}
               /\ UNCHANGED background
            \/ /\ background.pending
               /\ background' \in {background, [background EXCEPT !.complete = FALSE]}
               /\ UNCHANGED blobs
       ELSE /\ IF pc = "blob-write"
               THEN \E effect \in {"missing", "partial", BytesFor(NewID(owner))} :
                        blobs' = [blobs EXCEPT ![NewID(owner)] = effect]
               ELSE blobs' = blobs
            /\ UNCHANGED background
    /\ IF pc = "index-write"
       THEN temporary' \in {temporary,
                [state |-> "partial", items |-> <<>>, keepBackground |-> FALSE],
                [state |-> "ready", items |-> target,
                   keepBackground |-> background.targetListed]}
       ELSE temporary' = temporary
    /\ UNCHANGED <<scenario, index, queue, owner, base, loaded, target, garbage, protected>>

RespondSuccess ==
    /\ pc = "cleanup" /\ garbage = <<>> /\ ~background.pending
    /\ pc' = "success" /\ status' = [status EXCEPT ![owner] = "ok"]
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected, background>>

Release ==
    /\ pc \in {"success", "error"}
    /\ owner' = 0 /\ pc' = IF queue = <<>> THEN "done" ELSE "idle"
    /\ UNCHANGED <<scenario, index, blobs, queue, status, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected, background>>

Observe == UNCHANGED vars

Next ==
    \/ Acquire \/ ReadIndex \/ ReadIndexFailure \/ MakeDirectory \/ WriteBlob
    \/ WriteTemporaryIndex \/ PublishIndex \/ RemoveObsoleteBlob
    \/ RemoveBackgroundBlobs \/ FileOperationFailure \/ RespondSuccess \/ Release \/ Observe

\* The real route removes matching, trimmed or deleted blobs while the old
\* index still names them. Even the first successful rm violates safety;
\* a later failed write/rename/rm can make that state persist indefinitely.
RemoveBeforePublishing ==
    /\ pc \in {"blob-mkdir", "index-mkdir"}
    /\ \/ /\ garbage # <<>> /\ Head(garbage) \in Members(index)
          /\ blobs' = [blobs EXCEPT ![Head(garbage)] = "missing"]
          /\ UNCHANGED background
       \/ /\ DeleteAll /\ background.listed
          /\ background' = [background EXCEPT !.complete = FALSE]
          /\ UNCHANGED blobs
    /\ UNCHANGED <<scenario, index, queue, owner, status, pc, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected>>

\* The real readIndex catch returns [], allowing a later rename to forget
\* existing records. The bug is caught at publication, before the response.
DiscardIndexOnReadError ==
    /\ pc = "read" /\ IsPost(owner) /\ index # <<>> /\ failures < MaxFailures
    /\ failures' = failures + 1 /\ failedAt' = "read" /\ protected' = Members(index)
    /\ loaded' = <<>> /\ target' = <<NewID(owner)>> /\ garbage' = <<>>
    /\ background' = [background EXCEPT !.targetListed = FALSE]
    /\ pc' = "blob-mkdir"
    /\ UNCHANGED <<scenario, index, blobs, queue, owner, status, base, temporary>>

\* Regression documented beside withIndexLock: a second concurrent writer
\* publishes a stale empty snapshot and loses the first writer's record.
PublishStaleSave ==
    /\ scenario = "concurrent" /\ owner = 2 /\ status[1] = "ok"
    /\ pc = "index-rename"
    /\ index' = <<4>>
    /\ temporary' = [state |-> "none", items |-> <<>>, keepBackground |-> FALSE]
    /\ background' = [background EXCEPT !.listed = FALSE]
    /\ pc' = "cleanup"
    /\ UNCHANGED <<scenario, blobs, queue, owner, status, base, loaded,
                    target, garbage, failures, failedAt, protected>>

WriteWrongBytes ==
    /\ pc = "blob-write"
    /\ blobs' = [blobs EXCEPT ![NewID(owner)] =
         IF BytesFor(NewID(owner)) = BytesA THEN BytesB ELSE BytesA]
    /\ pc' = "index-mkdir"
    /\ UNCHANGED <<scenario, index, queue, owner, status, base, loaded,
                    target, garbage, temporary, failures, failedAt, protected, background>>

Spec == Init /\ [][Next]_vars
====
