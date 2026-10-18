import { useState } from 'react'
import { productClient, type SyncReplicaIssue, type SyncReplicaIssuesView, type SyncReplicaView } from '../../api'
import type { StatusTone } from '../../components/StatusBadge'
import { formatRelative } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import { REPLICA_STATE_TONE, STATUS_LABELS } from './types'

/**
 * What a device card says about a browser's sync: the browser's own last report
 * (`health`) and what the server infers alone (`activity`). A stop outranks
 * everything; ordinary lag says nothing.
 */
export function replicaBadge(replica: SyncReplicaView): { readonly tone: StatusTone; readonly label: string } {
  if (replica.status !== 'retired') {
    if (replica.health?.state === 'stopped') return { tone: 'danger', label: 'Stopped' }
    if (notSyncing(replica)) return { tone: 'warning', label: 'Not syncing' }
    if (replica.health?.state === 'paused') return { tone: 'muted', label: 'Paused' }
    if (replica.health?.state === 'degraded') return { tone: 'warning', label: 'Needs attention' }
  }
  return { tone: REPLICA_STATE_TONE[replica.status], label: STATUS_LABELS[replica.status] }
}

const RECORD_CODES = new Set(['record_too_large', 'bounded_string_invalid', 'secret_field_forbidden', 'i_json_invalid',
  'operation_schema_invalid', 'operation_byte_budget_exceeded'])
const REBUILD_CODES = new Set(['pull_apply_target_missing', 'pull_apply_evidence_missing', 'anchor_mapping_missing',
  'legacy_resolution_sequence_collision', 'mapping_identity_collision', 'create_ambiguous', 'create_evidence_missing',
  'snapshot_projection_incomplete'])
const STOP_REASONS: Readonly<Record<string, string>> = {
  create_placement_unproven: 'it can’t tell where a saved bookmark belongs.',
  create_placement_parent_deleted: 'a saved bookmark’s folder was deleted before the bookmark synced.',
  recovery_identity_unproven: 'it can’t match a bookmark in the browser with its copy here.',
  deletion_identity_unproven: 'it can’t confirm which bookmark a deletion was for.',
  payload_too_large: 'an item is too large to sync.',
  target_unavailable: 'the library it syncs with isn’t available.',
  replica_rebuild_pending: 'its copy of your library is being rebuilt.',
}

/** The reason a browser gave for stopping, in plain words; the code only when it is new to us. */
export function stopReason(code: string | null | undefined): string {
  if (!code) return 'it didn’t say why.'
  if (STOP_REASONS[code]) return STOP_REASONS[code]
  if (RECORD_CODES.has(code)) return 'a bookmark in it can’t be stored.'
  if (REBUILD_CODES.has(code)) return 'its copy of your library needs a rebuild.'
  return `it reported “${code}”.`
}

export function issueSummary(issue: SyncReplicaIssue): string {
  switch (issue.code) {
    case 'conflict_pending': return 'Waiting for a conflict to be resolved'
    case 'conflict_hold': return 'Waiting for a conflict on this bookmark to be resolved'
    case 'native_result_unknown': return 'Waiting for a decision in the browser'
    case 'waiting_dependency': return 'Waiting for another change to finish'
  }
  if (issue.direction === 'push') return 'The server didn’t accept this change'
  if (issue.direction === 'pull') return 'Couldn’t be applied in the browser'
  return 'Couldn’t be prepared for sync'
}

/** The server's own inference: the browser has missed changes for an hour. */
function notSyncing(replica: SyncReplicaView): boolean {
  return replica.activity === 'stalled' || replica.activity === 'silent'
}

function activityNote(replica: SyncReplicaView): string {
  const behind = replica.behindSince ? formatRelative(replica.behindSince) : 'a while ago'
  const seen = formatRelative(replica.lastSeenAt)
  return replica.activity === 'stalled'
    ? `It connected ${seen}, but changes from ${behind} haven’t reached it. Open the extension on that browser to see why.`
    : `Changes from ${behind} are waiting, and it was last seen ${seen}. If that browser is open and online, open the extension on it to see why.`
}

type IssuesState = { readonly phase: 'closed' } | { readonly phase: 'loading' }
  | { readonly phase: 'loaded'; readonly view: SyncReplicaIssuesView } | { readonly phase: 'failed' }

export function ReplicaHealth({ replica }: { replica: SyncReplicaView }) {
  const [issues, setIssues] = useState<IssuesState>({ phase: 'closed' })
  if (replica.status === 'retired') return null
  const health = replica.health
  const count = health?.issueCount ?? 0
  const load = async () => {
    setIssues({ phase: 'loading' })
    try { setIssues({ phase: 'loaded', view: await productClient.listSyncReplicaIssues(replica.id) }) }
    catch { setIssues({ phase: 'failed' }) }
  }
  const notes: string[] = []
  if (health?.state === 'stopped') {
    notes.push(`Sync on this browser has stopped: ${stopReason(health.code)} Open the extension on that browser to fix it.`)
  } else if (health?.state === 'paused') {
    notes.push('Sync is paused on this browser. Nothing syncs until it’s resumed there.')
  } else if (health?.state === 'degraded') {
    notes.push(`${plural(count, 'item')} on this browser couldn’t sync. Everything else keeps syncing.`)
  }
  if (notSyncing(replica) && health?.state !== 'stopped') notes.push(activityNote(replica))
  if (notes.length === 0) return null
  const tone = health?.state === 'stopped' ? 'is-blocked' : 'is-stale'
  return <div className={`replica-message ${tone}`} role="status">
    {notes.map((note) => <p key={note}>{note}</p>)}
    {health && <p className="replica-reported">Reported {formatRelative(health.reportedAt)}.</p>}
    {count > 0 && health?.state !== 'paused' && (issues.phase === 'closed' || issues.phase === 'failed') && (
      <div className="replica-actions">
        {issues.phase === 'failed' && <span>Couldn’t load the items.</span>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          {issues.phase === 'failed' ? 'Try again' : `Show ${plural(count, 'item')}`}
        </button>
      </div>
    )}
    {issues.phase === 'loading' && <p>Loading items…</p>}
    {issues.phase === 'loaded' && <ReplicaIssueList view={issues.view} />}
  </div>
}

function ReplicaIssueList({ view }: { view: SyncReplicaIssuesView }) {
  if (view.items.length === 0) return <p>This browser has nothing set aside any more.</p>
  const more = view.total - view.items.length
  return <ul className="replica-issues" aria-label="Items this browser couldn’t sync">
    {view.items.map((issue) => (
      <li key={issue.issueId}>
        <strong>{issue.title ?? (issue.nodeId ? 'A bookmark in your library' : 'A bookmark on that browser')}</strong>
        <span>{issueSummary(issue)}{issue.count > 1 ? ` (${issue.count} times)` : ''}</span>
      </li>
    ))}
    {more > 0 && <li><span>and {plural(more, 'more item')}</span></li>}
  </ul>
}
