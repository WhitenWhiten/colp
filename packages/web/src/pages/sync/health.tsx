import { useState } from 'react'
import {
  ProductApiError, productClient, type SyncReplicaCommandView, type SyncReplicaIssue, type SyncReplicaIssuesView,
  type SyncReplicaView,
} from '../../api'
import { useToast } from '../../components/AppToast'
import { useConfirm } from '../../components/ConfirmModal'
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
  pull_issue_ceiling: 'it set aside too many items to keep syncing safely.',
  sync_issue_ceiling: 'it has too many unresolved items to keep syncing safely.',
  replica_rebuilt: 'its sync was reset.',
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
    case 'remote_delete_confirmation_required': return 'Waiting for a deletion decision in the extension: delete, restore, or keep on this browser'
    case 'conflict_pending': return 'Waiting for a conflict to be resolved'
    case 'conflict_hold': return 'Waiting for a conflict on this bookmark to be resolved'
    case 'dependency_hold': return 'Waiting for an earlier change to it that couldn’t sync'
    case 'parent_set_aside': return 'Its folder couldn’t be added to this browser'
    case 'create_placement_parent_deleted': return 'Its folder was deleted before it synced'
    case 'create_placement_unproven': return 'Its place in the folder couldn’t be confirmed'
    case 'recovery_identity_unproven': return 'It couldn’t be matched with one saved bookmark'
    case 'deletion_identity_unproven': return 'Deleted on that browser, but it couldn’t be matched, so nothing else was deleted'
    case 'record_too_large': return 'Too large for this browser to store'
    case 'bounded_string_invalid': return 'A field is too long for this browser to store'
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

type Action = SyncReplicaCommandView['action']
const ACTION_LABELS: Partial<Record<Action, string>> = { retry: 'Retry', rebuild: 'Reset sync' }
const RESULT_REASONS: Readonly<Record<string, string>> = {
  stale_ref: 'that browser switched libraries, accounts, or sync copies before it ran',
  authority_fenced: 'that browser changed its sign-in before it ran',
  action_unavailable: 'that browser no longer offered it',
  issue_gone: 'the item had already cleared',
  command_interrupted: 'the browser stopped before it finished',
  rebuild_not_required: 'its sync no longer needed a reset',
}
const DAY_MS = 24 * 60 * 60_000

function open(command: SyncReplicaCommandView): boolean {
  return command.state === 'pending' || command.state === 'delivered'
}

/** What came of the latest command, in plain words. */
export function commandNote(command: SyncReplicaCommandView, browser: string): string {
  const label = ACTION_LABELS[command.action] ?? 'The request'
  const reason = command.resultCode ? RESULT_REASONS[command.resultCode] ?? `it reported “${command.resultCode}”` : null
  switch (command.state) {
    case 'pending': return `${label} sent. It runs when ${browser} next checks in, usually within five minutes while it’s open.`
    case 'delivered': return `${label} sent. Waiting for ${browser} to report back.`
    case 'done': if (command.resultCode === 'retry_scheduled') return `Retry was scheduled on ${browser}. Check its sync status for the result.`
      return command.action === 'rebuild'
      ? `Sync was reset ${formatRelative(command.completedAt ?? command.createdAt)}. Open the extension on that browser to choose which folders sync.`
      : `${label} ran ${formatRelative(command.completedAt ?? command.createdAt)}.`
    case 'failed': return `${label} didn’t work${reason ? `: ${reason}` : ''}.`
    case 'expired': return `${label} expired. ${browser} didn’t check in within a week.`
  }
}

/** The latest command about the browser, or one issue; settled ones only for a day. */
function latestCommand(replica: SyncReplicaView, issueId: string | null): SyncReplicaCommandView | undefined {
  const command = replica.health?.commands.find((item) => item.issueId === issueId)
  if (!command) return undefined
  if (open(command)) return command
  return Date.now() - Date.parse(command.completedAt ?? command.createdAt) < DAY_MS ? command : undefined
}

const RESET_WARNING = 'That browser keeps its bookmarks, and so does your library here. Changes on it that haven’t '
  + 'synced yet are set aside. Afterwards, open the extension on that browser to choose which folders sync and review the merge.'

/** Sends one command; the server returns an open one instead of a second, so a double press is harmless. */
function useReplicaCommand(replica: SyncReplicaView, onSent: () => void) {
  const { success, error } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const send = async (action: Action, issueId?: string) => {
    const key = `${action}:${issueId ?? ''}`
    setBusy(key)
    try {
      await productClient.sendSyncReplicaCommand(replica.id, { action, ...(issueId ? { issueId } : {}) }, {
        intentId: `sync-command:${replica.id}:${key}:${crypto.randomUUID()}`, maxRetries: 1,
      })
      success(`Sent to ${replica.name}. It runs the next time that browser checks in.`)
      onSent()
    } catch (caught) {
      const apiError = caught instanceof ProductApiError ? caught : null
      error(apiError?.isPreconditionFailed
        ? 'That browser no longer offers this. Refresh to see what it reported last.'
        : apiError?.status === 429 ? 'That browser already has requests waiting. Try again after it checks in.'
          : 'Couldn’t send this to the browser. Try again.')
    } finally { setBusy(null) }
  }
  return { busy, send }
}

type IssuesState = { readonly phase: 'closed' } | { readonly phase: 'loading' }
  | { readonly phase: 'loaded'; readonly view: SyncReplicaIssuesView } | { readonly phase: 'failed' }

