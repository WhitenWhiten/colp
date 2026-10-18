import Std

namespace ColpSync.Push

inductive Head where
  | unsent | uncertain | settled | heldUnsent
  deriving BEq, DecidableEq, Repr

structure State where
  head : Head := .unsent
  /-- Ghost server fact, possibly unknown to the extension. -/
  committed : Bool := false
  attempts : Nat := 0
  /-- Logical identity must survive all attempts; abstracts canonical bytes/seq/opId. -/
  identity : Nat := 1
  /-- Explicit server expected-sequence evidence closes an unsent hole. -/
  realigned : Bool := false
  tailSent : Bool := false
  deriving BEq, DecidableEq, Repr

inductive Action where
  | send | commit | retry | settle | holdUnsent | realign | sendTail | crash
  deriving BEq, DecidableEq, Repr

def step (s : State) : Action → State
  | .send => if s.head = .unsent then { s with head := .uncertain, attempts := s.attempts + 1 } else s
  | .commit => if s.head = .uncertain then { s with committed := true } else s
  | .retry => if s.head = .uncertain then { s with attempts := s.attempts + 1 } else s
  | .settle => if s.head = .uncertain ∧ s.committed = true then { s with head := .settled } else s
  | .holdUnsent => if s.head = .unsent then { s with head := .heldUnsent } else s
  | .realign => if s.head = .heldUnsent then { s with realigned := true } else s
  | .sendTail => if s.head = .settled ∨ (s.head = .heldUnsent ∧ s.realigned = true) then
      { s with tailSent := true } else s
  | .crash => s

def run (actions : List Action) : State := actions.foldl step {}

theorem attempt_preserves_identity (s : State) (a : Action) :
    (step s a).identity = s.identity := by
  cases a <;> simp [step] <;> split <;> rfl

theorem unknown_head_blocks_tail (s : State) (h : s.head = .uncertain) :
    step s .sendTail = s := by simp [step, h]

theorem sent_head_cannot_be_set_aside (s : State) (h : s.head = .uncertain) :
    step s .holdUnsent = s := by simp [step, h]

def retryCycles : Nat → State
  | 0 => step {} .send
  | n + 1 => step (step (retryCycles n) .retry) .sendTail

/-- Fairly retrying does not imply eventual receipt. This is an infinite family
with no tail progress; connectivity/auth alone are insufficient liveness assumptions. -/
theorem retry_forever_can_block_independent_tail (n : Nat) :
    (retryCycles n).head = .uncertain ∧ (retryCycles n).tailSent = false ∧
    (retryCycles n).attempts = n + 1 ∧ (retryCycles n).identity = 1 := by
  induction n with
  | zero => decide
  | succ n ih => simp_all [retryCycles, step]

theorem settled_receipt_releases_tail :
    (run [.send, .commit, .crash, .retry, .settle, .sendTail]).tailSent = true := by decide

theorem unsent_hold_can_release_tail_with_evidence :
    (run [.holdUnsent, .realign, .sendTail]).tailSent = true := by decide

end ColpSync.Push
