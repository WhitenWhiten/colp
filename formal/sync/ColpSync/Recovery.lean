import Std

namespace ColpSync.Recovery

/-- A complete staged Snapshot and one retained unknown native invocation.
0=no published cursor, 1=Snapshot cut, 2=active Session cursor. -/
structure State where
  cursor : Nat := 0
  frozen : Bool := true
  refresh : Bool := true
  staged : Bool := true
  pending : Bool := false
  complete : Bool := false
  nativeUnknown : Bool := true
  requests : Nat := 0
  deriving BEq, DecidableEq, Repr

inductive Action where
  | cutover | networkAck | receiveAck | prepareActivation | activate
  | finishFresh | finishResumed | crash
  deriving BEq, DecidableEq, Repr

/-- Literal control-flow distinction: recoverSnapshotPages clears the freeze;
the pending-bootstrap branch in wakeOnce recomputes it from pending facts. -/
def step (s : State) : Action → State
  | .cutover => if s.staged then { s with
      cursor := 1
      staged := false
      frozen := true
      refresh := false
      pending := true } else s
  | .networkAck => if s.pending then { s with requests := s.requests + 1 } else s
  | .receiveAck => if s.pending && decide (s.requests > 0) then { s with pending := false, complete := true } else s
  | .prepareActivation => { s with frozen := true, refresh := true }
  | .activate => if s.complete then { s with cursor := 2 } else s
  | .finishFresh => if s.complete && s.cursor == 2 then { s with frozen := false, refresh := false } else s
  | .finishResumed => if s.complete && s.cursor == 2 then { s with frozen := s.nativeUnknown } else s
  | .crash => s

def run (as : List Action) : State := as.foldl step {}

def fresh : List Action :=
  [.cutover, .networkAck, .receiveAck, .prepareActivation, .activate, .finishFresh]
def resumed : List Action :=
  [.cutover, .networkAck, .crash, .networkAck, .receiveAck, .prepareActivation, .activate, .finishResumed]

theorem cutover_preserves_unknown (s : State) :
    (step s .cutover).nativeUnknown = s.nativeUnknown := by
  simp only [step]; split <;> rfl

theorem receipt_is_not_native_confirmation (s : State) :
    (step s .receiveAck).nativeUnknown = s.nativeUnknown := by
  simp only [step]; split <;> rfl

theorem activation_requires_completed_bootstrap (s : State) (h : s.complete = false) :
    step s .activate = s := by simp [step, h]

theorem all_steps_preserve_unknown (s : State) (a : Action) :
    (step s a).nativeUnknown = s.nativeUnknown := by
  cases a <;> simp only [step] <;> (try split) <;> rfl

theorem trace_preserves_unknown (as : List Action) : (run as).nativeUnknown = true := by
  have go : ∀ (as : List Action) (s : State),
      (as.foldl step s).nativeUnknown = s.nativeUnknown := by
    intro as
    induction as with
    | nil => simp
    | cons a rest ih => intro s; exact (ih (step s a)).trans (all_steps_preserve_unknown s a)
  exact go as {}

/-- Current implementation counterexample, not a theorem of the intended policy. -/
theorem fresh_completion_breaks_pending_freeze_policy :
    (run fresh).complete = true ∧ (run fresh).cursor = 2 ∧
    (run fresh).nativeUnknown = true ∧ (run fresh).frozen = false := by decide

theorem crash_changes_freeze_outcome :
    (run fresh).cursor = (run resumed).cursor ∧
    (run fresh).nativeUnknown = (run resumed).nativeUnknown ∧
    (run fresh).frozen ≠ (run resumed).frozen := by decide

end ColpSync.Recovery
