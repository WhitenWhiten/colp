import Lean
import ColpSync
import ColpSync.AuthorityExport
import ColpSync.RecoveryExport
import ColpSync.AckFenceExport

open Lean ColpSync

def array (xs : List Json) : Json := .arr xs.toArray

def orderName : Cursor.Order → String
  | .before => "before" | .equal => "equal" | .after => "after" | .incomparable => "incomparable"

def ackName : Cursor.AckClass → String
  | .allow => "allow" | .refuse_event_cursor => "refuse_event_cursor"
  | .refuse_incomplete_page => "refuse_incomplete_page" | .refuse_missing_evidence => "refuse_missing_evidence"
  | .refuse_rewind => "refuse_rewind" | .refuse_unordered => "refuse_unordered"

def writeName : Cursor.WriteClass → String
  | .allow => "allow" | .refuse_rewind => "refuse_rewind" | .refuse_stale_chain => "refuse_stale_chain"

/-- Includes same anchor/different expiry, stream ties, hash ambiguity, numeric
base36 ordering, >53-bit ordinals, and malformed syntax. These are not signed credentials. -/
def cursors : List String := [
  "spc2.scope.10.0.o.hash.sig", "spc2.scope.10.1.o.hash.sig",
  "spc2.scope.20.1.o.hash.sig", "spc2.scope.10.1.c.hash.sig",
  "spc2.scope.10.1.o.other.sig", "spc2.scope.10.2.o.hash.sig",
  "spc2.scope.10.z.o.hash.sig", "spc2.scope.10.10.o.hash.sig",
  "spc2.scope.10.zzzzzzzzzzzzzzzzzz.o.hash.sig",
  "spc2.scope.0001.1.o.hash.sig", "spc2.SCOPE_-.10.1.o.HASH_-.SIG_-",
  "spc2.scope.10.01.o.hash.sig", "spc2.scope.10.A.o.hash.sig",
  "spc2.scope.10.1.x.hash.sig", "spc2.scope.10.1.o..sig",
  "spc2.scope.10.1.o.hash.sig.extra", "spc2.scope.10.1.o.hash.sig\n",
  "spc2.scope.10.1.o.hash.sigé", "cursor-legacy", ""]

def orderCases : List Json := cursors.flatMap fun left => cursors.map fun right =>
  Json.mkObj [("left", toJson left), ("right", toJson right),
    ("expected", toJson (orderName (Cursor.order left right)))]

def ackCases : List Json :=
  [false, true].flatMap fun event => [false, true].flatMap fun complete =>
  [false, true].flatMap fun evidence => (none :: cursors.map some).flatMap fun published =>
  (none :: cursors.map some).map fun next =>
  let input := Json.mkObj [("cursorKind", toJson (if event then "event" else "server_page")),
    ("pageComplete", toJson complete), ("backendPageEvidence", toJson evidence),
    ("publishedCursor", toJson published), ("nextCursor", toJson next)]
  Json.mkObj [("input", input),
    ("expected", toJson (ackName (Cursor.classifyAck ⟨event, complete, evidence, published, next⟩)))]

def writeCases : List Json :=
  (none :: cursors.map some).flatMap fun published => cursors.flatMap fun previous => cursors.map fun next =>
  Json.mkObj [("input", Json.mkObj [("publishedCursor", toJson published),
      ("previousCursor", toJson previous), ("nextCursor", toJson next)]),
    ("expected", toJson (writeName (Cursor.classifyWrite published previous next)))]

def observation (s : Ledger.State) : Json := Json.mkObj [
  ("published", toJson s.published), ("serverAck", toJson s.serverAck),
  ("rows", array (s.rows.map (fun r => Json.mkObj [
    ("page", toJson r.page), ("generation", toJson r.generation), ("settled", toJson r.settled)])))]

def actionJson : Ledger.Action → Json
  | .publish wait => Json.mkObj [("kind", toJson "publish"), ("hasWait", toJson wait)]
  | .ack page => Json.mkObj [("kind", toJson "ack"), ("page", toJson page)]
  | .confirm page generation proof => Json.mkObj [("kind", toJson "confirm"),
      ("page", toJson page), ("generation", toJson generation), ("proof", toJson proof)]
  | .prune => Json.mkObj [("kind", toJson "prune")]
  | .crash => Json.mkObj [("kind", toJson "crash")]

def traceJson (name : String) (actions : List Ledger.Action) : Json :=
  let (_, checkpoints) := actions.foldl (fun (acc : Ledger.State × List Json) a =>
    let next := Ledger.step acc.1 a
    (next, acc.2 ++ [Json.mkObj [("action", actionJson a), ("expected", observation next)]])) ({}, [])
  Json.mkObj [("name", toJson name), ("initial", observation {}), ("checkpoints", array checkpoints)]

def traces : List Json := [
  traceJson "later-page-ack-confirm-prune" [
    .publish true, .publish false, .ack 2, .prune, .crash,
    .confirm 1 0 true, .confirm 1 1 false, .confirm 1 1 true, .prune],
  traceJson "several-later-pages" [
    .publish true, .publish false, .ack 2, .prune,
    .publish false, .ack 3, .prune, .crash,
    .publish false, .ack 4, .prune, .confirm 1 1 true, .prune, .crash],
  traceJson "two-independent-waits" [
    .publish true, .publish true, .ack 2, .prune,
    .confirm 1 1 true, .prune, .confirm 2 1 false, .prune,
    .confirm 2 1 true, .prune],
  traceJson "unpublished-ack-and-repeated-receipt" [
    .ack 9, .publish false, .ack 1, .crash, .ack 1, .prune]]

def main : IO Unit := IO.println (Json.mkObj [
  ("schemaVersion", toJson (1 : Nat)), ("orders", array orderCases), ("acks", array ackCases),
  ("writes", array writeCases), ("traces", array traces),
  ("authorityTraces", array AuthorityExport.traces),
  ("unfreezeCases", array AuthorityExport.unfreezeCases),
  ("sessionCases", array AuthorityExport.sessionCases),
  ("recoveryBranches", array RecoveryExport.branches),
  ("nativeResumeCases", array RecoveryExport.nativeResumeCases),
  ("ackFenceTraces", array AckFenceExport.traces)]).compress
