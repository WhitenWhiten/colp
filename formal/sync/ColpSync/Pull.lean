import Std

namespace ColpSync.Pull

/-- `held` includes the durable issue; `deferred` includes a validated,
generation-bound intent/decision. Neither asserts a successful native call. -/
inductive Item where
  | ready | started | unknown | applied | held | deferred
  deriving BEq, DecidableEq, Repr

def Item.accounted : Item → Bool
  | .applied | .held | .deferred => true
  | _ => false

structure State where
  first : Item := .ready
  second : Item := .ready
  published : Bool := false
  intent : Bool := false
  serverAck : Bool := false
  localAck : Bool := false
  deriving BEq, DecidableEq, Repr

inductive ItemAction where
  | start | succeed | loseResult | isolate | enrollDeferral
  deriving BEq, DecidableEq, Repr

def itemStep (i : Item) : ItemAction → Item
  | .start => if i = .ready then .started else i
  | .succeed => if i = .started ∨ i = .unknown ∨ i = .deferred then .applied else i
  | .loseResult => if i = .started then .unknown else i
  | .isolate => if i = .ready then .held else i
  | .enrollDeferral => if i = .unknown then .deferred else i

inductive Action where
  | first (a : ItemAction) | second (a : ItemAction)
  | publish | persistAck | acceptAck | receiveAck | crash
  deriving BEq, DecidableEq, Repr

def covered (s : State) : Bool := s.first.accounted && s.second.accounted

/-- One server-issued page, with two proven-independent subjects. Publish is
one IDB transaction. `acceptAck` and `receiveAck` split the HTTP crash boundary.
Crashes preserve durable state; a lost response can be followed by acceptAck again. -/
def step (s : State) : Action → State
  | .first a => { s with first := itemStep s.first a }
  | .second a => { s with second := itemStep s.second a }
  | .publish => if covered s then { s with published := true } else s
  | .persistAck => if s.published then { s with intent := true } else s
  | .acceptAck => if s.intent then { s with serverAck := true } else s
  | .receiveAck => if s.intent && s.serverAck then { s with localAck := true, intent := false } else s
  | .crash => s

def Safe (s : State) : Prop :=
  (s.published = true → covered s = true) ∧
  (s.intent = true → s.published = true) ∧
  (s.serverAck = true → s.published = true) ∧
  (s.localAck = true → s.serverAck = true)

instance (s : State) : Decidable (Safe s) := inferInstanceAs (Decidable (_ ∧ _ ∧ _ ∧ _))

theorem item_accounting_preserved (i : Item) (a : ItemAction)
    (h : i.accounted = true) : (itemStep i a).accounted = true := by
  cases i <;> cases a <;> simp_all [Item.accounted, itemStep]

theorem step_safe (s : State) (a : Action) (h : Safe s) : Safe (step s a) := by
  rcases h with ⟨hp, hi, hs, hl⟩
  cases a with
  | first a =>
    have hm := item_accounting_preserved s.first a
    simp_all [Safe, step, covered, Bool.and_eq_true]
  | second a =>
    have hm := item_accounting_preserved s.second a
    simp_all [Safe, step, covered, Bool.and_eq_true]
  | publish => simp_all [Safe, step]; split <;> simp_all [covered]
  | persistAck => simp_all [Safe, step]; split <;> simp_all [covered]
  | acceptAck => simp_all [Safe, step]; split <;> simp_all [covered]
  | receiveAck => simp_all [Safe, step]; split <;> simp_all [covered]
  | crash => exact ⟨hp, hi, hs, hl⟩

def run (actions : List Action) : State := actions.foldl step {}

/-- Unbounded trace-length induction, not bounded exploration. -/
theorem fold_safe (actions : List Action) (s : State) (h : Safe s) :
    Safe (actions.foldl step s) := by
  induction actions generalizing s with
  | nil => exact h
  | cons a rest ih => exact ih (step s a) (step_safe s a h)

theorem run_safe (actions : List Action) : Safe (run actions) :=
  fold_safe actions {} (by decide)

theorem ack_requires_accounted_page (actions : List Action)
    (h : (run actions).serverAck = true) : covered (run actions) = true :=
  (run_safe actions).1 ((run_safe actions).2.2.1 h)

/-- A positive witness: the first subject is isolated, the other succeeds and Ack lands. -/
def isolationTrace : List Action :=
  [.first .isolate, .second .start, .second .succeed,
   .publish, .persistAck, .acceptAck, .crash, .acceptAck, .receiveAck]

theorem isolated_item_does_not_stop_peer :
    (run isolationTrace).first = .held ∧
    (run isolationTrace).second = .applied ∧ (run isolationTrace).localAck = true := by decide

/-- Ack means accounted-for, not all-native-applied. -/
def deferredTrace : List Action :=
  [.first .start, .first .loseResult, .first .enrollDeferral,
   .second .start, .second .succeed, .publish, .persistAck, .acceptAck]

theorem ack_can_precede_native_confirmation :
    (run deferredTrace).serverAck = true ∧ (run deferredTrace).first = .deferred := by decide

theorem started_call_cannot_be_isolated : itemStep .started .isolate = .started := by decide
theorem unknown_call_cannot_be_isolated : itemStep .unknown .isolate = .unknown := by decide

theorem started_call_cannot_restart : itemStep .started .start = .started := by decide
theorem unknown_call_cannot_restart : itemStep .unknown .start = .unknown := by decide
theorem deferred_call_cannot_restart : itemStep .deferred .start = .deferred := by decide

end ColpSync.Pull
