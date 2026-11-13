---- MODULE StatueTask ----
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS MaxTasks, MaxMounts, PollLimit, Names

VARIABLES mount, sidecar, dismissed, cleared, completed, rejected,
          phase, running, task, lastTask, lastName, name, pollFailures, error,
          recovery, admission, outcome

vars == <<mount, sidecar, dismissed, cleared, completed, rejected,
          phase, running, task, lastTask, lastName, name, pollFailures, error,
          recovery, admission, outcome>>

Tasks == 1..MaxTasks
FreshName(t) == "source-statue-" \o ToString(t) \o ".stl"
RecoveredName(t) == "recovered-statue-" \o ToString(t) \o ".stl"
RemoteStates == {"absent", "active", "fresh", "old", "failed"}
Phases == {"idle", "starting", "polling", "downloading", "delivering"}
Errors == {"start-error", "task-error", "download-error", "delivery-error", "poll-error"}
Successes == {"delivered", "delivered-after-clear", "delivered-after-rejection"}
Delivery == [task : Tasks, name : Names]
Rejection == [task : Tasks, name : Names, mount : 1..MaxMounts]
NoRejection == [task |-> 0, name |-> "", mount |-> 0]
NoAdmission == [kind |-> "none", busy |-> FALSE, cleared |-> FALSE]
PendingRecovery == [state |-> "pending", task |-> 0, status |-> "absent"]
Existing == {t \in Tasks : sidecar[t] # "absent"}
Latest == IF Existing = {} THEN 0 ELSE CHOOSE t \in Existing : \A u \in Existing : u <= t
FinishedTasks == {completed[i].task : i \in 1..Len(completed)}

\* State projection for the driver:
\* - phase is the currently awaited operation, sampled after synchronous work
\*   and its catch/finally microtasks have settled; running is a ref and
\*   lastTask/lastName project the adopted id and basename from the other ref.
\* - active folds queued/running together; fresh means succeeded with age < 600;
\*   old means succeeded with age >= 600. The sidecar keeps both task records.
\* - Names are final STL filenames; the two inputs share the basename "source".
\*   IDs 1 and 2 stand for distinct opaque sidecar IDs, in creation order.
\*   lastName is the ref's basename rendered with its task ID, not a new ref.
\* - completed records ONLY fulfilled onDeliver calls. rejected is the last
\*   rejected call and its mount, which F2/B guarantees saved nothing.
\* - cleared is the monitor's history of successful Clear writes; dismissed is
\*   the actual single localStorage value. Neither resets on a page reload.
\* - admission records the guard and Clear history immediately BEFORE the last
\*   accepted start/adoption. Clear after adoption does not change this record.
\* - outcome records the last settled exit or a start following an error;
\*   error categorizes the onError message by its originating failure, including
\*   the hook's two friendly-message rewrites. It is not a new hook field.
\* - a reload discards the old page's JavaScript and creates fresh React state,
\*   refs and effect; sidecar, storage, and observation history survive. Callback
\*   identities may change within a mount: RefreshRecovery is effect cleanup
\*   and rerun, cancelling only its pending latest response, not adopted work.
\*   No fairness is assumed of promises; failed callbacks reject before saving.
\* - dismissed models the single localStorage slot, not a set of receipts.
\*   Recovery's history guards express the ratified no-replay/Clear contract;
\*   the driver must observe actual adoption, never implement these guards in
\*   its stub. A delayed response that bypasses a changed slot must fail fit.
\* - a successful callback, receipt write and finally settle in one driver
\*   step; storage operations succeed, as in the captured scope.
\* Driver acceptance: run EACH of the four named regression witnesses below
\* directly as well as random traces, and check every real hook step. In
\* particular wait for the latest response after reload; reaching idle alone
\* does not demonstrate that a completed task was skipped. Same-page retry
\* changes a callback identity to rerun the actual React effect; it does not
\* call an invented retry method. Include delayed responses, busy admission,
\* Clear during adopted work, and each failure category in random schedules.
\* Direct scripts (all completions are observed callback fulfillments):
\* 1. Deliver task 1, do not Clear, reload, resolve fresh latest task 1: skip.
\* 2. Recover/deliver task 1; start/create task 2, reload, recover/deliver it.
\* 3. Reject task 1's callback, reload, recover it and fulfill its callback.
\* 4. Reject a fresh task's callback; change a callback identity without a
\*    reload, resolve latest, and fulfill the retry with the original filename.
\* Bug actions represent plausible regressions, not claims about #29's code.

DeliveredAtMostOnce ==
    \A i, j \in 1..Len(completed) :
        completed[i].task = completed[j].task => i = j

NamesNeverReplace ==
    \A i, j \in 1..Len(completed) :
        completed[i].task # completed[j].task => completed[i].name # completed[j].name

OneTaskAtATime ==
    /\ ~admission.busy
    /\ running = (phase # "idle")

ClearBlocksFutureRecovery ==
    admission.kind = "recover" => ~admission.cleared

ErrorsReleaseTheHook ==
    /\ (outcome \in Errors => phase = "idle" /\ ~running /\ error = outcome)
    /\ (phase = "polling" => pollFailures < PollLimit)

TypeOK ==
    /\ mount \in 1..MaxMounts
    /\ sidecar \in [Tasks -> RemoteStates]
    /\ dismissed \in Tasks \cup {0}
    /\ cleared \subseteq Tasks
    /\ completed \in Seq(Delivery)
    /\ Len(completed) <= MaxTasks + 1
    /\ rejected \in Rejection \cup {NoRejection}
    /\ phase \in Phases
    /\ running \in BOOLEAN
    /\ task \in Tasks \cup {0}
    /\ lastTask \in Tasks \cup {0}
    /\ lastName \in Names \cup {""}
    /\ name \in Names \cup {""}
    /\ pollFailures \in 0..PollLimit
    /\ error \in Errors \cup {""}
    /\ recovery \in [state : {"pending", "ready", "done"},
                       task : Tasks \cup {0}, status : RemoteStates]
    /\ admission \in [kind : {"none", "start", "recover"}, busy : BOOLEAN, cleared : BOOLEAN]
    /\ outcome \in Errors \cup Successes \cup {"none", "restarted"}

CanSkipCompletedOnReload ==
    /\ mount > 1
    /\ phase = "idle"
    /\ lastTask = 0
    /\ recovery.state = "done"
    /\ recovery.status = "fresh"
    /\ recovery.task \in FinishedTasks
    /\ recovery.task \notin cleared
    /\ dismissed = recovery.task

CanRecoverSecondStatue ==
    /\ Len(completed) = 2
    /\ mount = 2
    /\ completed[1].task = 1
    /\ completed[2].task = 2
    /\ \A i \in 1..2 : completed[i].name = RecoveredName(completed[i].task)

CanDeliverAfterClear == outcome = "delivered-after-clear"
CanRetryRejectedAfterReload ==
    /\ outcome = "delivered-after-rejection"
    /\ rejected.mount < mount
    /\ rejected.task = task

CanRetryRejectedOnSamePage ==
    /\ outcome = "delivered-after-rejection"
    /\ rejected.mount = mount
    /\ rejected.task = task
    /\ rejected.name = name
    /\ name = FreshName(task)

CanStartAfterError == phase = "starting" /\ outcome = "restarted"

Init ==
    /\ mount = 1
    /\ \E seed \in RemoteStates :
        sidecar = [t \in Tasks |-> IF t = 1 THEN seed ELSE "absent"]
    /\ dismissed = 0
    /\ cleared = {}
    /\ completed = <<>>
    /\ rejected = NoRejection
    /\ phase = "idle"
    /\ running = FALSE
    /\ task = 0
    /\ lastTask = 0
    /\ lastName = ""
    /\ name = ""
    /\ pollFailures = 0
    /\ error = ""
    /\ recovery = PendingRecovery
    /\ admission = NoAdmission
    /\ outcome = "none"

Start ==
    /\ ~running
    /\ phase' = "starting"
    /\ running' = TRUE
    /\ task' = 0
    /\ name' = ""
    /\ pollFailures' = 0
    /\ error' = ""
    /\ admission' = [kind |-> "start", busy |-> running, cleared |-> FALSE]
    /\ outcome' = IF outcome \in Errors THEN "restarted" ELSE "none"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    lastTask, lastName, recovery>>

RefuseStart == running /\ UNCHANGED vars

Create ==
    /\ phase = "starting"
    /\ Latest < MaxTasks
    /\ \A t \in Tasks : sidecar[t] # "active"
    /\ LET t == Latest + 1 IN
        /\ sidecar' = [sidecar EXCEPT ![t] = "active"]
        /\ task' = t
        /\ lastTask' = t
        /\ lastName' = FreshName(t)
        /\ name' = FreshName(t)
    /\ phase' = "polling"
    /\ UNCHANGED <<mount, dismissed, cleared, completed, rejected, running,
                    pollFailures, error, recovery, admission, outcome>>

\* Capture and receipt are separate: a delayed latest response can lose a race
\* with start, Clear, completion, or aging. The guard is checked on receipt.
ReadLatest ==
    /\ recovery.state = "pending"
    /\ recovery' = [state |-> "ready", task |-> Latest,
                      status |-> IF Latest = 0 THEN "absent" ELSE sidecar[Latest]]
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, lastName, name, pollFailures,
                    error, admission, outcome>>

Recoverable ==
    /\ recovery.task # 0
    /\ recovery.status \in {"active", "fresh"}
    /\ recovery.task # dismissed
    /\ recovery.task \notin cleared
    /\ recovery.task \notin FinishedTasks
    /\ ~running

Recover ==
    /\ recovery.state = "ready"
    /\ Recoverable
    /\ recovery' = [recovery EXCEPT !.state = "done"]
    /\ phase' = "polling"
    /\ running' = TRUE
    /\ task' = recovery.task
    /\ lastTask' = recovery.task
    /\ name' = IF lastTask = recovery.task THEN lastName ELSE RecoveredName(recovery.task)
    /\ lastName' = name'
    /\ pollFailures' = 0
    /\ admission' = [kind |-> "recover", busy |-> running,
                       cleared |-> recovery.task \in cleared]
    /\ outcome' = "none"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected, error>>

