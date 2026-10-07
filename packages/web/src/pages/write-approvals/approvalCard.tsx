import { Link, useLocation } from 'react-router-dom'
import type {
  WriteApprovalDecision,
  WriteApprovalOperationPreview,
  WriteApprovalView,
} from '../../api'
import { DataTable, DataTableCell, DataTableRow } from '../../components/DataTable'
import { Icon } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { consentScopeLabel, consentScopeMeta } from '../../lib/oauthScopes'
import { loginPath } from '../../lib/chrome'
import {
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

export function ApprovalCard({
  approval,
  draft,
  collectionTitles,
  onDecision,
  onRefresh,
  onStartNew,
}: {
  approval: WriteApprovalView
  draft: DecisionDraft
  collectionTitles: ReadonlyMap<string, string>
  onDecision: (decision: WriteApprovalDecision, replay?: boolean) => void
  onRefresh: () => void
  onStartNew: () => void
}) {
  const location = useLocation()
  const allowed = isDecisionAllowed(approval)
  const busy = draft.phase === 'submitting'
  const blocked = draft.phase === 'blocked'
  const terminal = !allowed && !busy && draft.phase !== 'unknown'
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
    >
      <header className="write-approval-card-head">
        <div className="write-approval-title">
          <StatusBadge tone={tone}>
            <Icon name={statusIcon(approval)} />
            {statusLabel(approval)}
          </StatusBadge>
          <h2 id={`write-approval-${approval.planId}`}>
            <Link to={`/approvals/${encodeURIComponent(approval.planId)}`}>
              {approval.summary}
            </Link>
          </h2>
        </div>
        <DataTable
          className="write-approval-facts"
          label="Approval facts"
          columns={[
            { key: 'created', label: 'Created' },
            { key: 'expires', label: 'Expires' },
            { key: 'risk', label: 'Risk' },
          ]}
        >
          <DataTableRow>
            <DataTableCell>{formatInstant(approval.createdAt)}</DataTableCell>
            <DataTableCell>{formatInstant(approval.expiresAt)}</DataTableCell>
            <DataTableCell>
              <StatusBadge tone={RISK_TONE[approval.risk]}>{RISK_LABEL[approval.risk]}</StatusBadge>
            </DataTableCell>
          </DataTableRow>
        </DataTable>
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

      <div className="write-approval-scopes">
        <span>Required scopes</span>
        {approval.requiredScopes.map((scope) => {
          const meta = consentScopeMeta(scope)
          const label = consentScopeLabel(scope)
          return (
            <span className="write-approval-scope" key={scope}>
              <span className="write-approval-scope-name">{meta?.name ?? scope}</span>
              {label ? <span className="write-approval-scope-label">{label}</span> : null}
            </span>
          )
        })}
      </div>

      <section className="write-approval-impact" aria-label="Impact">
        <span>Impact</span>
        <dl>
          <div><dt>Collections</dt><dd>{approval.impact.collections}</dd></div>
          <div>
            <dt>{approval.target.kind === 'collection' ? 'Items' : 'Bookmarks'}</dt>
            <dd>{approval.impact.nodes}</dd>
          </div>
          <div><dt>Annotations</dt><dd>{approval.impact.annotations}</dd></div>
          <div><dt>Attachments</dt><dd>{approval.impact.attachments}</dd></div>
          <div><dt>Relations</dt><dd>{approval.impact.relations}</dd></div>
        </dl>
        {approval.impact.privateFieldsExcluded.length > 0 && (
          <p>Private fields excluded: {approval.impact.privateFieldsExcluded.join(', ')}</p>
        )}
      </section>

      <section className="write-approval-operations" aria-label="Planned operations">
        <h3>Planned changes</h3>
        {approval.operations.length === 0 ? (
          <p>No operation preview available.</p>
        ) : (
          approval.operations.map((operation, index) => (
            <OperationPreview
              key={`${approval.planId}-${index}`}
              operation={operation}
              target={approval.target}
              collectionTitles={collectionTitles}
            />
          ))
        )}
      </section>

      {draft.message && (
        <div className={`write-approval-message ${DRAFT_PHASE_CLASS[draft.phase]}`} role="alert">
          {draft.message}
        </div>
      )}

      <footer className="write-approval-actions">
        {allowed && !busy && !blocked && draft.phase !== 'unknown' && draft.phase !== 'stale' && (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onDecision('approve')}
            >
              Approve
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onDecision('deny')}
            >
              Deny
            </button>
          </>
        )}
        {draft.phase === 'unknown' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onDecision(draft.frozen?.decision ?? 'approve', true)}
          >
            Retry decision
          </button>
        )}
        {draft.phase === 'stale' && draft.desiredDecision && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => onDecision(draft.desiredDecision!, false)}
          >
            Confirm {draft.desiredDecision === 'approve' ? 'approval' : 'denial'} with latest
          </button>
        )}
        {draft.phase === 'refresh_required' && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>
            Refresh approval
          </button>
        )}
        {blocked && (
          draft.frozen
            ? <button type="button" className="btn btn-secondary btn-sm" onClick={onStartNew}>Start new decision</button>
            : <Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm">Sign in</Link>
        )}
        {busy && <span role="status" className="write-approval-busy">Submitting decision…</span>}
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
  return (
    <div className="write-approval-operation">
      <div className="write-approval-operation-head">
        <span className="write-approval-operation-icon">
          <Icon name={operationIcon(operation)} />
        </span>
        <strong>{operationTypeLabel(operation, target)}</strong>
        <StatusBadge tone={visibilityTone(operation.visibility)} className="write-approval-visibility">
          {operation.visibility ?? 'No visibility change'}
        </StatusBadge>
      </div>
      <dl>
        <div><dt>Collection</dt><dd><RefValue id={operation.collectionId} title={collectionTitles.get(operation.collectionId ?? '') ?? null} /></dd></div>
        {collectionVisibility ? null : (
          <div><dt>Bookmark</dt><dd><RefValue id={operation.nodeId} title={summary?.title ?? null} /></dd></div>
        )}
        {summary && (
          <>
            <div><dt>Title</dt><dd>{summary.title ?? 'Not available'}</dd></div>
            <div><dt>URL</dt><dd>{summary.url ?? 'Not available'}</dd></div>
            <div><dt>Type</dt><dd>{summary.kind ?? 'Not available'}</dd></div>
          </>
        )}
      </dl>
    </div>
  )
}
