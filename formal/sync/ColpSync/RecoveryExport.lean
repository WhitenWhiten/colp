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

def branch (interrupted nativeUnknown : Bool) : Json :=
  let initial : Recovery.State := { nativeUnknown }
  let cut := Recovery.step initial .cutover
  let sent := Recovery.step cut .networkAck
  let received := Recovery.step (if interrupted then Recovery.step sent .networkAck else sent) .receiveAck
  let prepared := Recovery.step received .prepareActivation
  let activated := Recovery.step prepared .activate
  let completed := Recovery.step activated (if interrupted then .finishResumed else .finishFresh)
  let checkpoints := [checkpoint "initial" initial, checkpoint "before_ack" cut, checkpoint "after_ack" sent]
    ++ (if interrupted then [checkpoint "restart" sent, checkpoint "before_ack" sent,
      checkpoint "after_ack" (Recovery.step sent .networkAck)] else [])
    ++ [checkpoint "before_activation" prepared, checkpoint "activated" activated, checkpoint "final" completed]
  Json.mkObj [("interrupted", toJson interrupted), ("nativeUnknown", toJson nativeUnknown), ("checkpoints", toJson checkpoints)]

def branches : List Json := [false, true].flatMap fun unknown => [false, true].map fun interrupted => branch interrupted unknown

def nativeResumeCases : List Json := (List.range 1024).map fun n =>
  let bit := fun k => n / 2 ^ k % 2 == 1
  let f : Recovery.NativeResumeFacts := ⟨bit 0, bit 1, bit 2, bit 3, bit 4, bit 5, bit 6, bit 7, bit 8, bit 9⟩
  Json.mkObj [("active", toJson f.active), ("refresh", toJson f.refresh), ("snapshot", toJson f.snapshot),
    ("generation", toJson f.generation), ("event", toJson f.event), ("binding", toJson f.binding),
    ("started", toJson f.started), ("applied", toJson f.applied), ("confirmation", toJson f.confirmation),
    ("nativeId", toJson f.nativeId), ("expected", toJson (Recovery.allowNativeResume f))]

end ColpSync.RecoveryExport