RefreshRecovery ==
    /\ recovery' = PendingRecovery
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, lastName, name, pollFailures,
                    error, admission, outcome>>

IgnoreRecovery ==
    /\ recovery.state = "ready"
    /\ ~Recoverable
    /\ recovery' = [recovery EXCEPT !.state = "done"]
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, lastName, name, pollFailures,
                    error, admission, outcome>>

RemoteFinish(t, s) ==
    /\ sidecar[t] = "active"
    /\ sidecar' = [sidecar EXCEPT ![t] = s]
    /\ UNCHANGED <<mount, dismissed, cleared, completed, rejected, phase,
                    running, task, lastTask, lastName, name, pollFailures, error,
                    recovery, admission, outcome>>

Age(t) ==
    /\ sidecar[t] = "fresh"
    /\ sidecar' = [sidecar EXCEPT ![t] = "old"]
    /\ UNCHANGED <<mount, dismissed, cleared, completed, rejected, phase,
                    running, task, lastTask, lastName, name, pollFailures, error,
                    recovery, admission, outcome>>

Poll ==
    /\ phase = "polling"
    /\ sidecar[task] \in {"active", "fresh", "old"}
    /\ phase' = IF sidecar[task] = "active" THEN "polling" ELSE "downloading"
    /\ pollFailures' = 0
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    running, task, lastTask, lastName, name, error, recovery, admission, outcome>>

