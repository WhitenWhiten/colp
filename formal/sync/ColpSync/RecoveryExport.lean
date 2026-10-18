import Lean
import ColpSync.Recovery

namespace ColpSync.RecoveryExport
open Lean

def observation (s : Recovery.State) : Json := Json.mkObj [
  ("cursor", toJson s.cursor), ("frozen", toJson s.frozen), ("refresh", toJson s.refresh),
  ("staged", toJson s.staged), ("pending", toJson s.pending), ("complete", toJson s.complete),
  ("nativeUnknown", toJson s.nativeUnknown), ("requests", toJson s.requests)]

def checkpoint (point : String) (s : Recovery.State) : Json :=
  Json.mkObj [("point", toJson point), ("observed", observation s)]

def branch (interrupted : Bool) : Json :=
  let cut := Recovery.step {} .cutover
  let sent := Recovery.step cut .networkAck
  let received := Recovery.step (if interrupted then Recovery.step sent .networkAck else sent) .receiveAck
  let prepared := Recovery.step received .prepareActivation
  let activated := Recovery.step prepared .activate
  let completed := Recovery.step activated (if interrupted then .finishResumed else .finishFresh)
  let checkpoints := [checkpoint "initial" {}, checkpoint "before_ack" cut, checkpoint "after_ack" sent]
    ++ (if interrupted then [checkpoint "restart" sent, checkpoint "before_ack" sent,
      checkpoint "after_ack" (Recovery.step sent .networkAck)] else [])
    ++ [checkpoint "before_activation" prepared, checkpoint "activated" activated, checkpoint "final" completed]
  Json.mkObj [("interrupted", toJson interrupted), ("checkpoints", toJson checkpoints)]

def branches : List Json := [branch false, branch true]

end ColpSync.RecoveryExport
