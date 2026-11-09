---- MODULE StatueGeneration ----
\* The statue service's generation slot, as server.py runs it in mock mode:
\* one statue at a time, each task queued when it's submitted and succeeded
\* when its worker finishes. MaxTasks bounds how many the environment submits.
EXTENDS Naturals, Sequences, FiniteSets
CONSTANT MaxTasks
VARIABLE status
vars == <<status>>

Tasks == 1..Len(status)
Busy == \E i \in Tasks : status[i] \in {"queued", "running"}

Init == status = <<>>

\* POST /tasks reserves the slot, unless a statue is already being generated.
Submit == /\ ~Busy
          /\ Len(status) < MaxTasks
          /\ status' = Append(status, "queued")

\* The worker the submission started finishes its task.
Finish == \E i \in Tasks : /\ status[i] = "queued"
                           /\ status' = [status EXCEPT ![i] = "succeeded"]

\* GET /tasks/{id}/model serves a statue's model, only for a task that
\* succeeded.
Download(i) == /\ i \in Tasks
               /\ status[i] = "succeeded"
               /\ UNCHANGED status

\* A cross-site POST /tasks, or one for an engine the service doesn't
\* know, is refused whatever the slot holds: it reserves nothing and starts
\* nothing.
SubmitCrossSite == FALSE
SubmitUnknownEngine == FALSE

\* Every task has ended and the environment submits no more.
Idle == /\ ~Busy
        /\ Len(status) = MaxTasks
        /\ UNCHANGED status

Next == Submit \/ SubmitCrossSite \/ SubmitUnknownEngine \/ Finish \/ Idle \/ \E i \in 1..MaxTasks : Download(i)
Spec == Init /\ [][Next]_vars

OneAtATime == Cardinality({i \in Tasks : status[i] \in {"queued", "running"}}) <= 1
Known == \A i \in Tasks : status[i] \in {"queued", "running", "succeeded", "failed"}

AllDone == Len(status) = MaxTasks /\ \A i \in Tasks : status[i] = "succeeded"

\* A submission that doesn't check the slot.
DoubleSubmit == /\ Len(status) < MaxTasks
                /\ status' = Append(status, "queued")

Fair == WF_vars(Finish)
Ends == [](Busy => <>~Busy)
====
