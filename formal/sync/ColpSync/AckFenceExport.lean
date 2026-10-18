import Lean
import ColpSync.AckFence

namespace ColpSync.AckFenceExport
open Lean

def intentName : AckFence.Intent → String
  | .pending => "pending" | .complete => "complete" | .absent => "absent"

def outcomeName : AckFence.Outcome → String
  | .ok => "ok" | .engine_revision_stale => "engine_revision_stale"
  | .bootstrap_ack_discard_invalid => "bootstrap_ack_discard_invalid"
  | .ack_intent_missing => "ack_intent_missing" | .recovery_rebase_invalid => "recovery_rebase_invalid"

def observation (s : AckFence.State) : Json := Json.mkObj [
  ("revision", toJson s.revision), ("intent", toJson (intentName s.intent)), ("cursor", toJson s.cursor),
  ("frozen", toJson s.frozen), ("refresh", toJson s.refresh), ("nativeUnknown", toJson s.nativeUnknown)]

def actionJson : AckFence.Action → Json
  | .reject expected => Json.mkObj [("kind", toJson "reject"), ("expected", toJson expected)]
  | .revisionRace => Json.mkObj [("kind", toJson "revisionRace")]
  | .lateReceipt => Json.mkObj [("kind", toJson "lateReceipt")]
  | .activate => Json.mkObj [("kind", toJson "activate")]
  | .crash => Json.mkObj [("kind", toJson "crash")]

def trace (name : String) (as : List AckFence.Action) : Json :=
  let (_, checkpoints) := as.foldl (fun (acc : AckFence.State × List Json) a =>
    let next := AckFence.step acc.1 a
    (next, acc.2 ++ [Json.mkObj [("action", actionJson a), ("expected", observation next),
      ("outcome", toJson (outcomeName (AckFence.outcome acc.1 a)))]])) ({}, [])
  Json.mkObj [("name", toJson name), ("initial", observation {}), ("checkpoints", toJson checkpoints)]

def traces : List Json := [
  trace "stale-reject-rolls-back-intent-delete" [.revisionRace, .reject 0, .crash, .lateReceipt, .activate],
  trace "discarded-bootstrap-rejects-late-receipt" [.reject 0, .crash, .lateReceipt, .activate],
  trace "completed-receipt-cannot-be-discarded" [.lateReceipt, .reject 0, .activate]]

end ColpSync.AckFenceExport
