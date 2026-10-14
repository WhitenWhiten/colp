import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ProductApiError,
  type WriteApprovalDecision,
  type WriteApprovalOperationPreview,
  type WriteApprovalView,
} from '../../api'
import { Icon } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { consentScopeMeta } from '../../lib/oauthScopes'
import { plural } from '../../lib/plural'
import { loginPath } from '../../lib/chrome'
import { undoReason } from '../automations/copy'
import { rulePath, runPath } from '../automations/paths'
import { automationSummary, type AutomationPlan, type AutomationPlanState } from './automation'
import {
  effectiveStatus,
  formatInstant,
  isDecisionAllowed,
  keyChangeForOperation,
  operationIcon,
  operationTypeLabel,
  statusIcon,
  statusLabel,
  statusTone,
  terminalStatusDescription,
  visibilityTone,
  TONE_CLASS,
  RISK_TONE,
  RISK_LABEL,
  DRAFT_PHASE_CLASS,
  type DecisionDraft,
} from './types'

/* R10-19: operation previews carry opaque ids — resolve them to titles
   when we can, and let unresolved ids render as quiet .meta code instead
   of lead content. */
function RefValue({ id, title }: { id: string | null; title: string | null }) {
  if (title) return <>{title}</>
  if (id != null) return <code className="meta">{id}</code>
  return <>Not available</>
}

export function approvalApprovedBy(approval: WriteApprovalView): 'policy' | 'owner' | null {
  const value = approval.approvedBy
  return value === 'policy' || value === 'owner' ? value : null
}

const APPROVED_BY_TEXT: Record<'policy' | 'owner', string> = {
  policy: 'Approved automatically because you trust this agent. You can undo it.',
  owner: 'Approved by you. You can undo it.',
}

/** A confirmed automation plan: its rule and job, and the commands its card sends instead. */
export type AutomationCardControls = {
  plan: AutomationPlan
  state: AutomationPlanState
  onDecide: (decision: 'approve' | 'reject') => void
  onUndo: () => void
  onProposeAgain: () => void
}

