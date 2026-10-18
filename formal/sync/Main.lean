import ColpSync.Explore

open ColpSync

def require (ok : Bool) (message : String) : IO Unit :=
  unless ok do throw (IO.userError message)

def unpack (r : Except String α) : IO α :=
  match r with
  | .ok value => pure value
  | .error message => throw (IO.userError message)

def main : IO Unit := do
  let pull ← unpack (explore Pull.step pullActions ({} : Pull.State))
  require (pull.all (fun n => decide (Pull.Safe n.state))) "Pull safety failed"
  IO.println s!"PASS Pull: {pull.length} reachable states; frontier exhausted; safety holds."
  let deferred := pull.find? (fun n => n.state.serverAck && n.state.first == .deferred)
  require deferred.isSome "Expected Ack-before-native-confirmation witness missing"
  if let some node := deferred then
    IO.println s!"WITNESS accounted Ack can retain native debt: {repr node.trace}"
  let commands ← unpack (explore Command.step commandActions ({} : Command.State))
  require (commands.all (fun n => decide (Command.Safe n.state))) "Command safety failed"
  IO.println s!"PASS Command: {commands.length} reachable states; frontier exhausted; at most one execution."
  let interrupted := commands.find? (fun n => n.state.serverSettled && n.state.executions == 0)
  require interrupted.isSome "Expected command crash-window counterexample missing"
  if let some node := interrupted then
    IO.println s!"COUNTEREXAMPLE settled command need not execute: {repr node.trace}"
  let mutant ← unpack (explore unsafePublish pullActions ({} : Pull.State))
  let violation := mutant.find? (fun n => !decide (Pull.Safe n.state))
  require violation.isSome "Mutation check failed: unsafe publication was not detected"
  if let some node := violation then
    IO.println s!"PASS mutation rejected (unsafe publication): {repr node.trace}"
  let blocked := Push.retryCycles 8
  require (!blocked.tailSent && blocked.attempts == 9) "Ordered Push lane counterexample missing"
  IO.println "COUNTEREXAMPLE Push: after 9 attempts, an unsettled sent head still blocks the independent tail."
  let silent := Health.failedCycles 10
  require (silent.failedWakes == 10 && silent.serverStatus == .syncing) "Preflight observability counterexample missing"
  IO.println "COUNTEREXAMPLE Health: 10 failed preflight wakes + 10 delivered reports still project syncing."
  require ((Health.deliver { stopped := true, liveSession := false } ⟨1, .stopped⟩).serverStatus == .stopped)
    "Expired Session incorrectly blocked health reporting"
  IO.println "PASS Health: stopped replica reports without live Session; revision/authority theorems compiled."
  let ledger := Ledger.run Ledger.progressTrace
  require (ledger.published == 2 && ledger.serverAck == 2 && ledger.rows == [⟨2, 1, true⟩])
    "Multi-page deferred completion/pruning trace failed"
  IO.println "PASS Ledger: later page Ack, stale-generation refusal, old wait completion, pruning; cursor remains at page 2."
  let waiting := Ledger.waitingCycles 20
  require (waiting.rows.any (fun r => r.page == 1 && !r.settled)) "Open debt was lost after later-page progress"
  let unsafePruned := waiting.rows.filter (fun r => r.page == waiting.published)
  require (!(unsafePruned.any (fun r => r.page == 1 && !r.settled))) "Pruning mutation was not exercised"
  IO.println "PASS mutation rejected: keeping only the newest page would erase an unresolved native wait."
  require (Cursor.order Cursor.newer Cursor.old == .after &&
    Cursor.classifyWrite (some Cursor.newer) Cursor.newer Cursor.old == .allow)
    "Literal cursor guard shortcut changed; inspect upstream monotonicity assumptions"
  IO.println "BOUNDARY Cursor: connected-chain shortcut needs upstream monotonicity; detached writes have an ordinal theorem."
  let raced := Authority.run [.freeze 1, .stagePull]
  require (raced.revision == 2 && Authority.outcome raced (.rebase 2 1 2) == .session_handoff_pending)
    "Session handoff failed to recheck work that does not change engine revision"
  IO.println "PASS Authority: matching engine revision cannot bypass atomic pending-work checks."
  let discarded := AckFence.run [.reject 0, .crash, .lateReceipt, .activate]
  require (discarded.intent == .absent && discarded.cursor == 1 && discarded.nativeUnknown)
    "Late receipt resurrected a discarded bootstrap Ack"
  IO.println "PASS AckFence: rejected bootstrap cannot be resurrected by a late receipt; stale rejection is an atomic no-op."
  let fresh := Recovery.run Recovery.fresh
  let resumed := Recovery.run Recovery.resumed
  require (fresh.cursor == resumed.cursor && fresh.nativeUnknown && resumed.nativeUnknown &&
    fresh.frozen && resumed.frozen && !fresh.refresh && !resumed.refresh)
    "Bootstrap completion must preserve the native hold and clear settled authority refresh"
  IO.println "PASS Recovery: fresh and interrupted completion retain unknown native holds and clear completed authority refresh."