PollBlip ==
    /\ phase = "polling"
    /\ pollFailures + 1 < PollLimit
    /\ pollFailures' = pollFailures + 1
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, lastName, name, error,
                    recovery, admission, outcome>>

FailureReady(e) ==
    \/ (e = "start-error" /\ phase = "starting")
    \/ (e = "task-error" /\ phase = "polling" /\ sidecar[task] = "failed")
    \/ (e = "poll-error" /\ phase = "polling" /\ pollFailures + 1 = PollLimit)
    \/ (e = "download-error" /\ phase = "downloading")
    \/ (e = "delivery-error" /\ phase = "delivering")

Fail(e) ==
    /\ FailureReady(e)
    /\ phase' = "idle"
    /\ running' = FALSE
    /\ error' = e
    /\ outcome' = e
    /\ pollFailures' = IF e = "poll-error" THEN PollLimit ELSE 0
    /\ rejected' = IF e = "delivery-error"
                     THEN [task |-> task, name |-> name, mount |-> mount] ELSE rejected
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, task,
                    lastTask, lastName, name, recovery, admission>>

Download ==
    /\ phase = "downloading"
    /\ phase' = "delivering"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    running, task, lastTask, lastName, name, pollFailures,
                    error, recovery, admission, outcome>>

Complete ==
    /\ phase = "delivering"
    /\ completed' = Append(completed, [task |-> task, name |-> name])
    /\ dismissed' = task
    /\ phase' = "idle"
    /\ running' = FALSE
    /\ outcome' = IF task \in cleared THEN "delivered-after-clear"
                   ELSE IF rejected.task = task
                        THEN "delivered-after-rejection" ELSE "delivered"
    /\ UNCHANGED <<mount, sidecar, cleared, rejected, task,
                    lastTask, lastName, name, pollFailures, error, recovery, admission>>