export function ApprovalCard({
  approval,
  draft,
  collectionTitles,
  automation,
  onDecision,
  onRefresh,
  onStartNew,
  onUndo,
}: {
  approval: WriteApprovalView
  draft: DecisionDraft
  collectionTitles: ReadonlyMap<string, string>
  automation?: AutomationCardControls
  onDecision: (decision: WriteApprovalDecision, replay?: boolean) => void
  onRefresh: () => void
  onStartNew: () => void
  onUndo: (force: boolean) => Promise<void>
}) {
  const location = useLocation()
  // An automation change is undone through its own effect receipt, never by restoring a collection version.
  const approvedBy = automation ? null : approvalApprovedBy(approval)
  const [undoing, setUndoing] = useState(false)
  const [undoNeedsForce, setUndoNeedsForce] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const [showAllOperations, setShowAllOperations] = useState(false)
  const allowed = isDecisionAllowed(approval)
  const hiddenOperations = showAllOperations ? 0 : Math.max(0, approval.operations.length - OPERATION_PREVIEW_LIMIT)
  const scopeNames = approval.requiredScopes.map((scope) => consentScopeMeta(scope)?.name ?? scope)

  async function undo(force: boolean) {
    setUndoing(true)
    setUndoError(null)
    try {
      await onUndo(force)
      setUndoNeedsForce(false)
    } catch (error) {
      const apiError = error instanceof ProductApiError ? error : null
      setUndoNeedsForce(apiError?.status === 409 || apiError?.code === 'mutation_conflict')
      setUndoError(apiError?.message ?? 'Could not undo this plan.')
    } finally {
      setUndoing(false)
    }
  }
  const busy = automation ? automation.state.busy : draft.phase === 'submitting'
  const blocked = !automation && draft.phase === 'blocked'
  const terminal = !allowed && !busy && (automation !== undefined || draft.phase !== 'unknown')
  const tone = statusTone(approval)
  const keyChanges = approval.operations.flatMap((operation) => {
    const change = keyChangeForOperation(operation, approval.target)
    return change ? [change] : []
  })

  return (
    <article
      className={`panel panel-raised write-approval-card is-${approval.status}`}
      data-plan-id={approval.planId}
      data-status={approval.status}
      data-source={automation ? 'automation' : 'agent'}
    >
      <header className="write-approval-card-head">
        <div className="write-approval-badges">
          <StatusBadge tone={tone}>
            <Icon name={statusIcon(approval)} />
            {statusLabel(approval)}
          </StatusBadge>
          <StatusBadge tone={RISK_TONE[approval.risk]}>{RISK_LABEL[approval.risk]} risk</StatusBadge>
          {automation && (
            <StatusBadge tone="accent" data-testid="approval-automation-badge">
              <Icon name="bolt" />
              Automation
            </StatusBadge>
          )}
        </div>
        <h2 id={`write-approval-${approval.planId}`}>
          <Link to={`/approvals/${encodeURIComponent(approval.planId)}`}>
            {automation ? automationSummary(approval.summary) : approval.summary}
          </Link>
        </h2>
        <dl className="write-approval-facts" aria-label="Approval facts">
          {automation && (
            <div>
              <dt>From rule</dt>
              <dd><Link to={rulePath(automation.plan.ruleId)}>{automation.plan.ruleName ?? 'Open rule'}</Link></dd>
            </div>
          )}
          <div>
            <dt>{automation ? 'Proposed by' : 'Requested by'}</dt>
            <dd>{approval.agent?.name ?? approval.agent?.clientId ?? 'Unknown agent'}</dd>
          </div>
          <div><dt>Created</dt><dd>{formatInstant(approval.createdAt)}</dd></div>
          <div><dt>Expires</dt><dd>{formatInstant(approval.expiresAt)}</dd></div>
        </dl>
        {approval.reason && !automation && <p className="write-approval-reason"><strong>Agent-provided reason:</strong> {approval.reason}</p>}
      </header>

      {keyChanges.length > 0 && (
        <section className="write-approval-keychanges" aria-label="Key changes">
          <h3>Key changes</h3>
          {keyChanges.map((change, index) => (
            <div className="write-approval-keychange" key={index}>
              <span className="write-approval-keychange-icon">
                <Icon name={change.icon} />
              </span>
              <div className="write-approval-keychange-body">
                <p className="write-approval-keychange-title">
                  {change.title}
                  {change.targetId != null && (
                    <RefValue
                      id={change.targetId}
                      title={change.targetTitle ?? collectionTitles.get(change.targetId) ?? null}
                    />
                  )}
                </p>
                <p className="write-approval-keychange-detail">{change.detail}</p>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="write-approval-operations" aria-label="Planned operations">
        <h3>Planned changes</h3>
        {approval.operations.length === 0 ? (
          <p className="write-approval-empty">No operation preview available.</p>
        ) : (
          <ul className="write-approval-operation-list">
            {(showAllOperations ? approval.operations : approval.operations.slice(0, OPERATION_PREVIEW_LIMIT)).map((operation, index) => (
              <OperationPreview
                key={`${approval.planId}-${index}`}
                operation={operation}
                target={approval.target}
                collectionTitles={collectionTitles}
              />
            ))}
          </ul>
        )}
        {hiddenOperations > 0 && (
          <button type="button" className="write-approval-more" onClick={() => setShowAllOperations(true)}>
            Show {plural(hiddenOperations, 'more change')}
          </button>
        )}
        <p className="write-approval-impact">
          {impactSentence(approval)}
          {approval.impact.privateFieldsExcluded.length > 0 && (
            <> Private fields stay out of it: {approval.impact.privateFieldsExcluded.join(', ')}.</>
          )}
        </p>
      </section>

      {!automation && draft.message && (
        <div className={`write-approval-message ${DRAFT_PHASE_CLASS[draft.phase]}`} role="alert">
          {draft.message}
        </div>
      )}
      {automation?.state.message && (
        <div className="write-approval-message is-blocked" role="alert">{automation.state.message}</div>
      )}
      {automation && <AutomationPlanNotes approval={approval} automation={automation} />}

      {approvedBy && (
        <p className="write-approval-approved-by">{APPROVED_BY_TEXT[approvedBy]}</p>
      )}
      <footer className="write-approval-actions">
        {scopeNames.length > 0 && (
          <p className="write-approval-scopes">
            Needs <span>{scopeNames.join(' · ')}</span>
          </p>
        )}
        {approvedBy && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="approval-undo"
            disabled={undoing}
            onClick={() => void undo(false)}
          >
            Undo
          </button>
        )}
        {approvedBy && undoNeedsForce && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            data-testid="approval-undo-force"
            disabled={undoing}
            onClick={() => void undo(true)}
          >
            Undo anyway
          </button>
        )}
        {undoError && <p className="field-error" role="alert">{undoError}</p>}
        {automation && allowed && !busy && (
          <>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => automation.onDecide('reject')}>
              Deny
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!automation.plan.job.proposalDigest}
              onClick={() => automation.onDecide('approve')}
            >
              Approve
            </button>
          </>
        )}
        {automation && <AutomationPlanActions approval={approval} automation={automation} busy={busy} />}
        {!automation && allowed && !busy && !blocked && draft.phase !== 'unknown' && draft.phase !== 'stale' && (
          <>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onDecision('deny')}
            >
              Deny
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onDecision('approve')}
            >
              Approve
            </button>
          </>
        )}
        {!automation && draft.phase === 'unknown' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onDecision(draft.frozen?.decision ?? 'approve', true)}
          >
            Retry decision
          </button>
        )}
        {!automation && draft.phase === 'stale' && draft.desiredDecision && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onDecision(draft.desiredDecision!, false)}
          >
            Confirm {draft.desiredDecision === 'approve' ? 'approval' : 'denial'} with latest
          </button>
        )}
        {!automation && draft.phase === 'refresh_required' && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
            Refresh approval
          </button>
        )}
        {blocked && (
          draft.frozen
            ? <button type="button" className="btn btn-secondary btn-sm" onClick={onStartNew}>Start new decision</button>
            : <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Sign in</Link>
        )}
        {!automation && busy && <span role="status" className="write-approval-busy">Submitting decision…</span>}
        {terminal && (
          <div className={`write-approval-terminal ${TONE_CLASS[tone]}`} role="status">
            <span className="write-approval-terminal-icon">
              <Icon name={statusIcon(approval)} />
            </span>
            <div className="write-approval-terminal-body">
              <strong>{statusLabel(approval)}</strong>
              <p>{terminalStatusDescription(approval)}</p>
            </div>
          </div>
        )}
      </footer>
    </article>
  )
}

