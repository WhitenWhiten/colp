import Std

namespace ColpSync.Recovery

/-- Facts for resuming the original confirmed invocation on a completed,
Snapshot-accounted page while the bootstrap local-work hold remains frozen. -/
structure NativeResumeFacts where
  active : Bool
  refresh : Bool
  snapshot : Bool
  generation : Bool
  event : Bool
  binding : Bool
  started : Bool
  applied : Bool
  confirmation : Bool
  nativeId : Bool
  deriving Repr

def allowNativeResume (f : NativeResumeFacts) : Bool :=
  f.active && !f.refresh && f.snapshot && f.generation && f.event && f.binding &&
    f.started && f.applied && f.confirmation && f.nativeId

theorem native_resume_requires_proven_identity (f : NativeResumeFacts)
    (h : allowNativeResume f = true) : f.applied = true ∧ f.confirmation = true ∧ f.nativeId = true := by
  simp_all [allowNativeResume, Bool.and_eq_true]

theorem native_resume_rejects_wrong_generation (f : NativeResumeFacts) (h : f.generation = false) :
    allowNativeResume f = false := by simp [allowNativeResume, h]

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

/-- Both bootstrap completion paths use the same post-activation policy. -/
def finishBootstrap (s : State) : State := { s with frozen := s.nativeUnknown, refresh := false }

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
  | .finishFresh | .finishResumed => if s.complete && s.cursor == 2 then finishBootstrap s else s
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

theorem fresh_completion_retains_native_wait :
    (run fresh).complete = true ∧ (run fresh).cursor = 2 ∧
    (run fresh).nativeUnknown = true ∧ (run fresh).frozen = true ∧
    (run fresh).refresh = false := by decide

theorem restart_preserves_completion_policy :
    (run fresh).cursor = (run resumed).cursor ∧
    (run fresh).nativeUnknown = (run resumed).nativeUnknown ∧
    (run fresh).frozen = (run resumed).frozen ∧
    (run fresh).refresh = (run resumed).refresh := by decide

theorem completion_paths_agree (s : State) : step s .finishFresh = step s .finishResumed := rfl

def FreezeSafe (s : State) : Prop := s.nativeUnknown = true → s.frozen = true

theorem step_freeze_safe (s : State) (a : Action) (h : FreezeSafe s) : FreezeSafe (step s a) := by
  cases a <;> simp_all [FreezeSafe, step, finishBootstrap] <;> split <;> simp_all

theorem run_freeze_safe (as : List Action) : FreezeSafe (run as) := by
  have go : ∀ (as : List Action) (s : State), FreezeSafe s → FreezeSafe (as.foldl step s) := by
    intro as
    induction as with
    | nil => simp
    | cons a rest ih => intro s h; exact ih (step s a) (step_freeze_safe s a h)
  exact go as {} (by simp [FreezeSafe])

end ColpSync.Recovery
