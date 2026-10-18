import Std

namespace ColpSync.Cursor

/-- Literal port of pull-ack-boundary.ts, including its connected-chain shortcut.
Parsing is syntax/order extraction, NOT signature or account authorization. -/
inductive Stream where
  | operation | conflict
  deriving BEq, DecidableEq, Repr

structure Anchor where
  ordinal : Nat
  stream : Stream
  stableHash : String
  deriving BEq, DecidableEq, Repr

inductive Order where
  | before | equal | after | incomparable
  deriving BEq, DecidableEq, Repr

def asciiDigit (c : Char) : Bool := decide ('0' ≤ c ∧ c ≤ '9')
def asciiLower (c : Char) : Bool := decide ('a' ≤ c ∧ c ≤ 'z')
def asciiUpper (c : Char) : Bool := decide ('A' ≤ c ∧ c ≤ 'Z')
def word (s : String) : Bool := !s.isEmpty && s.toList.all
  (fun c => asciiDigit c || asciiLower c || asciiUpper c || c == '_' || c == '-')
def lowerDigits (s : String) : Bool := !s.isEmpty && s.toList.all (fun c => asciiDigit c || asciiLower c)

def base36 (s : String) : Option Nat := do
  if s.isEmpty || (s.length > 1 && s.startsWith "0") then none else
    s.toList.foldlM (fun n c =>
      if asciiDigit c then some (36 * n + c.toNat - '0'.toNat)
      else if asciiLower c then some (36 * n + c.toNat - 'a'.toNat + 10)
      else none) 0

def parse (s : String) : Option Anchor := do
  match s.splitOn "." with
  | ["spc2", scope, expires, ordinal, stream, hash, signature] =>
    if !(word scope && lowerDigits expires && word hash && word signature) then none else
      let n ← base36 ordinal
      let k ← if stream = "o" then some Stream.operation
        else if stream = "c" then some Stream.conflict else none
      return ⟨n, k, hash⟩
  | _ => none

def order (left right : String) : Order :=
  match parse left, parse right with
  | some a, some b =>
    if a.ordinal ≠ b.ordinal then if a.ordinal < b.ordinal then .before else .after
    else if a.stream ≠ b.stream then if a.stream = .operation then .before else .after
    else if a.stableHash = b.stableHash then .equal else .incomparable
  | _, _ => .incomparable

inductive AckClass where
  | allow | refuse_event_cursor | refuse_incomplete_page | refuse_missing_evidence
  | refuse_rewind | refuse_unordered
  deriving BEq, DecidableEq, Repr

structure AckFacts where
  eventCursor : Bool
  complete : Bool
  evidence : Bool
  published : Option String
  next : Option String
  deriving Repr

def classifyAck (f : AckFacts) : AckClass :=
  if f.eventCursor then .refuse_event_cursor
  else if !f.complete then .refuse_incomplete_page
  else if !f.evidence then .refuse_missing_evidence
  else match f.published, f.next with
    | some p, some n => if n = p then .allow else
      match order p n with
      | .incomparable => .refuse_unordered
      | .after => .refuse_rewind
      | _ => .allow
    | _, _ => .allow

inductive WriteClass where
  | allow | refuse_rewind | refuse_stale_chain
  deriving BEq, DecidableEq, Repr

def classifyWrite (published : Option String) (previous next : String) : WriteClass :=
  match published with
  | none => .allow
  | some p => if previous = p then .allow else
    match classifyAck ⟨false, true, true, published, some next⟩ with
    | .refuse_rewind => .refuse_rewind
    | .refuse_unordered => .refuse_stale_chain
    | _ => match order p next with
      | .before | .equal => .allow
      | _ => .refuse_stale_chain

theorem detached_write_requires_order (p previous next : String)
    (detached : previous ≠ p) (allowed : classifyWrite (some p) previous next = .allow) :
    order p next = .before ∨ order p next = .equal := by
  simp [classifyWrite, detached] at allowed
  split at allowed <;> simp_all
  split at allowed <;> simp_all

theorem proven_order_does_not_rewind (left right : String) (a b : Anchor)
    (hl : parse left = some a) (hr : parse right = some b)
    (ordered : order left right = .before ∨ order left right = .equal) :
    a.ordinal ≤ b.ordinal := by
  by_cases h : a.ordinal ≤ b.ordinal
  · exact h
  · have ne : a.ordinal ≠ b.ordinal := by omega
    have notlt : ¬a.ordinal < b.ordinal := by omega
    simp [order, hl, hr, ne, notlt] at ordered

theorem detached_write_ordinal_monotone (p previous next : String) (a b : Anchor)
    (hp : parse p = some a) (hn : parse next = some b)
    (detached : previous ≠ p) (allowed : classifyWrite (some p) previous next = .allow) :
    a.ordinal ≤ b.ordinal :=
  proven_order_does_not_rewind p next a b hp hn (detached_write_requires_order p previous next detached allowed)

/-- The guard itself allows this: monotonicity also depends on validated page
chains upstream. Do not "fix" the port by silently adding an idealized check. -/
theorem connected_chain_shortcut (p next : String) :
    classifyWrite (some p) p next = .allow := by simp [classifyWrite]

def old : String := "spc2.scope.10.1.o.hash.sig"
def newer : String := "spc2.scope.10.2.o.hash.sig"

theorem connected_guard_can_accept_rewind (p next : String) (rewind : order p next = .after) :
    order p next = .after ∧ classifyWrite (some p) p next = .allow :=
  ⟨rewind, connected_chain_shortcut p next⟩

end ColpSync.Cursor
