---- MODULE AutoRepair ----
EXTENDS Naturals, FiniteSets

CONSTANTS Programs, NoProgram, MaxRepairs
VARIABLES phase, current, latest, cached, visible, attempt, count, sent, pending, retrySource, observation

vars == <<phase, current, latest, cached, visible, attempt, count, sent, pending, retrySource, observation>>

\* One active human message; HumanMessage starts a new epoch, without
\* discarding the viewer. Programs are interned source strings, not jobs.
\* Read after React effects/state updates settle: latest/cached/count/pending
\* mirror lastCompiledSourceRef/lastSuccessfulSourceRef/repairAttemptsRef/
\* pendingRepairRef; attempt is the returned state. visible means the cached
\* program's model is still displayed. sent is a driver counter of sendRepair
\* calls since reset, even when the hook has reset its own counter.
\* phase is the last observed round outcome, not an extra hook field.
\* current follows every program reply (even a skipped one), reset, expect
\* and explicit retry. It is separate from the hook's last-compiled ref.
\* retrySource is the source of the currently displayed timeout retry button.
\* observation records the input and callback calls of this settled step.
\* duplicate is identity-based (a previously handled result/failure object),
\* NOT source equality. The driver retains that identity ledger across reset.
\* Callback identity churn with the same input object is a duplicate delivery.
\* Compiler objects/geometry are abstracted by source, identity class and
\* outcome; the driver supplies concrete distinct objects/STL for those classes.
\* A finished reply means a non-ready -> ready chat edge, not every rerender.

Sources == Programs \cup {NoProgram}
Phases == {"idle", "compiling", "repairing", "accepted", "error"}
Signals == {"good", "debris", "empty", "code", "timeout", "environment"}
Inputs == Signals \cup {"initial", "human", "reply", "noCode", "nullReply", "replace", "expect", "retry"}
Calls == {"compile", "cancel", "sendRepair", "showError", "clearError", "onModel", "onAccepted"}
Core == <<phase, current, latest, cached, visible, attempt, count, sent, pending, retrySource>>
CoreType == Phases \X Sources \X Sources \X Sources \X BOOLEAN \X (0..(MaxRepairs + 1)) \X (0..(MaxRepairs + 1)) \X (0..(MaxRepairs + 1)) \X BOOLEAN \X Sources
BlankCore == <<"idle", NoProgram, NoProgram, NoProgram, FALSE, 0, 0, 0, FALSE, NoProgram>>

TypeOK ==
    /\ MaxRepairs = 2
    /\ Cardinality(Programs) = 3
    /\ NoProgram \notin Programs
    /\ Core \in CoreType
    /\ (visible => cached \in Programs)
    /\ observation \in [input : Inputs, source : Sources,
         pendingBefore : BOOLEAN, duplicate : BOOLEAN, target : Sources,
         calls : SUBSET Calls, before : CoreType]

RepairReplyAccounted ==
    (observation.input = "reply" /\ observation.pendingBefore)
    => observation.calls \cap {"compile", "sendRepair", "showError"} # {}

TwoRepairsPerHuman ==
    /\ sent <= MaxRepairs
    /\ (observation.input = "human" =>
         /\ sent = 0 /\ attempt = 0 /\ count = 0 /\ ~pending
         /\ latest = NoProgram /\ current = NoProgram
         /\ "cancel" \in observation.calls)

