---- MODULE StatueTask ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxTasks, MaxMounts, PollLimit, Names

VARIABLES mount, sidecar, dismissed, cleared, completed, rejected,
          phase, running, task, lastTask, name, pollFailures, error,
          recovery, admission, outcome

vars == <<mount, sidecar, dismissed, cleared, completed, rejected,
          phase, running, task, lastTask, name, pollFailures, error,
          recovery, admission, outcome>>

Tasks == 1..MaxTasks
RecoveredName == "recovered-statue.stl"
RemoteStates == {"absent", "active", "fresh", "old", "failed"}
Phases == {"idle", "starting", "polling", "downloading", "delivering"}
Errors == {"start-error", "task-error", "download-error", "delivery-error", "poll-error"}
Successes == {"delivered", "delivered-after-clear", "delivered-after-rejection"}
Delivery == [task : Tasks, name : Names]
NoRejection == [task |-> 0, name |-> ""]
NoAdmission == [kind |-> "none", busy |-> FALSE, cleared |-> FALSE]
PendingRecovery == [state |-> "pending", task |-> 0, status |-> "absent"]
Existing == {t \in Tasks : sidecar[t] # "absent"}
Latest == IF Existing = {} THEN 0 ELSE CHOOSE t \in Existing : \A u \in Existing : u <= t
FinishedTasks == {completed[i].task : i \in 1..Len(completed)}

\* State projection for the driver:
\* - phase is the currently awaited operation, sampled after synchronous work
\*   and its catch/finally microtasks have settled; running and lastTask are refs.
\* - active folds queued/running together; fresh means succeeded with age < 600;
\*   old means succeeded with age >= 600. The sidecar keeps both task records.
\* - Names are final STL filenames, including equal basenames for different inputs.
\* - completed records ONLY fulfilled onDeliver calls. rejected is the last
\*   rejected call, which the issue guarantees saved nothing. Both are monitors.
\* - cleared is the monitor's history of successful Clear writes; dismissed is
\*   the actual single localStorage value. Neither resets on a page reload.
\* - admission records the guard and Clear history immediately BEFORE the last
\*   accepted start/adoption. Clear after adoption does not change this record.
\* - outcome records the last settled exit or a start following an error;
\*   error categorizes the onError message by its originating failure, including
\*   the hook's two friendly-message rewrites. It is not a new hook field.
\* - a reload discards the old page's JavaScript and creates fresh React state,
\*   refs and effect; sidecar, storage, and observation history survive. Callback
\*   identities stay stable within a mount. No fairness is assumed of promises.
\* The contract restricts successful commits, not callback invocation. The two
\* bug actions below expose the unchanged hook's reported violations, not fixes.

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
    /\ rejected \in Delivery \cup {NoRejection}
    /\ phase \in Phases
    /\ running \in BOOLEAN
    /\ task \in Tasks \cup {0}
    /\ lastTask \in Tasks \cup {0}
    /\ name \in Names \cup {""}
    /\ pollFailures \in 0..PollLimit
    /\ error \in Errors \cup {""}
    /\ recovery \in [state : {"pending", "ready", "done"},
                       task : Tasks \cup {0}, status : RemoteStates]
    /\ admission \in [kind : {"none", "start", "recover"}, busy : BOOLEAN, cleared : BOOLEAN]
    /\ outcome \in Errors \cup Successes \cup {"none", "restarted"}

CanDeliver == outcome = "delivered"
CanDeliverAfterClear == outcome = "delivered-after-clear"
CanRetryRejectedDelivery == outcome = "delivered-after-rejection"
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
    /\ name = ""
    /\ pollFailures = 0
    /\ error = ""
    /\ recovery = PendingRecovery
    /\ admission = NoAdmission
    /\ outcome = "none"

Start(n) ==
    /\ ~running
    /\ phase' = "starting"
    /\ running' = TRUE
    /\ task' = 0
    /\ name' = n
    /\ pollFailures' = 0
    /\ error' = ""
    /\ admission' = [kind |-> "start", busy |-> running, cleared |-> FALSE]
    /\ outcome' = IF outcome \in Errors THEN "restarted" ELSE "none"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    lastTask, recovery>>

RefuseStart == running /\ UNCHANGED vars

Create ==
    /\ phase = "starting"
    /\ Latest < MaxTasks
    /\ \A t \in Tasks : sidecar[t] # "active"
    /\ LET t == Latest + 1 IN
        /\ sidecar' = [sidecar EXCEPT ![t] = "active"]
        /\ task' = t
        /\ lastTask' = t
    /\ phase' = "polling"
    /\ UNCHANGED <<mount, dismissed, cleared, completed, rejected, running,
                    name, pollFailures, error, recovery, admission, outcome>>

\* Capture and receipt are separate: a delayed latest response can lose a race
\* with start, Clear, completion, or aging. The guard is checked on receipt.
ReadLatest ==
    /\ recovery.state = "pending"
    /\ recovery' = [state |-> "ready", task |-> Latest,
                      status |-> IF Latest = 0 THEN "absent" ELSE sidecar[Latest]]
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, name, pollFailures,
                    error, admission, outcome>>

