import Std

namespace ColpSync.AckFence

inductive Intent where
  | pending | complete | absent
  deriving BEq, DecidableEq, Repr

/-- After the server accepted bootstrap Ack but before its receipt was saved.
Revision is relative to that checkpoint; all actions stay in one replica scope. -/
structure State where
  revision : Nat := 0
  intent : Intent := .pending
  cursor : Nat := 1
  frozen : Bool := true
  refresh : Bool := false
  nativeUnknown : Bool := true
  deriving BEq, DecidableEq, Repr

inductive Action where
  | revisionRace | reject (expected : Nat) | lateReceipt | activate | crash
  deriving BEq, DecidableEq, Repr

inductive Outcome where
  | ok | engine_revision_stale | bootstrap_ack_discard_invalid
  | ack_intent_missing | recovery_rebase_invalid
  deriving BEq, DecidableEq, Repr

def outcome (s : State) : Action → Outcome
  | .reject expected => if s.intent ≠ .pending then .bootstrap_ack_discard_invalid
    else if s.revision ≠ expected then .engine_revision_stale else .ok
  | .lateReceipt => if s.intent = .absent then .ack_intent_missing else .ok
  | .activate => if s.intent = .complete then .ok else .recovery_rebase_invalid
  | _ => .ok

def step (s : State) (a : Action) : State :=
  if outcome s a ≠ .ok then s else match a with
    | .revisionRace => { s with revision := s.revision + 1 }
    | .reject _ => { s with revision := s.revision + 1, intent := .absent, frozen := true, refresh := true }
    | .lateReceipt => { s with intent := .complete }
    | .activate => { s with cursor := 2 }
    | .crash => s

def run (as : List Action) : State := as.foldl step {}

theorem stale_rejection_rolls_back (s : State) (expected : Nat)
    (stale : s.revision ≠ expected) : step s (.reject expected) = s := by
  simp [step, outcome, stale]; split <;> simp_all

theorem rejection_preserves_cursor (s : State) (expected : Nat) :
    (step s (.reject expected)).cursor = s.cursor := by
  simp only [step]; split <;> rfl

theorem discarded_intent_cannot_be_completed (s : State) (h : s.intent = .absent) :
    step s .lateReceipt = s ∧ outcome s .lateReceipt = .ack_intent_missing := by
  simp [step, outcome, h]

theorem activation_requires_receipt (s : State) (h : s.intent ≠ .complete) :
    step s .activate = s := by simp [step, outcome, h]

theorem old_receipt_cannot_resurrect_rejected_ack :
    let s := run [.reject 0, .crash, .lateReceipt, .activate]
    s.intent = .absent ∧ s.cursor = 1 ∧ s.frozen = true ∧ s.nativeUnknown = true := by decide

end ColpSync.AckFence