export function ReplicaHealth({ replica, onChanged }: { replica: SyncReplicaView; onChanged(): void }) {
  const [issues, setIssues] = useState<IssuesState>({ phase: 'closed' })
  const confirm = useConfirm()
  const command = useReplicaCommand(replica, onChanged)
  if (replica.status === 'retired') return null
  const health = replica.health
  const count = health?.issueCount ?? 0
  const load = async () => {
    setIssues({ phase: 'loading' })
    try { setIssues({ phase: 'loaded', view: await productClient.listSyncReplicaIssues(replica.id) }) }
    catch { setIssues({ phase: 'failed' }) }
  }
  const notes: string[] = []
  const latest = latestCommand(replica, null)
  // An open request takes the place of its button.
  const offered = (health?.actions ?? []).filter((action) => ACTION_LABELS[action]
    && !(latest && open(latest) && latest.action === action))
  if (health?.state === 'stopped' && health.code === 'replica_rebuilt') {
    notes.push('Sync on this browser was reset. Open the extension on it to choose which folders sync; it then shows up here as a new browser.')
  } else if (health?.state === 'stopped') {
    notes.push(`Sync on this browser has stopped: ${stopReason(health.code)} ${offered.length > 0
      ? 'Try the options below, or open the extension on that browser.' : 'Open the extension on that browser to fix it.'}`)
  } else if (health?.state === 'paused') {
    notes.push('Sync is paused on this browser. Nothing syncs until it’s resumed there.')
  } else if (health?.state === 'degraded') {
    notes.push(`${plural(count, 'item')} on this browser couldn’t sync. Everything else keeps syncing. ${offered.includes('rebuild') ? 'Reset sync below to repair this browser’s copy.' : ''}`)
  }
  if (notSyncing(replica) && health?.state !== 'stopped') notes.push(activityNote(replica))
  // A reset browser's own report already says what came of the reset.
  if (latest && (health?.code !== 'replica_rebuilt' || latest.action !== 'rebuild' || latest.state !== 'done')) notes.push(commandNote(latest, replica.name))
  if (notes.length === 0) return null
  const reset = async () => {
    if (await confirm({ title: `Reset sync on ${replica.name}?`, body: RESET_WARNING, confirmLabel: 'Reset sync' })) {
      await command.send('rebuild')
    }
  }
  const tone = health?.state === 'stopped' ? 'is-blocked' : 'is-stale'
  return <div className={`replica-message ${tone}`} role="status">
    {notes.map((note) => <p key={note}>{note}</p>)}
    {health && <p className="replica-reported">Reported {formatRelative(health.reportedAt)}.</p>}
    {offered.length > 0 && (
      <div className="replica-actions">
        {offered.includes('retry') && <button type="button" className="btn btn-secondary btn-sm" disabled={command.busy !== null}
          onClick={() => void command.send('retry')}>{command.busy === 'retry:' ? 'Sending…' : 'Retry'}</button>}
        {offered.includes('rebuild') && <button type="button" className="btn btn-danger-ghost btn-sm" disabled={command.busy !== null}
          onClick={() => void reset()}>{command.busy === 'rebuild:' ? 'Sending…' : 'Reset sync'}</button>}
      </div>
    )}
    {count > 0 && health?.state !== 'paused' && (issues.phase === 'closed' || issues.phase === 'failed') && (
      <div className="replica-actions">
        {issues.phase === 'failed' && <span>Couldn’t load the items.</span>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
          {issues.phase === 'failed' ? 'Try again' : `Show ${plural(count, 'item')}`}
        </button>
      </div>
    )}
    {issues.phase === 'loading' && <p>Loading items…</p>}
    {issues.phase === 'loaded' && <ReplicaIssueList view={issues.view} replica={replica}
      busy={command.busy} onRetry={(issueId) => void command.send('retry', issueId)} />}
  </div>
}

function ReplicaIssueList({ view, replica, busy, onRetry }: {
  view: SyncReplicaIssuesView; replica: SyncReplicaView; busy: string | null; onRetry(issueId: string): void
}) {
  if (view.items.length === 0) return <p>This browser has nothing set aside any more.</p>
  const more = view.total - view.items.length
  return <ul className="replica-issues" aria-label="Items this browser couldn’t sync">
    {view.items.map((issue) => (
      <li key={issue.issueId}>
        <strong>{issue.title ?? (issue.nodeId ? 'A bookmark in your library' : 'A bookmark on that browser')}</strong>
        <span>{issueSummary(issue)}{issue.count > 1 ? ` (${issue.count} times)` : ''}</span>
        <IssueCommand issue={issue} replica={replica} busy={busy} onRetry={onRetry} />
      </li>
    ))}
    {more > 0 && <li><span>and {plural(more, 'more item')}</span></li>}
  </ul>
}

function IssueCommand({ issue, replica, busy, onRetry }: {
  issue: SyncReplicaIssue; replica: SyncReplicaView; busy: string | null; onRetry(issueId: string): void
}) {
  const latest = latestCommand(replica, issue.issueId)
  if (latest && open(latest)) return <span>{commandNote(latest, replica.name)}</span>
  return <>
    {latest && <span>{commandNote(latest, replica.name)}</span>}
    {issue.actions.includes('retry') && <div className="replica-actions">
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null}
        aria-label={`Try again: ${issue.title ?? 'this item'}`} onClick={() => onRetry(issue.issueId)}>
        {busy === `retry:${issue.issueId}` ? 'Sending…' : 'Try again'}</button>
    </div>}
  </>
}
