---- MODULE CompileOnce ----
EXTENDS Naturals

CONSTANTS Models, ErrorMessages, MaxDeliveries

VARIABLES firstEvent, lastEvent, outcome, value, settlements, deliveries,
          workerTerminated, timerActive

vars == <<firstEvent, lastEvent, outcome, value, settlements, deliveries,
          workerTerminated, timerActive>>

NoValue == "none"
NoEvent == [kind |-> "none", value |-> NoValue]
DoneEvent(m) == [kind |-> "done", value |-> m]
FailureEvent == [kind |-> "failure", value |-> "color part failed to compile"]
ErrorEvent(message) ==
    [kind |-> "error", value |-> IF message = "" THEN "worker error" ELSE message]
TimeoutEvent == [kind |-> "timeout", value |-> "color part render timed out"]

WorkerEvents ==
    {DoneEvent(m) : m \in Models}
    \cup {FailureEvent}
    \cup {ErrorEvent(message) : message \in ErrorMessages}

Events == WorkerEvents \cup {TimeoutEvent}
Values == {e.value : e \in Events} \cup {NoValue}
OutcomeFor(e) == IF e.kind = "done" THEN "resolved" ELSE "rejected"

SingleSettlement ==
    /\ settlements \in 0..1
    /\ (outcome = "pending") <=> (settlements = 0)

FirstSignalWins ==
    IF firstEvent = NoEvent
    THEN /\ outcome = "pending"
         /\ value = NoValue
    ELSE /\ outcome = OutcomeFor(firstEvent)
         /\ value = firstEvent.value

WorkerTerminatedAfterSettlement ==
    outcome # "pending" => workerTerminated

TimerInactiveAfterSettlement ==
    outcome # "pending" => ~timerActive

TypeOK ==
    /\ firstEvent \in Events \cup {NoEvent}
    /\ lastEvent \in Events \cup {NoEvent}
    /\ outcome \in {"pending", "resolved", "rejected"}
    /\ value \in Values
    /\ settlements \in 0..2
    /\ deliveries \in 0..MaxDeliveries
    /\ workerTerminated \in BOOLEAN
    /\ timerActive \in BOOLEAN

DoneWins == firstEvent.kind = "done" /\ outcome = "resolved"
FailureWins == firstEvent.kind = "failure" /\ outcome = "rejected"
ErrorWins == firstEvent.kind = "error" /\ outcome = "rejected"
TimeoutWins == firstEvent.kind = "timeout" /\ outcome = "rejected"
EmptyErrorUsesFallback ==
    firstEvent.kind = "error" /\ value = "worker error" /\ outcome = "rejected"

LaterModelIgnored ==
    /\ deliveries = 2
    /\ firstEvent.kind = "done"
    /\ lastEvent.kind = "done"
    /\ firstEvent.value # lastEvent.value
    /\ outcome = "resolved"
    /\ value = firstEvent.value

LateFailureIgnored ==
    /\ deliveries = 2
    /\ firstEvent.kind = "done"
    /\ lastEvent.kind = "failure"
    /\ outcome = "resolved"

LateErrorIgnored ==
    /\ deliveries = 2
    /\ firstEvent.kind = "done"
    /\ lastEvent.kind = "error"
    /\ outcome = "resolved"

LateDoneAfterTimeoutIgnored ==
    /\ deliveries = 2
    /\ firstEvent.kind = "timeout"
    /\ lastEvent.kind = "done"
    /\ outcome = "rejected"
    /\ value = TimeoutEvent.value

