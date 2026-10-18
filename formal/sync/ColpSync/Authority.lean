import Std

namespace ColpSync.Authority

/-- One confirmed Pull boundary, then the primitive transactions used by
readEngineSessionAuthority. Browser/native work is independent of engine revision. -/
structure State where
  revision : Nat := 1
  cursor : Nat := 1
  session : Nat := 0
  frozen : Bool := false
  refresh : Bool := false
  pendingAck : Bool := false
  incompletePull : Bool := false
  nativeUnknown : Bool := false
  sessionEvidence : Bool := false
  receiptCursor : Nat := 1
  lastAcked : Nat := 1
  deriving BEq, DecidableEq, Repr

def confirmed (s : State) : Bool :=
  s.receiptCursor == s.cursor || (s.sessionEvidence && s.lastAcked == s.cursor)

inductive Action where
  | freeze (expected : Nat)
  | rebase (expected capturedCursor newCursor : Nat)
  | finish (expected session : Nat)
  | pendingAck | stagePull | revisionRace | crash
  deriving BEq, DecidableEq, Repr

inductive Outcome where
  | ok | engine_revision_stale | authority_rebase_not_required | session_handoff_pending
  deriving BEq, DecidableEq, Repr

def rebaseOutcome (s : State) (expected captured : Nat) : Outcome :=
  if s.revision ≠ expected then .engine_revision_stale
  else if !(s.frozen && s.refresh) then .authority_rebase_not_required
  else if s.cursor ≠ captured ∨ s.pendingAck = true ∨ s.incompletePull = true
      ∨ s.nativeUnknown = true ∨ confirmed s = false then .session_handoff_pending
  else .ok

def outcome (s : State) : Action → Outcome
  | .freeze expected | .finish expected _ =>
    if s.revision = expected then .ok else .engine_revision_stale
  | .rebase expected captured _ => rebaseOutcome s expected captured
  | _ => .ok

def step (s : State) (a : Action) : State :=
  if outcome s a ≠ .ok then s else
    match a with
    | .freeze _ => { s with revision := s.revision + 1, frozen := true, refresh := true }
    | .rebase _ _ cursor => { s with cursor, sessionEvidence := true }
    | .finish _ session => { s with
        revision := s.revision + 1
        session := session
        frozen := false
        refresh := false
        lastAcked := s.cursor }
    | .pendingAck => { s with pendingAck := true }
    | .stagePull => { s with incompletePull := true }
    | .revisionRace => { s with revision := s.revision + 1 }
    | .crash => s

def run (as : List Action) : State := as.foldl step {}

theorem stale_rebase_is_atomic_noop (s : State) (expected captured next : Nat)
    (stale : s.revision ≠ expected) : step s (.rebase expected captured next) = s := by
  simp [step, outcome, rebaseOutcome, stale]

theorem pending_work_blocks_rebase (s : State) (expected captured next : Nat)
    (pending : s.pendingAck = true ∨ s.incompletePull = true ∨ s.nativeUnknown = true) :
    step s (.rebase expected captured next) = s := by
  rcases pending with h | h | h <;>
    simp [step, outcome, rebaseOutcome, h] <;> split <;> simp_all <;> split <;> simp_all

theorem rebase_preserves_revision (s : State) (expected captured next : Nat) :
    (step s (.rebase expected captured next)).revision = s.revision := by
  simp only [step]; split <;> rfl

theorem finish_preserves_cursor (s : State) (expected session : Nat) :
    (step s (.finish expected session)).cursor = s.cursor := by
  simp only [step]; split <;> rfl

theorem stale_finish_is_atomic_noop (s : State) (expected session : Nat)
    (stale : s.revision ≠ expected) : step s (.finish expected session) = s := by
  simp [step, outcome, stale]

theorem pull_work_does_not_advance_engine_revision (s : State) :
    (step s .stagePull).revision = s.revision := by simp [step, outcome]

/-- CAS alone is insufficient: staging Pull does not touch engine revision. -/
theorem same_revision_can_still_require_handoff_refusal :
    let s := run [.freeze 1, .stagePull]
    s.revision = 2 ∧ outcome s (.rebase 2 1 2) = .session_handoff_pending := by decide

theorem successful_handoff_confirms_session_boundary :
    let s := run [.freeze 1, .rebase 2 1 2, .crash, .finish 2 1]
    s.cursor = 2 ∧ s.session = 1 ∧ s.frozen = false ∧ confirmed s = true := by decide

end ColpSync.Authority
