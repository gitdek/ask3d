---- MODULE OpenScadCompiler ----
EXTENDS Naturals, FiniteSets

CONSTANTS MaxCompiles, MaxTimeouts
VARIABLES status, current, cancelAt, alive, timer, callbacks,
          applied, endings, peakWorkers, timeouts

vars == <<status, current, cancelAt, alive, timer, callbacks,
          applied, endings, peakWorkers, timeouts>>

JobIds == 1..(MaxCompiles + 1)
Outcomes == {"done", "error", "timeout"}
Compiles == current - (IF cancelAt = 0 THEN 0 ELSE 1)

\* Observe one mounted hook at the end of each synchronous call/handler,
\* after React's queued setters commit. current is jobIdRef.current.
\* cancelAt records the single cancel's invalidation token (0 means unused).
\* alive comes from Worker creation/termination; timer means timeoutRef is
\* non-null OR its scheduler entry is still armed. Thus teardown must clear
\* both the scheduler entry and the ref, including after a timer has fired.
\* callbacks contains jobs whose terminal notification can still be delivered.
\* Each fixture supplies one terminal notification per job; done and both
\* error paths share this abstraction. Finishing retires that job's handlers.
\* Replaced/cancelled jobs may deliver a saved notification, even though their
\* worker is terminated and their timer was cleared; these must be harmless.
\* Malformed message IDs are ignored and map to an unchanged step.
\*
\* Three driver observations avoid storing result/failure payloads:
\* applied is the job owning the last outcome-induced setter call since the
\* latest compile/cancel, or 0 if none. Resetting this observation does NOT
\* erase a retained result. endings counts accepted terminal callbacks in
\* that epoch. peakWorkers includes transient overlap inside synchronous calls.
\* The timeout budget counts actual timer dispatches, including stale ones.
\* Compile/cancel calls are external choices; no fairness is imposed on them.
\* Finish fairness is for the driver's own dispatch of a terminal notification
\* in these bounded fixtures, not for a person submitting or cancelling work.

TypeOK ==
    /\ status \in {"idle", "compiling"} \cup Outcomes
    /\ current \in 0..(MaxCompiles + 1)
    /\ cancelAt \in 0..current
    /\ Compiles \in 0..MaxCompiles
    /\ alive \subseteq JobIds
    /\ timer \in BOOLEAN
    /\ callbacks \subseteq JobIds
    /\ applied \in {0} \cup JobIds
    /\ endings \in 0..2
    /\ peakWorkers \in 0..(MaxCompiles + 1)
    /\ timeouts \in 0..MaxTimeouts

LatestOutcomeOnly == applied = 0 \/ applied = current

WorkerLifecycle ==
    /\ peakWorkers <= 1
    /\ alive = (IF status = "compiling" THEN {current} ELSE {})

SingleEndAndTimerCleared ==
    /\ endings <= 1
    /\ (status \in Outcomes => endings = 1 /\ ~timer)

CancelStaysIdle ==
    (cancelAt # 0 /\ current = cancelAt) =>
        (status = "idle" /\ applied = 0 /\ ~timer /\ alive = {})

LatestCanSucceed ==
    status = "done" /\ Compiles = MaxCompiles /\ callbacks # {}

CanFailAfterCancel ==
    status = "error" /\ cancelAt # 0 /\ current > cancelAt

CanTimeOut == status = "timeout"

UnreplacedEventuallyEnds ==
    \A j \in JobIds :
        (status = "compiling" /\ current = j) ~>
            (current # j \/ (status \in Outcomes /\ endings = 1 /\ ~timer))

Init ==
    /\ status = "idle"
    /\ current = 0
    /\ cancelAt = 0
    /\ alive = {}
    /\ timer = FALSE
    /\ callbacks = {}
    /\ applied = 0
    /\ endings = 0
    /\ peakWorkers = 0
    /\ timeouts = 0

Compile ==
    /\ Compiles < MaxCompiles
    /\ status' = "compiling"
    /\ current' = current + 1
    /\ alive' = {current + 1}
    /\ timer' = TRUE
    /\ callbacks' = callbacks \cup {current + 1}
    /\ applied' = 0
    /\ endings' = 0
    /\ peakWorkers' = IF peakWorkers = 0 THEN 1 ELSE peakWorkers
    /\ UNCHANGED <<cancelAt, timeouts>>

Cancel ==
    /\ cancelAt = 0
    /\ status' = "idle"
    /\ current' = current + 1
    /\ cancelAt' = current + 1
    /\ alive' = {}
    /\ timer' = FALSE
    /\ applied' = 0
    /\ endings' = 0
    /\ UNCHANGED <<callbacks, peakWorkers, timeouts>>

Finish ==
    /\ status = "compiling"
    /\ current \in callbacks
    /\ \E outcome \in Outcomes :
        /\ (outcome = "timeout" => timeouts < MaxTimeouts)
        /\ status' = outcome
        /\ timeouts' = timeouts + (IF outcome = "timeout" THEN 1 ELSE 0)
    /\ alive' = {}
    /\ timer' = FALSE
    /\ callbacks' = callbacks \ {current}
    /\ applied' = current
    /\ endings' = endings + 1
    /\ UNCHANGED <<current, cancelAt, peakWorkers>>

IgnoreStaleWorker ==
    /\ \E j \in callbacks : j # current
    /\ UNCHANGED vars

IgnoreStaleTimeout ==
    /\ \E j \in callbacks : j # current
    /\ timeouts < MaxTimeouts
    /\ timeouts' = timeouts + 1
    /\ UNCHANGED <<status, current, cancelAt, alive, timer, callbacks,
                   applied, endings, peakWorkers>>

Wait == UNCHANGED vars

Next == Compile \/ Cancel \/ Finish \/ IgnoreStaleWorker \/ IgnoreStaleTimeout \/ Wait

DispatchProgress == WF_vars(Finish)

\* Mutant: a saved callback omits its check against jobIdRef.current.
BugAcceptStale ==
    /\ \E j \in callbacks :
        /\ j # current
        /\ applied' = j
        /\ callbacks' = callbacks \ {j}
    /\ status' = "done"
    /\ alive' = {}
    /\ timer' = FALSE
    /\ endings' = endings + 1
    /\ UNCHANGED <<current, cancelAt, peakWorkers, timeouts>>

\* Mutant: a new worker is created before the previous one is terminated.
BugOverlapWorkers ==
    /\ status = "compiling"
    /\ Compiles < MaxCompiles
    /\ status' = "compiling"
    /\ current' = current + 1
    /\ alive' = {current + 1}
    /\ timer' = TRUE
    /\ callbacks' = callbacks \cup {current + 1}
    /\ applied' = 0
    /\ endings' = 0
    /\ peakWorkers' = Cardinality(alive) + 1
    /\ UNCHANGED <<cancelAt, timeouts>>

\* Mutant: success terminates the worker but forgets to clear the timer.
BugLeaveTimerArmed ==
    /\ status = "compiling"
    /\ current \in callbacks
    /\ status' = "done"
    /\ alive' = {}
    /\ callbacks' = callbacks \ {current}
    /\ applied' = current
    /\ endings' = endings + 1
    /\ UNCHANGED <<current, cancelAt, timer, peakWorkers, timeouts>>

Spec == Init /\ [][Next]_vars
====
