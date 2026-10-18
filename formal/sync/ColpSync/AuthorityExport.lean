import Lean
import ColpSync.Authority

namespace ColpSync.AuthorityExport
open Lean

def observation (s : Authority.State) : Json := Json.mkObj [
  ("revision", toJson s.revision), ("cursor", toJson s.cursor), ("session", toJson s.session),
  ("frozen", toJson s.frozen), ("refresh", toJson s.refresh), ("pendingAck", toJson s.pendingAck),
  ("incompletePull", toJson s.incompletePull), ("nativeUnknown", toJson s.nativeUnknown),
  ("confirmed", toJson (Authority.confirmed s))]

def outcomeName : Authority.Outcome → String
  | .ok => "ok" | .engine_revision_stale => "engine_revision_stale"
  | .authority_rebase_not_required => "authority_rebase_not_required"
  | .session_handoff_pending => "session_handoff_pending"

def actionJson : Authority.Action → Json
  | .freeze expected => Json.mkObj [("kind", toJson "freeze"), ("expected", toJson expected)]
  | .rebase expected captured next => Json.mkObj [("kind", toJson "rebase"), ("expected", toJson expected),
      ("captured", toJson captured), ("next", toJson next)]
  | .finish expected session => Json.mkObj [("kind", toJson "finish"), ("expected", toJson expected), ("session", toJson session)]
  | .pendingAck => Json.mkObj [("kind", toJson "pendingAck")]
  | .stagePull => Json.mkObj [("kind", toJson "stagePull")]
  | .revisionRace => Json.mkObj [("kind", toJson "revisionRace")]
  | .crash => Json.mkObj [("kind", toJson "crash")]

def trace (name : String) (as : List Authority.Action) : Json :=
  let (_, checkpoints) := as.foldl (fun (acc : Authority.State × List Json) a =>
    let next := Authority.step acc.1 a
    (next, acc.2 ++ [Json.mkObj [("action", actionJson a), ("expected", observation next),
      ("outcome", toJson (outcomeName (Authority.outcome acc.1 a)))]])) ({}, [])
  Json.mkObj [("name", toJson name), ("initial", observation {}), ("checkpoints", toJson checkpoints)]

def traces : List Json := [
  trace "two-renewals-with-crash-between-rebase-and-finalize"
    [.freeze 1, .rebase 2 1 2, .crash, .finish 2 1, .freeze 3, .rebase 4 2 3, .finish 4 2],
  trace "local-work-races-without-engine-revision-change" [.freeze 1, .stagePull, .rebase 2 1 2, .crash],
  trace "stale-rebase-and-stale-finalize" [.freeze 1, .revisionRace, .rebase 2 1 2, .finish 2 1],
  trace "pending-ack-keeps-original-identity" [.pendingAck, .freeze 1, .rebase 2 1 2, .crash],
  trace "captured-cursor-mismatch" [.freeze 1, .rebase 2 99 2, .crash],
  trace "rebase-without-refresh-authority" [.rebase 1 1 2]]

def unfreezeCases : List Json := [false, true].flatMap fun pull => [false, true].map fun native =>
  Json.mkObj [("pendingIncompletePull", toJson pull), ("nativeResultUnknown", toJson native),
    ("expected", toJson (!pull && !native))]

def sessionCases : List Json :=
  ["active", "recovery_required", "retired", "expired", "missing"].flatMap fun lease =>
  [false, true].flatMap fun snapshot => [false, true].flatMap fun refresh => [false, true].map fun bootstrapped =>
    Json.mkObj [("lease", toJson lease), ("snapshot", toJson snapshot), ("refresh", toJson refresh),
      ("bootstrapped", toJson bootstrapped), ("expected", toJson (
        if lease ≠ "active" then "session_authority_invalid"
        else if !snapshot then "active" else if refresh || bootstrapped then "recovery" else "bootstrap"))]

end ColpSync.AuthorityExport
