import Std

namespace ColpSync.Health

inductive Status where
  | syncing | degraded | stopped
  deriving BEq, DecidableEq, Repr

structure Report where
  revision : Nat
  status : Status
  deriving BEq, DecidableEq, Repr

structure State where
  issues : Nat := 0
  stopped : Bool := false
  /-- Ghost observation: an exception before durable engine error recording.
  Production health projection does not read this observation. -/
  failedWakes : Nat := 0
  pendingUpload : Bool := true
  liveSession : Bool := true
  credential : Bool := true
  proof : Bool := true
  localRevision : Nat := 0
  serverRevision : Nat := 0
  serverStatus : Status := .syncing
  deriving BEq, DecidableEq, Repr

def project (s : State) : Status :=
  if s.stopped then .stopped else if s.issues > 0 then .degraded else .syncing

def capture (s : State) : State × Report :=
  ({ s with localRevision := s.localRevision + 1 }, ⟨s.localRevision + 1, project s⟩)

/-- Server transaction, abstracting current account/epoch/installation checks.
Reports neither renew Session nor modify lease/checkpoint. -/
def deliver (s : State) (r : Report) : State :=
  if s.credential && s.proof && decide (s.serverRevision < r.revision) then
    { s with serverRevision := r.revision, serverStatus := r.status }
  else s

theorem revision_never_rewinds (s : State) (r : Report) :
    s.serverRevision ≤ (deliver s r).serverRevision := by
  unfold deliver
  split <;> simp_all <;> omega

theorem health_does_not_renew_session (s : State) (r : Report) :
    (deliver s r).liveSession = s.liveSession := by
  unfold deliver; split <;> rfl

theorem invalid_authority_cannot_report (s : State) (r : Report)
    (h : s.credential = false ∨ s.proof = false) : deliver s r = s := by
  rcases h with h | h <;> simp [deliver, h]

/-- Health works without a live sync Session, assuming current reporting authority. -/
theorem stopped_replica_can_report :
    (deliver { stopped := true, liveSession := false } ⟨1, .stopped⟩).serverStatus = .stopped := by decide

theorem older_report_cannot_hide_degradation :
    (deliver (deliver {} ⟨2, .degraded⟩) ⟨1, .syncing⟩).serverStatus = .degraded := by decide

/-- A real observation gap, conditional on repeated preflight failures whose
reads differ from the health reader. Sending healthy heartbeats cannot detect it. -/
def preflightFailure (s : State) : State := { s with failedWakes := s.failedWakes + 1 }

def failedWakeAndReport (s : State) : State :=
  let (reserved, report) := capture (preflightFailure s)
  deliver reserved report

def failedCycles : Nat → State
  | 0 => {}
  | n + 1 => failedWakeAndReport (failedCycles n)

theorem preflight_failure_can_report_syncing :
    (failedWakeAndReport {}).failedWakes = 1 ∧
    (failedWakeAndReport {}).serverStatus = .syncing := by decide

/-- Arbitrarily many successful health reports can coexist with failed wakes.
This is a liveness counterexample family, not a bounded-search approximation. -/
theorem repeated_preflight_failures (n : Nat) :
    (failedCycles n).failedWakes = n ∧
    (failedCycles n).serverStatus = .syncing ∧
    (failedCycles n).issues = 0 ∧
    (failedCycles n).stopped = false ∧
    (failedCycles n).localRevision = n ∧
    (failedCycles n).serverRevision = n ∧
    (failedCycles n).credential = true ∧
    (failedCycles n).proof = true := by
  induction n with
  | zero => decide
  | succ n ih =>
    simp_all [failedCycles, failedWakeAndReport, preflightFailure, capture, deliver, project]

theorem pending_upload_never_sent_in_failed_cycles (n : Nat) :
    (failedCycles n).pendingUpload = true := by
  induction n with
  | zero => rfl
  | succ n ih =>
    simp_all [failedCycles, failedWakeAndReport, preflightFailure, capture, deliver]
    split <;> simp_all

end ColpSync.Health