EventuallySettles == <> (outcome # "pending")

\* One invocation, observed after synchronous setup and after each complete
\* callback (including flushing promise observers). The driver provides a
\* fresh worker and a one-shot timer; these host operations do not throw.
\* A non-done response takes the failure branch of the unchanged function.
\* Event values are model identities for success and Error.message for failure.
\* firstEvent is a driver observation of the first delivered terminal signal;
\* it is independent of the promise outcome being checked.
\* settlements counts actual promise transitions, not resolve/reject attempts.
Init ==
    /\ firstEvent = NoEvent
    /\ lastEvent = NoEvent
    /\ outcome = "pending"
    /\ value = NoValue
    /\ settlements = 0
    /\ deliveries = 0
    /\ workerTerminated = FALSE
    /\ timerActive = TRUE

\* Each worker callback calls clearTimeout and terminate, even when late.
\* Their idempotent resource effects are represented by booleans; the native
\* Promise ignores later resolve/reject attempts. No extra settled guard is
\* assumed. Two deliveries cover a first signal and a competing late signal.
WorkerCallback(e) ==
    /\ e \in WorkerEvents
    /\ deliveries < MaxDeliveries
    /\ deliveries' = deliveries + 1
    /\ lastEvent' = e
    /\ workerTerminated' = TRUE
    /\ timerActive' = FALSE
    /\ IF outcome = "pending"
       THEN /\ firstEvent' = e
            /\ outcome' = OutcomeFor(e)
            /\ value' = e.value
            /\ settlements' = 1
       ELSE UNCHANGED <<firstEvent, outcome, value, settlements>>

WorkerDone == \E m \in Models : WorkerCallback(DoneEvent(m))
WorkerFailure == WorkerCallback(FailureEvent)
WorkerError == \E message \in ErrorMessages : WorkerCallback(ErrorEvent(message))

\* F1=A: firing expires a one-shot timer, satisfying timer cleanup without
\* an explicit clearTimeout call. A cleared or expired timer cannot fire.
Timeout ==
    /\ timerActive
    /\ deliveries < MaxDeliveries
    /\ deliveries' = deliveries + 1
    /\ lastEvent' = TimeoutEvent
    /\ workerTerminated' = TRUE
    /\ timerActive' = FALSE
    /\ IF outcome = "pending"
       THEN /\ firstEvent' = TimeoutEvent
            /\ outcome' = "rejected"
            /\ value' = TimeoutEvent.value
            /\ settlements' = 1
       ELSE UNCHANGED <<firstEvent, outcome, value, settlements>>

Finished == outcome # "pending" /\ UNCHANGED vars

Next == WorkerDone \/ WorkerFailure \/ WorkerError \/ Timeout \/ Finished

TimeoutProgress == WF_vars(Timeout)

\* Known bugs are deliberately excluded from Next.
BugSecondSettlement ==
    /\ firstEvent.kind = "done"
    /\ deliveries < MaxDeliveries
    /\ deliveries' = deliveries + 1
    /\ lastEvent' = firstEvent
    /\ settlements' = 2
    /\ UNCHANGED <<firstEvent, outcome, value, workerTerminated, timerActive>>

BugLateDoneOverwrites ==
    /\ outcome # "pending"
    /\ deliveries < MaxDeliveries
    /\ \E m \in Models :
         /\ m # firstEvent.value
         /\ deliveries' = deliveries + 1
         /\ lastEvent' = DoneEvent(m)
         /\ outcome' = "resolved"
         /\ value' = m
    /\ UNCHANGED <<firstEvent, settlements, workerTerminated, timerActive>>

BugTimeoutLeavesWorker ==
    /\ outcome = "pending"
    /\ timerActive
    /\ deliveries < MaxDeliveries
    /\ firstEvent' = TimeoutEvent
    /\ lastEvent' = TimeoutEvent
    /\ outcome' = "rejected"
    /\ value' = TimeoutEvent.value
    /\ settlements' = 1
    /\ deliveries' = deliveries + 1
    /\ timerActive' = FALSE
    /\ workerTerminated' = FALSE

BugDoneLeavesTimer ==
    /\ outcome = "pending"
    /\ deliveries < MaxDeliveries
    /\ \E m \in Models :
         /\ firstEvent' = DoneEvent(m)
         /\ lastEvent' = DoneEvent(m)
         /\ value' = m
    /\ outcome' = "resolved"
    /\ settlements' = 1
    /\ deliveries' = deliveries + 1
    /\ workerTerminated' = TRUE
    /\ timerActive' = TRUE

Spec == Init /\ [][Next]_vars
====
