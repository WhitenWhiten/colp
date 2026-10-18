import Std

namespace ColpSync.Command

inductive Result where
  | none | done | interrupted
  deriving BEq, DecidableEq, Repr

structure State where
  seen : Bool := false
  running : Bool := false
  effect : Bool := false
  executions : Nat := 0
  result : Result := .none
  serverSettled : Bool := false
  deriving BEq, DecidableEq, Repr

inductive Action where
  | deliver | execute | saveResult | crash | reportResult
  deriving BEq, DecidableEq, Repr

/-- One command ID; `seen` is persisted before the runner, the effect and its
result cannot be one transaction. Deduplication tombstone retention is assumed. -/
def step (s : State) : Action → State
  | .deliver =>
    if s.running then s else if s.seen then
      if s.result = .none then { s with running := false, result := .interrupted } else s
    else { s with seen := true, running := true }
  | .execute => if s.running && !s.effect then
      { s with effect := true, executions := s.executions + 1 } else s
  | .saveResult => if s.running && s.effect then { s with result := .done, running := false } else s
  | .crash => { s with running := false }
  | .reportResult => if s.result ≠ .none then { s with serverSettled := true } else s

def run (actions : List Action) : State := actions.foldl step {}

def Safe (s : State) : Prop :=
  s.executions ≤ 1 ∧ (s.effect = false → s.executions = 0) ∧
  (s.seen = false → s.running = false ∧ s.effect = false)

instance (s : State) : Decidable (Safe s) := inferInstanceAs (Decidable (_ ∧ _ ∧ _))

theorem step_safe (s : State) (a : Action) (h : Safe s) : Safe (step s a) := by
  cases a <;> simp_all [step, Safe] <;> split <;> simp_all <;>
    (try split <;> simp_all) <;> (try split <;> simp_all) <;> omega

theorem fold_safe (actions : List Action) (s : State) (h : Safe s) :
    Safe (actions.foldl step s) := by
  induction actions generalizing s with
  | nil => exact h
  | cons a rest ih => exact ih (step s a) (step_safe s a h)

theorem command_executes_at_most_once (actions : List Action) :
    (run actions).executions ≤ 1 := (fold_safe actions {} (by simp [Safe])).1

def interruptedBeforeEffect : List Action := [.deliver, .crash, .deliver, .reportResult]
def interruptedAfterEffect : List Action := [.deliver, .execute, .crash, .deliver, .reportResult]

theorem settled_command_may_never_execute :
    (run interruptedBeforeEffect).serverSettled = true ∧
    (run interruptedBeforeEffect).executions = 0 ∧
    (run interruptedBeforeEffect).result = .interrupted := by decide

theorem interrupted_does_not_prove_no_effect :
    (run interruptedAfterEffect).serverSettled = true ∧
    (run interruptedAfterEffect).executions = 1 ∧
    (run interruptedAfterEffect).result = .interrupted := by decide

end ColpSync.Command
