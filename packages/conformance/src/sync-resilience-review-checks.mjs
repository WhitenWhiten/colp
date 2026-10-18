export const REVIEW_CHECKS = [
  ['SYNC-0038', 'Delayed commands reject changed targets and report their actual outcome'],
  ['SYNC-0039', 'Automatic Snapshot preserves unresolved issue identities and protection'],
  ['SYNC-0040', 'Concrete missing identity is local while independent Pull applies'],
  ['SYNC-0041', 'Pending deletion permits later Pull pages and Ack, then converges'],
  ['SYNC-0042', 'Snapshot codec quarantine retains graph and independent native projection'],
  ['SYNC-0043', 'Unified open issue ceiling stops admission with the crossing evidence intact'],
];

/** Verify concrete production-fixture observations, including native recovery and durable receipts. */
export function verifyReviewCase(id, o, require) {
  if (id === 'SYNC-0038') {
    require(typeof o.originalReplica === 'string' && o.originalReplica !== o.currentBefore && o.currentBefore === o.currentAfter, 'target did not change or changed again during rejection');
    require(o.currentRebuilds === 0 && o.originalRebuilds === 0, 'stale command rebuilt a replica');
    require(o.reports.some(report => report.replicaId === o.originalReplica && report.commandResults?.some(result =>
      result.commandId === o.commandId && result.outcome === 'failed' && result.code === 'stale_ref')), 'original command has no accurate rejection receipt');
  } else if (id === 'SYNC-0039') {
    require(o.issuesBefore.length > 0 && o.issuesBefore.every(before => o.issuesAfter.some(after =>
      after.nodeId === before.nodeId && after.code === before.code && after.eventId === before.eventId)), 'Snapshot closed unresolved evidence');
    require(o.survivors.includes(o.nativeSubject) && o.mapping.nativeId === o.nativeSubject, 'Snapshot lost native identity');
    require(o.exclusions.includes(o.nativeSubject), 'Snapshot lost upload protection');
    require(o.independent.length > 0 && o.independent.every(id => !o.survivors.includes(id)), 'independent Snapshot work did not execute');
    require(typeof o.cursor === 'string' && o.cursor !== o.previousCursor, 'Snapshot did not commit');
  } else if (id === 'SYNC-0040') {
    require(o.localIssues.some(issue => issue.nativeId === o.missingNative && issue.code === 'recovery_identity_unproven'), 'identity issue lost its native subject');
    require(o.roots.includes(o.missingNode) && o.mapping.nativeId === o.missingNative, 'identity protection or mapping disappeared');
    require(o.lifecycle === 'active' && o.nativeUpdates.some(node => node.title === 'Remote update'), 'missing identity froze independent Pull');
  } else if (id === 'SYNC-0041') {
    require(o.pages.length >= 2 && o.pages.every(page => page.state === 'page_complete'), 'pending decision blocked later Pull pages');
    require(o.pages.every(page => o.ackCursors.includes(page.nextCursor)), 'page cursor did not Ack');
    require(o.relatedBefore.state === 'awaiting_confirmation' && o.independentMapping.nativeId, 'dependent hold or independent apply missing');
    require(o.health.state === 'degraded' && o.health.issues.total > 0 && o.health.issues.items.some(issue =>
      issue.code === 'remote_delete_confirmation_required'), 'health hid pending decision');
    require(o.decisionAfter.state === 'applied' && o.restoredTitle === 'Restored remotely'
      && o.cursorAfter === o.ackCursors.at(-1), 'decision did not converge without cursor rewind');
  } else if (id === 'SYNC-0042') {
    require(o.issues.some(issue => issue.nodeId === o.mapping.colpId && issue.code === 'record_too_large'), 'codec failure lost its subject');
    require(o.mapping.quarantine?.payloadDigest && o.mapping.nativeId.startsWith('sidecar:quarantine:')
      && o.mapping.projection.content === undefined, 'quarantine falsely claims native/content application');
    require(o.graph.some(row => row.parentColpId === o.mapping.colpId) && !o.nativeTitles.includes('Blocked descendant')
      && o.nativeTitles.includes('Independent'), 'quarantine lost graph or independent projection');
    require(o.storedBytes < o.originalBytes && o.state.phase !== 'error' && o.state.recoveryFrozen === false, 'codec isolation remained global or unbounded');
    require(o.ackWarnings.some(warning => warning.nodeId === o.mapping.colpId && warning.code === 'record_invalid'), 'Snapshot Ack omitted unapplied evidence');
  } else if (id === 'SYNC-0043') {
    require(o.total === o.issues.length && o.total > 200 && o.issues.some(issue => issue.nativeId === 'native-200'), 'ceiling lost crossing item or counts');
    require(o.state.phase === 'error' && o.state.lastError === 'sync_issue_ceiling' && o.pullRequests.length === 0,
      'ceiling admitted more work or did not stop');
    require(o.health.state === 'stopped' && o.health.code === 'sync_issue_ceiling' && o.health.issues.total === o.total
      && o.health.actions.includes('rebuild'), 'ceiling is invisible or has no repair exit');
  }
}
