import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ProductApiError, productClient, type SyncReplicaCommandView, type SyncReplicaIssue, type SyncReplicaIssuesView,
  type SyncReplicaView,
} from '../../api'
import { BodyPortal } from '../../components/BodyPortal'
import { CopyField } from '../../components/CopyField'
import { useToast } from '../../components/AppToast'
import { useConfirm } from '../../components/ConfirmModal'
import { LoadingState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import type { StatusTone } from '../../components/StatusBadge'
import { formatRelative } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import { isRealInstant, issueSummary, problemFamily, resultReason, stopNext, stopReason } from './problems'
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

export { issueSummary, stopReason } from './problems'

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
const DAY_MS = 24 * 60 * 60_000
/**
 * A healthy browser reports at least every 15 minutes, checked by an alarm every 5, so up to 20 minutes between
 * two reports is normal. The band waits for two such gaps and a margin, so it never shows for a browser that is fine.
 */
export const REPORT_STALE_MINUTES = 45
const STATE_SINCE = { stopped: 'Stopped', degraded: 'Needs attention', paused: 'Paused' } as const

/** “Upload · First seen … · Last seen …”. A time the browser could not know (it sends the epoch) is left out. */
function issueMeta(issue: SyncReplicaIssue): string {
  const kind = issue.direction === 'push' ? 'Upload' : issue.direction === 'pull' ? 'Download' : 'Local merge or capture'
  return [kind, isRealInstant(issue.firstSeenAt) && `First seen ${formatRelative(issue.firstSeenAt)}`,
    isRealInstant(issue.lastSeenAt) && `Last seen ${formatRelative(issue.lastSeenAt)}`].filter(Boolean).join(' · ')
}

function open(command: SyncReplicaCommandView): boolean {
  return command.state === 'pending' || command.state === 'delivered'
}

type Reported = Pick<NonNullable<SyncReplicaView['health']>, 'state' | 'reportedAt'>

/** A request the browser carried out is not a cure: say what it did, and what the browser reports since. */
function triedAgain(command: SyncReplicaCommandView, browser: string, report: Reported | undefined): string {
  const did = command.issueId ? `${browser} tried this item again` : `${browser} tried again`
  const ranAt = command.completedAt ? Date.parse(command.completedAt) : Number.NaN
  // The report that carried the result is the first to reflect it.
  if (!report || !(Date.parse(report.reportedAt) >= ranAt)) return `${did}. Its next report shows whether that fixed it.`
  return report.state === 'syncing' ? `${did}, and it now reports that sync is running.` : `${did}, but it still reports a problem.`
}

/** What came of the latest command, in plain words. `report` is the browser's latest, to say whether the request helped. */
export function commandNote(command: SyncReplicaCommandView, browser: string, report?: Reported): string {
  const label = ACTION_LABELS[command.action] ?? 'The request'
  // A browser that has been quiet for hours will not check in within five minutes: say so instead of promising it.
  const quiet = report !== undefined && Date.now() - Date.parse(report.reportedAt) > REPORT_STALE_MINUTES * 60_000
  switch (command.state) {
    case 'pending': return quiet
      ? `${label} sent. ${browser} hasn’t checked in since ${formatRelative(report.reportedAt)}, so it runs once that browser is open and online again.`
      : `${label} sent. It runs when ${browser} next checks in, usually within five minutes while it’s open.`
    case 'delivered': return `${label} sent. Waiting for ${browser} to report back.`
    case 'done': if (command.resultCode === 'exact_retry_requested' || command.resultCode === 'recapture_completed' || command.resultCode === 'retry_completed') return triedAgain(command, browser, report)
      if (command.resultCode === 'retry_scheduled') return `Retry was scheduled on ${browser}. Check its sync status for the result.`
      return command.action === 'rebuild'
      ? `Sync was reset ${formatRelative(command.completedAt ?? command.createdAt)}. Open the extension on that browser to choose which folders sync.`
      : `${label} ran ${formatRelative(command.completedAt ?? command.createdAt)}.`
    case 'failed': return `${label} didn’t work${command.resultCode ? `: ${resultReason(command.resultCode)}` : ''}.`
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
  + 'synced yet are archived and will not be retried. The server stops uploads from its old sync copy before rebuilding it. '
  + 'An upload whose result was unknown may already be in your library. Afterwards, open the extension on that browser '
  + 'to choose which folders sync and review the merge.'

/** Sends one command; the server returns an open one instead of a second, so a double press is harmless. */
function useReplicaCommand(replica: SyncReplicaView, onSent: () => void) {
  const { success, error } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  useEffect(() => { invalidate(); setBusy(null); setFeedback(null); return invalidate }, [replica.id, invalidate])
  const send = async (action: Action, issueId?: string) => {
    const key = `${action}:${issueId ?? ''}`
    const ticket = ++generation.current
    setBusy(key); setFeedback(null)
    try {
      await productClient.sendSyncReplicaCommand(replica.id, { action, ...(issueId ? { issueId } : {}) }, {
        intentId: `sync-command:${replica.id}:${key}:${crypto.randomUUID()}`, maxRetries: 1,
      })
      if (ticket !== generation.current) return
      setFeedback(`Request delivered to the server; waiting for ${replica.name} to execute it and report its result.`)
      success(`Sent to ${replica.name}. It runs the next time that browser checks in.`)
      onSent()
    } catch (caught) {
      if (ticket !== generation.current) return
      const apiError = caught instanceof ProductApiError ? caught : null
      const message = apiError?.isPreconditionFailed
        ? 'That browser no longer offers this. Refresh to see what it reported last.'
        : apiError?.status === 429 ? 'That browser already has requests waiting. Try again after it checks in.'
          : 'Couldn’t send this to the browser. Try again.'
      setFeedback(message); error(message)
      if (apiError?.isPreconditionFailed) onSent()
    } finally { if (ticket === generation.current) setBusy(null) }
  }
  return { busy, send, feedback }
}

type IssuesState = { readonly phase: 'closed' } | { readonly phase: 'loading' }
  | { readonly phase: 'loaded'; readonly view: SyncReplicaIssuesView } | { readonly phase: 'failed' }

/**
 * A browser's health on its card: a band when there is something to say
 * (with Retry / Reset sync when the browser offers them), then the card's
 * foot — the diagnostics button and `children` (Stop syncing) on one row.
 */
export function ReplicaHealth({ replica, onChanged, children }: {
  replica: SyncReplicaView; onChanged(): void; children?: ReactNode
}) {
  const [issues, setIssues] = useState<IssuesState>({ phase: 'closed' })
  const [expanded, setExpanded] = useState(false)
  const requestGeneration = useRef(0)
  const invalidateRequests = useCallback(() => { requestGeneration.current++ }, [])
  const confirm = useConfirm()
  const command = useReplicaCommand(replica, onChanged)
  const health = replica.health
  const count = health?.issueCount ?? 0
  const load = useCallback(async (signal?: AbortSignal) => {
    const ticket = ++requestGeneration.current
    setIssues({ phase: 'loading' })
    try {
      const view = await productClient.listSyncReplicaIssues(replica.id, { signal })
      if (ticket === requestGeneration.current && !signal?.aborted) setIssues({ phase: 'loaded', view })
    } catch { if (ticket === requestGeneration.current && !signal?.aborted) setIssues({ phase: 'failed' }) }
  }, [replica.id])
  useEffect(() => {
    const controller = new AbortController()
    if (expanded) void load(controller.signal)
    return () => { controller.abort(); invalidateRequests() }
  }, [load, expanded, health?.reportedAt, invalidateRequests])
  if (replica.status === 'retired' && !health?.commands.some(item => item.action === 'rebuild')) return null
  const notes: string[] = []
  const latest = latestCommand(replica, null)
  // An open request takes the place of its button.
  const offered = (health?.actions ?? []).filter((action) => ACTION_LABELS[action]
    && (replica.status !== 'retired' || action === 'rebuild')
    && !(latest && open(latest) && latest.action === action))
  if (replica.status === 'retired' && health?.code !== 'replica_rebuilt') {
    notes.push('The server has stopped uploads from the old sync copy. Waiting for this browser to finish resetting sync.')
  } else if (health?.state === 'stopped' && health.code === 'replica_rebuilt') {
    notes.push('Sync on this browser was reset. Open the extension on it to choose which folders sync; it then shows up here as a new browser.')
  } else if (health?.state === 'stopped') {
    notes.push(`Sync on this browser has stopped: ${stopReason(health.code)} ${stopNext(health.code, offered)}`)
  } else if (health?.state === 'paused') {
    notes.push(health.code === 'sync_disconnected'
      ? 'Sync is turned off on this browser. It keeps its bookmarks; nothing syncs until it’s connected again there.'
      : 'Sync is paused on this browser. Nothing syncs until it’s resumed there.')
  } else if (health?.state === 'degraded') {
    // A code on a degraded report is a pause the browser ends by itself, or a stall its watchdog noticed; neither is a stop.
    if (health.code) notes.push(`Sync on this browser ${problemFamily(health.code) === 'stalled' ? 'looks stuck' : 'hit repeated errors and is waiting to try again'}: ${stopReason(health.code)} ${stopNext(health.code, offered)}`)
    if (count > 0 || !health.code) notes.push(`${plural(count, 'item')} on this browser couldn’t sync. Review the items and available recovery actions below. ${offered.includes('rebuild') ? 'Reset sync can repair this browser’s copy if retrying does not help.' : ''}`)
  }
  if (notSyncing(replica) && health?.state !== 'stopped') notes.push(activityNote(replica))
  // A reset browser's own report already says what came of the reset.
  if (latest && (health?.code !== 'replica_rebuilt' || latest.action !== 'rebuild' || latest.state !== 'done')) notes.push(commandNote(latest, replica.name, health ?? undefined))
  const reset = async () => {
    if (await confirm({ title: `Reset sync on ${replica.name}?`, body: RESET_WARNING, confirmLabel: 'Reset sync' })) {
      await command.send('rebuild')
    }
  }
  const tone = health?.state === 'stopped' ? 'is-blocked' : notes.length > 0 ? 'is-stale' : ''
  const paused = health?.state === 'paused'
  const showLabel = count > 0 && !paused ? `Show ${plural(count, 'item')}` : 'Show diagnostics'
  const staleReport = health !== null && health !== undefined && Date.now() - Date.parse(health.reportedAt) > REPORT_STALE_MINUTES * 60_000
  const sinceNote = health && health.state !== 'syncing' && isRealInstant(health.since)
    ? `. ${STATE_SINCE[health.state]} since ${formatRelative(health.since)}` : ''
  // The band only frames something to say; a quiet browser shows its foot alone.
  const framed = notes.length > 0 || command.feedback !== null || staleReport
  const retry = offered.includes('retry')
  const rebuild = offered.includes('rebuild')
  const recoveryActions = (retry || rebuild) && <div className="replica-actions">
    {retry && <button type="button" className="btn btn-secondary btn-sm" disabled={command.busy !== null}
      onClick={() => void command.send('retry')}>{command.busy === 'retry:' ? 'Sending…' : 'Retry'}</button>}
    {rebuild && <button type="button" className="btn btn-danger-ghost btn-sm" disabled={command.busy !== null}
      onClick={() => void reset()}>{command.busy === 'rebuild:' ? 'Sending…' : 'Reset sync'}</button>}
  </div>
  return <>
    {framed && <div className={`replica-message ${tone}`.trim()} role={notes.length > 0 ? 'status' : undefined}>
      {notes.map((note) => <p key={note}>{note}</p>)}
      {health && <p className="replica-reported">Reported {formatRelative(health.reportedAt)}{sinceNote}.</p>}
      {command.feedback && <p role="alert">{command.feedback}</p>}
      {staleReport && <p>This browser’s report is over {REPORT_STALE_MINUTES} minutes old. Open the extension to refresh its status before relying on it.</p>}
      {recoveryActions}
    </div>}
    <div className="replica-foot">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setExpanded(true)}>{showLabel}</button>
      {children}
    </div>
    {/* The items open in a dialog so the card keeps its height in the grid. */}
    <BodyPortal>
      <Modal open={expanded} onClose={() => setExpanded(false)} size="lg" label={`Sync diagnostics for ${replica.name}`}
        title={`Sync diagnostics · ${replica.name}`}>
        <div className="replica-diagnostics">
          <div className="replica-diagnostics-bar">
            <span>{health ? `Reported ${formatRelative(health.reportedAt)}` : 'This browser hasn’t sent a report yet'}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={issues.phase === 'loading'}
              onClick={() => void load()}>{issues.phase === 'failed' ? 'Try again' : 'Refresh'}</button>
          </div>
          {(issues.phase === 'loading' || issues.phase === 'closed') && <LoadingState label="Loading items…" />}
          {issues.phase === 'failed' && <p>Couldn’t load the items.</p>}
          {command.feedback && <p role="alert">{command.feedback}</p>}
          {recoveryActions}
          {issues.phase === 'loaded' && <>
            {paused
              ? <p>Sync is paused on this browser, so its items aren’t listed.</p>
              : <ReplicaIssueList view={issues.view} replica={replica} busy={command.busy}
                onRetry={(issueId) => void command.send('retry', issueId)} />}
            <AckWarnings view={issues.view} />
            <details className="replica-raw">
              <summary><Icon name="chevron-right" />Raw diagnostics</summary>
              <CopyField label="sync diagnostics" compact multiline value={JSON.stringify({ health: health ?? null, ...issues.view,
                ...(paused ? { items: [] } : {}) }, null, 2)} />
            </details>
          </>}
        </div>
      </Modal>
    </BodyPortal>
  </>
}

function ReplicaIssueList({ view, replica, busy, onRetry }: {
  view: SyncReplicaIssuesView; replica: SyncReplicaView; busy: string | null; onRetry(issueId: string): void
}) {
  if (view.items.length === 0) return <p>{view.total > 0
    ? `This browser reports ${plural(view.total, 'issue')}, but their details were omitted from its bounded report. Open the extension to inspect them.`
    : 'This browser has nothing set aside any more.'}</p>
  const more = view.total - view.items.length
  const stale = Boolean(replica.health?.reportedAt && view.reportedAt !== replica.health.reportedAt)
  return <>
    {stale && <p className="replica-diagnostics-stale">This item list predates the latest browser report. Refresh before acting.</p>}
    <ul className="replica-issues" aria-label="Items this browser couldn’t sync">
    {view.items.map((issue) => {
      const latest = latestCommand(replica, issue.issueId)
      // An open request takes the place of its button.
      const retry = issue.actions.includes('retry') && !(latest && open(latest))
      return <li key={issue.issueId}>
        <div className="replica-issue-body">
          <strong>{issue.title ?? (issue.nodeId ? 'A bookmark in your library' : 'A bookmark on that browser')}</strong>
          <span>{issueSummary(issue)}{issue.count > 1 ? ` (${issue.count} times)` : ''}</span>
          <div className="replica-issue-meta">
            <span>{issueMeta(issue)}</span>
            <CopyField label="error code" compact value={issue.code} />
          </div>
          {latest && <span className="replica-issue-note">{commandNote(latest, replica.name, replica.health ?? undefined)}</span>}
        </div>
        {retry && <button type="button" className="btn btn-secondary btn-sm" disabled={stale || busy !== null}
          aria-label={`Try again: ${issue.title ?? 'this item'}`} onClick={() => onRetry(issue.issueId)}>
          {busy === `retry:${issue.issueId}` ? 'Sending…' : 'Try again'}</button>}
      </li>
    })}
    {more > 0 && <li><span>and {plural(more, 'more item')}</span></li>}
  </ul></>
}

/** Warnings ride the latest acknowledgement only; without any, the raw diagnostics still carry the empty list. */
function AckWarnings({ view }: { view: SyncReplicaIssuesView }) {
  if (view.ackWarnings.length === 0) return null
  return <section className="replica-ack" aria-label="Latest acknowledgement warnings">
    <h3>Latest acknowledgement warnings{view.ackWarningsAt ? ` · ${formatRelative(view.ackWarningsAt)}` : ''}</h3>
    <p>These describe the latest acknowledgement and are separate from current open issues; they are not a cumulative history.</p>
    <ul className="replica-issues">
      {[...new Map(view.ackWarnings.map(warning => [JSON.stringify(warning), warning])).values()].map(warning =>
        <li key={JSON.stringify(warning)}><div className="replica-issue-body"><span>{warning.message}</span>
          <div className="replica-issue-meta">{warning.path && <code>{warning.path}</code>}
            <CopyField label="warning code" compact value={warning.code} /></div></div></li>)}
    </ul>
  </section>
}