Recoverable ==
    /\ recovery.task # 0
    /\ recovery.status \in {"active", "fresh"}
    /\ recovery.task # dismissed
    /\ recovery.task \notin cleared
    /\ ~running

Recover ==
    /\ recovery.state = "ready"
    /\ Recoverable
    /\ recovery' = [recovery EXCEPT !.state = "done"]
    /\ phase' = "polling"
    /\ running' = TRUE
    /\ task' = recovery.task
    /\ lastTask' = recovery.task
    /\ name' = RecoveredName
    /\ pollFailures' = 0
    /\ admission' = [kind |-> "recover", busy |-> running,
                       cleared |-> recovery.task \in cleared]
    /\ outcome' = "none"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected, error>>

IgnoreRecovery ==
    /\ recovery.state = "ready"
    /\ ~Recoverable
    /\ recovery' = [recovery EXCEPT !.state = "done"]
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, name, pollFailures,
                    error, admission, outcome>>

RemoteFinish(t, s) ==
    /\ sidecar[t] = "active"
    /\ sidecar' = [sidecar EXCEPT ![t] = s]
    /\ UNCHANGED <<mount, dismissed, cleared, completed, rejected, phase,
                    running, task, lastTask, name, pollFailures, error,
                    recovery, admission, outcome>>

Age(t) ==
    /\ sidecar[t] = "fresh"
    /\ sidecar' = [sidecar EXCEPT ![t] = "old"]
    /\ UNCHANGED <<mount, dismissed, cleared, completed, rejected, phase,
                    running, task, lastTask, name, pollFailures, error,
                    recovery, admission, outcome>>

Poll ==
    /\ phase = "polling"
    /\ sidecar[task] \in {"active", "fresh", "old"}
    /\ phase' = IF sidecar[task] = "active" THEN "polling" ELSE "downloading"
    /\ pollFailures' = 0
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    running, task, lastTask, name, error, recovery, admission, outcome>>

PollBlip ==
    /\ phase = "polling"
    /\ pollFailures + 1 < PollLimit
    /\ pollFailures' = pollFailures + 1
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    phase, running, task, lastTask, name, error,
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
    /\ rejected' = IF e = "delivery-error" THEN [task |-> task, name |-> name] ELSE rejected
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, task,
                    lastTask, name, recovery, admission>>

Download ==
    /\ phase = "downloading"
    /\ phase' = "delivering"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, completed, rejected,
                    running, task, lastTask, name, pollFailures,
                    error, recovery, admission, outcome>>

Commit ==
    /\ phase = "delivering"
    /\ completed' = Append(completed, [task |-> task, name |-> name])
    /\ phase' = "idle"
    /\ running' = FALSE
    /\ outcome' = IF task \in cleared THEN "delivered-after-clear"
                   ELSE IF rejected = [task |-> task, name |-> name]
                        THEN "delivered-after-rejection" ELSE "delivered"
    /\ UNCHANGED <<mount, sidecar, dismissed, cleared, rejected, task,
                    lastTask, name, pollFailures, error, recovery, admission>>

Complete ==
    /\ task \notin FinishedTasks
    /\ \A i \in 1..Len(completed) : completed[i].name # name
    /\ Commit

Clear ==
    /\ lastTask # 0
    /\ dismissed' = lastTask
    /\ cleared' = cleared \cup {lastTask}
    /\ UNCHANGED <<mount, sidecar, completed, rejected, phase, running, task,
                    lastTask, name, pollFailures, error, recovery, admission, outcome>>

Reload ==
    /\ mount < MaxMounts
    /\ mount' = mount + 1
    /\ phase' = "idle"
    /\ running' = FALSE
    /\ task' = 0
    /\ lastTask' = 0
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
    \/ \E n \in Names : Start(n)
    \/ RefuseStart
    \/ Create
    \/ ReadLatest
    \/ Recover
    \/ IgnoreRecovery
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

\* Existing hook: delivery does not persist a completion receipt, so another
\* mount can recover the same fresh success and complete its callback again.
ReplayCompletedTask ==
    /\ mount > 1
    /\ admission.kind = "recover"
    /\ task \in FinishedTasks
    /\ Commit

\* Existing hook: two recovered tasks both use recovered-statue.stl; the second
\* fulfilled callback replaces the first library entry of the same kind/name.
ReuseRecoveredName ==
    /\ admission.kind = "recover"
    /\ name = RecoveredName
    /\ task \notin FinishedTasks
    /\ \E i \in 1..Len(completed) :
        completed[i].task # task /\ completed[i].name = name
    /\ Commit

Spec == Init /\ [][Next]_vars
====
