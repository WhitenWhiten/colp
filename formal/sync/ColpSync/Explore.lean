import ColpSync

namespace ColpSync

structure Node (S A : Type) where
  state : S
  trace : List A

/-- Breadth-first exploration with enqueue-time deduplication. A fuel limit is
an error, never a success receipt. This utility itself is not formally verified. -/
def explore [BEq S] (step : S → A → S) (actions : List A) (initial : S)
    (fuel : Nat := 10000) : Except String (List (Node S A)) :=
  walk fuel [⟨initial, []⟩] [⟨initial, []⟩]
where
  walk : Nat → List (Node S A) → List (Node S A) → Except String (List (Node S A))
    | _, [], seen => .ok seen
    | 0, _ :: _, _ => .error "exploration fuel exhausted; no completeness claim"
    | n + 1, current :: pending, seen =>
      let (next, visited) := actions.foldl (fun (acc : List (Node S A) × List (Node S A)) a =>
        let successor := step current.state a
        if acc.2.any (fun node => node.state == successor) then acc
        else
          let node := Node.mk successor (current.trace ++ [a])
          (acc.1 ++ [node], acc.2 ++ [node])) ([], seen)
      walk n (pending ++ next) visited

def pullActions : List Pull.Action :=
  let items : List Pull.ItemAction := [.start, .succeed, .loseResult, .isolate, .enrollDeferral]
  items.map .first ++ items.map .second ++
    [.publish, .persistAck, .acceptAck, .receiveAck, .crash]

def commandActions : List Command.Action := [.deliver, .execute, .saveResult, .crash, .reportResult]

/-- Deliberately broken publication guard; the explorer must reject this mutant. -/
def unsafePublish (s : Pull.State) (a : Pull.Action) : Pull.State :=
  if a = .publish then { s with published := true } else Pull.step s a

end ColpSync