/* What the plan's job and effect say now: a stale proposal, an undone or
   not-undoable change (in the receipt's own reason), a link to the run. */
function AutomationPlanNotes({ approval, automation }: { approval: WriteApprovalView; automation: AutomationCardControls }) {
  const { job, effect, run } = automation.plan
  const notes: string[] = []
  if (job.status === 'stale') notes.push('The bookmark changed after this was proposed, so it can’t be applied as it is.')
  if (job.status === 'review' && approval.status === 'cancelled') notes.push('You denied it. Nothing from this step was applied.')
  if (effect?.status === 'reverted') notes.push('Undone.')
  else if (effect && !effect.undoAvailable) notes.push(undoReason(effect.undoReason))
  // An empty block would still take a row (and its gap) in the card.
  if (notes.length === 0 && !run) return null
  return (
    <div className="write-approval-automation" data-testid="approval-automation-notes">
      {notes.map((note) => <p key={note}>{note}</p>)}
      {run && <p><Link to={runPath(run.id)}>See the run</Link></p>}
    </div>
  )
}

function AutomationPlanActions({
  approval,
  automation,
  busy,
}: {
  approval: WriteApprovalView
  automation: AutomationCardControls
  busy: boolean
}) {
  const { job, effect } = automation.plan
  const expired = effectiveStatus(approval) === 'expired'
  return (
    <>
      {effect?.undoAvailable && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          data-testid="approval-automation-undo"
          disabled={busy}
          title={undoReason(effect.undoReason)}
          onClick={automation.onUndo}
        >
          Undo this change
        </button>
      )}
      {expired && job.status === 'review' && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={automation.onProposeAgain}>
          Propose again
        </button>
      )}
      {busy && <span role="status" className="write-approval-busy">Working…</span>}
    </>
  )
}

function OperationPreview({
  operation,
  target,
  collectionTitles,
}: {
  operation: WriteApprovalOperationPreview
  target: WriteApprovalView['target']
  collectionTitles: ReadonlyMap<string, string>
}) {
  const summary = operation.nodeSummary
  const collectionVisibility = operation.type === 'set_visibility' && target.kind === 'collection'
  const label = operationTypeLabel(operation, target)
  const description = operation.description ? withoutLeadingVerb(operation.description, label) : null
  const collectionTitle = collectionTitles.get(operation.collectionId ?? '') ?? null
  return (
    <li className="write-approval-operation">
      <span className="write-approval-operation-icon" aria-hidden>
        <Icon name={operationIcon(operation)} />
      </span>
      <div className="write-approval-operation-body">
        <p className="write-approval-operation-head">
          <strong>{label}</strong>
          {description && <span className="write-approval-operation-description" data-testid="approval-operation-description">{description}</span>}
          {!description && !collectionVisibility && (summary?.title || operation.nodeId) ? (
            <span className="write-approval-operation-description">
              <RefValue id={operation.nodeId} title={summary?.title ?? null} />
            </span>
          ) : null}
          {operation.visibility != null && (
            <StatusBadge tone={visibilityTone(operation.visibility)} className="write-approval-visibility">
              {operation.visibility}
            </StatusBadge>
          )}
        </p>
        <p className="write-approval-operation-meta">
          {summary?.url && <span className="write-approval-operation-url">{summary.url}</span>}
          <span>
            in <RefValue id={operation.collectionId} title={collectionTitle} />
          </span>
        </p>
      </div>
    </li>
  )
}

/** "move Docs from /A to /B" under the label "Move" reads "Docs from /A to /B". */
function withoutLeadingVerb(description: string, label: string): string {
  const verb = label.split(' ')[0]?.toLowerCase() ?? ''
  const lower = description.toLowerCase()
  return verb && lower.startsWith(`${verb} `) ? description.slice(verb.length + 1) : description
}

const OPERATION_PREVIEW_LIMIT = 6

/** Only the counts that are not zero, as one sentence. */
export function impactSentence(approval: WriteApprovalView): string {
  const { impact } = approval
  const parts = [
    impact.nodes > 0 ? plural(impact.nodes, approval.target.kind === 'collection' ? 'item' : 'bookmark') : null,
    impact.annotations > 0 ? plural(impact.annotations, 'note') : null,
    impact.attachments > 0 ? plural(impact.attachments, 'attachment') : null,
    impact.relations > 0 ? plural(impact.relations, 'relation') : null,
  ].filter((part): part is string => part !== null)
  const where = plural(impact.collections, 'collection')
  if (parts.length === 0) return `Touches ${where}.`
  const what = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
  return `Touches ${what} in ${where}.`
}