CurrentAndOnce ==
    (observation.input \in Signals /\
      (observation.source # observation.target \/ observation.duplicate))
    => (observation.calls = {} /\ Core = observation.before)

FinishedRoundIsClear ==
    /\ attempt = count
    /\ (phase \in {"accepted", "error"} =>
         (attempt = 0 /\ count = 0 /\ ~pending))

InfrastructureIsNotRepaired ==
    (observation.input \in {"timeout", "environment"} /\
      observation.source = observation.target /\ ~observation.duplicate)
    => ("showError" \in observation.calls /\
        "sendRepair" \notin observation.calls /\ phase = "error")

SkipOnlyVisibleModel ==
    (observation.input = "reply" /\ observation.calls = {})
    => (observation.source = cached /\ visible /\ ~observation.pendingBefore)

ModelAccepted == phase = "accepted" /\ "onAccepted" \in observation.calls
BudgetExhausted == phase = "error" /\ sent = MaxRepairs /\ observation.input \in {"reply", "empty", "code"}
TimeoutShown == phase = "error" /\ observation.input = "timeout" /\ "showError" \in observation.calls
CompilerUnavailableShown == phase = "error" /\ observation.input = "environment" /\ "showError" \in observation.calls
RepairReplyCompiled == observation.input = "reply" /\ observation.pendingBefore /\ "compile" \in observation.calls

\* Only an ignored compiler input needs a snapshot to check that it changed
\* nothing. Other observations store BlankCore, avoiding irrelevant history.
Observe(k, p, duplicateInput, effects) ==
    [input |-> k, source |-> p,
     pendingBefore |-> IF k = "reply" THEN pending ELSE FALSE,
     duplicate |-> duplicateInput,
     target |-> IF k \in Signals THEN current ELSE NoProgram,
     calls |-> effects,
     before |-> IF k \in Signals /\ (p # current \/ duplicateInput)
                THEN Core ELSE BlankCore]

Init ==
    /\ phase = "idle"
    /\ current = NoProgram /\ latest = NoProgram /\ cached = NoProgram
    /\ visible = FALSE /\ attempt = 0 /\ count = 0 /\ sent = 0
    /\ pending = FALSE /\ retrySource = NoProgram
    /\ observation = [input |-> "initial", source |-> NoProgram,
         pendingBefore |-> FALSE, duplicate |-> FALSE, target |-> NoProgram,
         calls |-> {}, before |-> BlankCore]

HumanMessage ==
    /\ phase' = "idle"
    /\ latest' = NoProgram /\ current' = NoProgram
    /\ attempt' = 0 /\ count' = 0 /\ sent' = 0 /\ pending' = FALSE
    /\ UNCHANGED <<cached, visible, retrySource>>
    /\ observation' = Observe("human", NoProgram, FALSE, {"cancel"})

\* A new program is linted before compile. clearError is showError(null).
CompileReply(p) ==
    /\ phase' = "compiling" /\ latest' = p /\ current' = p /\ pending' = FALSE
    /\ retrySource' = NoProgram
    /\ UNCHANGED <<cached, visible, attempt, count, sent>>
    /\ observation' = Observe("reply", p, FALSE, {"clearError", "compile"})

\* extra contains onModel for debris or clearError for a newly linted reply.
\* nextSource is unchanged when reusing the pending errors of a repair.
SendRepair(k, p, nextSource, extra) ==
    /\ sent < MaxRepairs
    /\ phase' = "repairing" /\ latest' = nextSource
    /\ current' = IF k = "reply" THEN p ELSE current
    /\ retrySource' = IF "clearError" \in extra THEN NoProgram ELSE retrySource
    /\ attempt' = count + 1 /\ count' = count + 1 /\ sent' = sent + 1
    /\ pending' = TRUE /\ UNCHANGED cached
    /\ visible' = IF "onModel" \in extra THEN p = cached ELSE visible
    /\ observation' = Observe(k, p, FALSE, extra \cup {"sendRepair"})

ShowFailure(k, p, nextSource, extra) ==
    /\ phase' = "error" /\ latest' = nextSource
    /\ current' = IF k = "reply" THEN p ELSE current
    /\ retrySource' = IF k = "timeout" THEN p ELSE NoProgram
    /\ attempt' = 0 /\ count' = 0 /\ pending' = FALSE
    /\ UNCHANGED <<cached, sent>>
    /\ visible' = IF "onModel" \in extra THEN p = cached ELSE visible
    /\ observation' = Observe(k, p, FALSE, extra \cup {"showError"})

RepairOrFail(k, p, nextSource, extra) ==
    \/ SendRepair(k, p, nextSource, extra)
    \/ (sent = MaxRepairs /\ ShowFailure(k, p, nextSource, extra))

SkipVisibleReply(p) ==
    /\ p = cached /\ visible /\ ~pending
    /\ current' = p
    /\ UNCHANGED <<phase, latest, cached, visible, attempt, count, sent, pending, retrySource>>
    /\ observation' = Observe("reply", p, FALSE, {})

\* The issue explicitly permits compile, another failed attempt, OR an error
\* for a repair reply. It does not choose one fix for the cached-source bug.
CachedRepairReply(p) ==
    /\ p = cached /\ pending
    /\ (CompileReply(p)
        \/ RepairOrFail("reply", p, latest, {})
        \/ ShowFailure("reply", p, latest, {}))

FinishedReply(p) ==
    \/ SkipVisibleReply(p)
    \/ CachedRepairReply(p)
    \/ (/\ ~(p = cached /\ (visible \/ pending))
        /\ IF p = latest /\ pending
           THEN RepairOrFail("reply", p, latest, {})
           ELSE (CompileReply(p) \/ RepairOrFail("reply", p, p, {"clearError"})))

NoCodeReply ==
    \/ (pending /\ ShowFailure("noCode", NoProgram, latest, {}))
    \/ (/\ ~pending
        /\ UNCHANGED <<phase, current, latest, cached, visible, attempt, count, sent, pending, retrySource>>
        /\ observation' = Observe("noCode", NoProgram, FALSE, {}))

NullReply ==
    /\ UNCHANGED <<phase, current, latest, cached, visible, attempt, count, sent, pending, retrySource>>
    /\ observation' = Observe("nullReply", NoProgram, FALSE, {})

AcceptModel(k, p) ==
    /\ phase' = "accepted" /\ cached' = p /\ visible' = TRUE
    /\ attempt' = 0 /\ count' = 0 /\ pending' = FALSE
    /\ UNCHANGED <<current, latest, sent, retrySource>>
    /\ observation' = Observe(k, p, FALSE, {"onModel", "onAccepted"})

CompilerSignal(k, p, duplicateInput) ==
    IF p # current \/ duplicateInput
    THEN /\ UNCHANGED <<phase, current, latest, cached, visible, attempt, count, sent, pending, retrySource>>
         /\ observation' = Observe(k, p, duplicateInput, {})
    ELSE \/ (k = "good" /\ AcceptModel(k, p))
         \/ (k = "debris" /\
              IF sent < MaxRepairs
              THEN SendRepair(k, p, latest, {"onModel"})
              ELSE AcceptModel(k, p))
         \/ (k \in {"empty", "code"} /\ RepairOrFail(k, p, latest, {}))
         \/ (k \in {"timeout", "environment"} /\ ShowFailure(k, p, latest, {}))

\* The external viewer action and modelReplaced notification are one step.
ModelReplaced ==
    /\ cached' = NoProgram /\ visible' = FALSE
    /\ UNCHANGED <<phase, current, latest, attempt, count, sent, pending, retrySource>>
    /\ observation' = Observe("replace", NoProgram, FALSE, {})

\* expect follows a caller-started compile; timeout Retry explicitly starts
\* and re-arms an older source. Both make that source current by user action.
ExpectSource(p) ==
    /\ latest' = p /\ current' = p /\ phase' = "compiling"
    /\ UNCHANGED <<cached, visible, attempt, count, sent, pending, retrySource>>
    /\ observation' = Observe("expect", p, FALSE, {})

RetryTimeout ==
    /\ retrySource \in Programs
    /\ latest' = retrySource /\ current' = retrySource /\ phase' = "compiling"
    /\ retrySource' = NoProgram
    /\ UNCHANGED <<cached, visible, attempt, count, sent, pending>>
    /\ observation' = Observe("retry", retrySource, FALSE, {"clearError", "compile"})

\* Idle waiting, chat streaming, unchanged ready status and dependency-only
\* rerenders with no new handled object have no abstract effect. No progress
\* is assumed of the chat/compiler; this request imposes safety, not liveness.
Wait == UNCHANGED vars

Next ==
    \/ HumanMessage
    \/ \E p \in Programs : FinishedReply(p) \/ ExpectSource(p)
    \/ NoCodeReply \/ NullReply
    \/ \E k \in Signals, p \in Programs, d \in BOOLEAN : CompilerSignal(k, p, d)
    \/ ModelReplaced \/ RetryTimeout \/ Wait

\* The exact reported regression: the cached successful program arrives
\* during repair, but the successful-source early return consumes no errors,
\* makes no call and leaves the counted attempt and pending errors in place.
IgnoreCachedRepairReply ==
    /\ pending /\ cached \in Programs /\ visible /\ latest # cached
    /\ current' = cached
    /\ UNCHANGED <<phase, latest, cached, visible, attempt, count, sent, pending, retrySource>>
    /\ observation' = Observe("reply", cached, FALSE, {})

\* The exhaustion/timeout/environment paths in the snapshot can show an
\* error while leaving repairAttemptsRef and the returned attempt nonzero.
KeepAttemptAfterError ==
    /\ phase = "compiling" /\ count > 0 /\ latest \in Programs /\ current = latest
    /\ phase' = "error" /\ pending' = FALSE
    /\ retrySource' = latest
    /\ UNCHANGED <<current, latest, cached, visible, attempt, count, sent>>
    /\ observation' = Observe("timeout", latest, FALSE, {"showError"})

Spec == Init /\ [][Next]_vars
====