Clear ==
    /\ lastTask # 0
    /\ dismissed' = lastTask
    /\ cleared' = cleared \cup {lastTask}
    /\ UNCHANGED <<mount, sidecar, completed, rejected, phase, running, task,
                    lastTask, lastName, name, pollFailures, error, recovery, admission, outcome>>

Reload ==
    /\ mount < MaxMounts
    /\ mount' = mount + 1
    /\ phase' = "idle"
    /\ running' = FALSE
    /\ task' = 0
    /\ lastTask' = 0
    /\ lastName' = ""
    /\ name' = ""
    /\ pollFailures' = 0
    /\ error' = ""
    /\ recovery' = PendingRecovery
    /\ admission' = NoAdmission
    /\ outcome' = "none"
    /\ UNCHANGED <<sidecar, dismissed, cleared, completed, rejected>>

\* Waiting is legitimate even if no bounded new task/mount remains. It also
\* covers timers, nonterminal progress, and Clear before any task was adopted.
Wait == UNCHANGED vars

Next ==
    \/ Start
    \/ RefuseStart
    \/ Create
    \/ ReadLatest
    \/ Recover
    \/ IgnoreRecovery
    \/ RefreshRecovery
    \/ \E t \in Tasks, s \in {"fresh", "failed"} : RemoteFinish(t, s)
    \/ \E t \in Tasks : Age(t)
    \/ Poll
    \/ PollBlip
    \/ \E e \in Errors : Fail(e)
    \/ Download
    \/ Complete
    \/ Clear
    \/ Reload
    \/ Wait

\* Mistake: recovery ignores the completed receipt, then the ordinary download
\* and completion steps deliver the same task a second time.
ReplayCompletedTask ==
    /\ mount > 1
    /\ recovery.state = "ready"
    /\ recovery.status \in {"active", "fresh"}
    /\ recovery.task \in FinishedTasks
    /\ recovery.task \notin cleared
    /\ ~running
    /\ recovery' = [recovery EXCEPT !.state = "done"]
    /\ phase' = "polling"
    /\ running' = TRUE
    /\ task' = recovery.task
    /\ lastTask' = recovery.task
    /\ name' = RecoveredName(recovery.task)
    /\ lastName' = name'
    /\ pollFailures' = 0
    /\ admission' = [kind |-> "recover", busy |-> running, cleared |-> FALSE]
    /\ outcome' = "none"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected, error>>

\* Mistake: assign a different recovered task the filename of the first one;
\* its ordinary successful callback then replaces the first library item.
ReuseRecoveredName ==
    /\ recovery.state = "ready"
    /\ recovery.task # 0
    /\ recovery.status \in {"active", "fresh"}
    /\ recovery.task # dismissed
    /\ recovery.task \notin cleared
    /\ recovery.task \notin FinishedTasks
    /\ ~running
    /\ \E i \in 1..Len(completed) :
        /\ completed[i].task # recovery.task
        /\ completed[i].name = RecoveredName(completed[i].task)
        /\ name' = completed[i].name
    /\ recovery' = [recovery EXCEPT !.state = "done"]
    /\ phase' = "polling"
    /\ running' = TRUE
    /\ task' = recovery.task
    /\ lastTask' = recovery.task
    /\ lastName' = name'
    /\ pollFailures' = 0
    /\ admission' = [kind |-> "recover", busy |-> running, cleared |-> FALSE]
    /\ outcome' = "none"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected, error>>

Spec == Init /\ [][Next]_vars
====
