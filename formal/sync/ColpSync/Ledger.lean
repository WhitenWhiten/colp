import Std

namespace ColpSync.Ledger

/-- A page with one relevant native wait; independent events of that page have
already committed. One row stands for an original or dependent deferred event. -/
structure Row where
  page : Nat
  generation : Nat
  settled : Bool
  deriving BEq, DecidableEq, Repr

structure State where
  generation : Nat := 1
  published : Nat := 0
  serverAck : Nat := 0
  rows : List Row := []
  deriving BEq, DecidableEq, Repr

inductive Action where
  /-- Validated next page: all other events have committed, and this wait has
  durable generation-bound authority. No arbitrary gaps or event cursors. -/
  | publish (hasWait : Bool)
  | ack (page : Nat)
  | confirm (page generation : Nat) (hasIdentityEvidence : Bool)
  | prune
  | crash
  deriving BEq, DecidableEq, Repr

def confirmRow (s : State) (page generation : Nat) (proof : Bool) (r : Row) : Row :=
  if r.page = page ∧ r.generation = generation ∧ generation = s.generation ∧ proof = true then
    { r with settled := true } else r

/-- Linearization points from completePullPage / completeDetachedPullEvent.
Pruning conservatively retains open waits and the latest page. -/
def step (s : State) : Action → State
  | .publish hasWait => { s with
      published := s.published + 1
      rows := s.rows ++ [⟨s.published + 1, s.generation, !hasWait⟩] }
  | .ack page => if s.serverAck ≤ page ∧ page = s.published then { s with serverAck := page } else s
  | .confirm page generation proof => { s with rows := s.rows.map (confirmRow s page generation proof) }
  | .prune => { s with rows := s.rows.filter (fun r => !r.settled || r.page == s.published) }
  | .crash => s

def run (actions : List Action) : State := actions.foldl step {}

theorem cursor_never_rewinds (s : State) (a : Action) : s.published ≤ (step s a).published := by
  cases a <;> simp [step] <;> (try split <;> simp) <;> omega

theorem detached_completion_preserves_cursor (s : State) (page gen : Nat) (proof : Bool) :
    (step s (.confirm page gen proof)).published = s.published ∧
    (step s (.confirm page gen proof)).serverAck = s.serverAck := by simp [step]

theorem ack_safe (s : State) (a : Action) (h : s.serverAck ≤ s.published) :
    (step s a).serverAck ≤ (step s a).published := by
  cases a <;> simp_all [step] <;> (try split <;> simp_all) <;> omega

theorem run_ack_safe (actions : List Action) : (run actions).serverAck ≤ (run actions).published := by
  have go : ∀ (as : List Action) (s : State), s.serverAck ≤ s.published →
      (as.foldl step s).serverAck ≤ (as.foldl step s).published := by
    intro as
    induction as with
    | nil => simp
    | cons a rest ih => intro s h; exact ih (step s a) (ack_safe s a h)
  exact go actions {} (by decide)

theorem pruning_retains_unresolved (s : State) (r : Row)
    (member : r ∈ s.rows) (unresolved : r.settled = false) :
    r ∈ (step s .prune).rows := by simp [step, List.mem_filter, member, unresolved]

theorem ack_preserves_rows (s : State) (page : Nat) :
    (step s (.ack page)).rows = s.rows := by
  simp only [step]; split <;> rfl

theorem stale_generation_cannot_settle (s : State) (page gen : Nat) (proof : Bool)
    (stale : gen ≠ s.generation) : step s (.confirm page gen proof) = s := by
  have same : ∀ r, confirmRow s page gen proof r = r := by
    intro r; simp [confirmRow, stale]
  have hf : confirmRow s page gen proof = id := funext same
  simp [step, hf]

theorem missing_identity_cannot_settle (s : State) (page gen : Nat) :
    step s (.confirm page gen false) = s := by
  have hf : confirmRow s page gen false = id := by
    funext r; simp [confirmRow]
  simp [step, hf]

def progressTrace : List Action :=
  [.publish true, .publish false, .ack 2, .prune, .crash,
   .confirm 1 0 true, .confirm 1 1 true, .prune]

theorem later_page_and_prune_do_not_lose_wait :
    (run progressTrace).published = 2 ∧ (run progressTrace).serverAck = 2 ∧
    (run progressTrace).rows = [⟨2, 1, true⟩] := by decide

/-- Open debt can survive arbitrarily many later pages and their Acks. -/
def waitingCycles : Nat → State
  | 0 => step {} (.publish true)
  | n + 1 =>
    let next := step (waitingCycles n) (.publish false)
    step (step next (.ack next.published)) .prune

theorem unresolved_debt_survives_arbitrary_progress (n : Nat) :
    (⟨1, 1, false⟩ : Row) ∈ (waitingCycles n).rows := by
  induction n with
  | zero => simp [waitingCycles, step]
  | succ n ih =>
    apply pruning_retains_unresolved _ _ _ rfl
    rw [ack_preserves_rows]
    simp [step, ih]

end ColpSync.Ledger
