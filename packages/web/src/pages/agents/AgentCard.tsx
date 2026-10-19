import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AgentAuditRecord, AgentPolicy, AgentSummary } from '../../api/agentsClient'
import { Icon } from '../../components/Icon'
import { StatusBadge, type StatusTone } from '../../components/StatusBadge'
import { formatDate, formatDateTime, formatRelative } from '../../lib/formatDate'
import { consentScopeMeta, groupScopes } from '../../lib/oauthScopes'

export type AgentActivity =
  | { status: 'closed' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; records: AgentAuditRecord[] }

const POLICY_NOTE: Readonly<Record<AgentPolicy, string>> = {
  manual: 'Every change waits for you on Approvals.',
  trusted: 'Moves apply right away and can be undone. Deletes and publishing still wait.',
}

const OUTCOMES: Readonly<Record<string, { label: string; tone: StatusTone }>> = {
  pending: { label: 'Waiting for you', tone: 'warning' },
  approved: { label: 'Approved', tone: 'accent' },
  committing: { label: 'Applying', tone: 'accent' },
  consumed: { label: 'Applied', tone: 'success' },
  committed: { label: 'Applied', tone: 'success' },
  applied: { label: 'Applied', tone: 'success' },
  succeeded: { label: 'Applied', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  denied: { label: 'Denied', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'danger' },
  expired: { label: 'Expired', tone: 'muted' },
  undone: { label: 'Undone', tone: 'muted' },
}

export function outcomeBadge(outcome: string): { label: string; tone: StatusTone } {
  const known = OUTCOMES[outcome]
  if (known) return known
  const words = outcome.replace(/[_-]+/gu, ' ').trim()
  return { label: words ? words[0]!.toUpperCase() + words.slice(1) : outcome, tone: 'neutral' }
}

function versionHref(record: AgentAuditRecord): string | null {
  if (!record.versionId) return null
  if (record.collectionId) return `/library/${encodeURIComponent(record.collectionId)}/history`
  if (record.kind === 'plan') {
    return `/approvals/${encodeURIComponent(record.id)}#version-${encodeURIComponent(record.versionId)}`
  }
  return null
}

function ScopeList({ scopes, kind }: { scopes: readonly string[]; kind: AgentSummary['kind'] }) {
  if (scopes.length === 0) {
    return (
      <p className="agent-card-meta">
        {kind === 'api_key' ? 'Permissions are chosen when the key is exchanged for a token.' : 'No permissions granted.'}
      </p>
    )
  }
  // One chip per permission group; the scope names are in the tooltip.
  return (
    <ul className="agent-scopes" aria-label="Permissions">
      {groupScopes(scopes).map((group) => (
        <li
          key={group.id}
          className="agent-scope"
          title={group.scopes.map((scope) => consentScopeMeta(scope)?.name ?? scope).join(', ')}
        >
          <Icon name={group.icon} />
          {group.name}
        </li>
      ))}
    </ul>
  )
}

function ActivityList({ activity }: { activity: AgentActivity }) {
  if (activity.status === 'closed') return null
  if (activity.status === 'loading') return <p className="agent-card-meta" role="status">Loading activity…</p>
  if (activity.status === 'error') return <p className="field-error" role="alert">{activity.message}</p>
  if (activity.records.length === 0) {
    return <p className="agent-card-meta">No plans or direct writes yet. They show up here as the agent works.</p>
  }
  return (
    <ol className="agent-activity">
      {activity.records.map((record) => {
        const badge = outcomeBadge(record.outcome)
        const href = versionHref(record)
        return (
          <li key={record.id} className="agent-activity-item">
            <span className="agent-activity-icon" aria-hidden>
              <Icon name={record.kind === 'plan' ? 'file' : 'bookmark'} />
            </span>
            <div className="agent-activity-body">
              <p className="agent-activity-summary">
                {record.summary || (record.kind === 'plan' ? 'Change plan' : 'Direct write')}
              </p>
              <p className="agent-card-meta">
                {record.kind === 'plan' ? 'Plan' : 'Direct write'} · <time dateTime={record.createdAt}>{formatDateTime(record.createdAt)}</time>
                {record.versionId && href && (
                  <>
                    {' · '}
                    <Link to={href} aria-label={`Version ${record.versionId} in Version history`}>Saved a version</Link>
                  </>
                )}
                {record.versionId && !href && ' · Saved a version'}
              </p>
            </div>
            <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * One connected agent: who it is, when it last worked, what it may do, and
 * the one decision the owner makes about it (approval policy). Activity
 * opens in place; Revoke sits apart as the destructive action.
 */
export function AgentCard({
  agent,
  busy,
  activity,
  onPolicy,
  onToggleActivity,
  onRevoke,
  automation,
}: {
  agent: AgentSummary
  busy: boolean
  activity: AgentActivity
  /** This agent's automation opt-ins, where the server has automations and a connection for it. */
  automation?: ReactNode
  onPolicy: (policy: AgentPolicy) => void
  onToggleActivity: () => void
  onRevoke: () => void
}) {
  const open = activity.status !== 'closed'
  const activityId = `agent-activity-${agent.id}`
  return (
    <article className="agent-card" data-agent-id={agent.id} aria-labelledby={`agent-name-${agent.id}`}>
      <header className="agent-card-head">
        <span className="agent-card-icon" aria-hidden>
          <Icon name={agent.kind === 'api_key' ? 'key' : 'terminal'} />
        </span>
        <div className="agent-card-title">
          <h3 id={`agent-name-${agent.id}`}>{agent.name}</h3>
          <p className="agent-card-meta">
            {agent.kind === 'api_key' ? 'API key' : 'OAuth client'}
            {' · '}Connected <time dateTime={agent.createdAt}>{formatDate(agent.createdAt)}</time>
            {' · '}
            {agent.lastSeenAt
              ? <>Last active <time dateTime={agent.lastSeenAt} title={formatDateTime(agent.lastSeenAt)}>{formatRelative(agent.lastSeenAt)}</time></>
              : 'Not used yet'}
          </p>
        </div>
        <button type="button" className="btn btn-danger-ghost btn-sm" disabled={busy} onClick={onRevoke}>
          Revoke
        </button>
      </header>

      <div className="agent-card-policy">
        <div className="view-switch" role="group" aria-label={`Approval policy for ${agent.name}`}>
          <button type="button" aria-pressed={agent.policy === 'manual'} disabled={busy} onClick={() => onPolicy('manual')}>
            Manual
          </button>
          <button type="button" aria-pressed={agent.policy === 'trusted'} disabled={busy} onClick={() => onPolicy('trusted')}>
            Trusted
          </button>
        </div>
        <p className="agent-card-meta">{POLICY_NOTE[agent.policy]}</p>
      </div>

      <ScopeList scopes={agent.scopes} kind={agent.kind} />

      {automation}

      <div className="agent-card-foot">
        <button
          type="button"
          className="agent-card-toggle"
          aria-expanded={open}
          aria-controls={activityId}
          onClick={onToggleActivity}
        >
          <Icon name={open ? 'chevron-up' : 'chevron-down'} />
          {open ? 'Hide activity' : 'Activity'}
        </button>
      </div>
      {open && (
        <div id={activityId} className="agent-card-activity">
          <ActivityList activity={activity} />
        </div>
      )}
    </article>
  )
}
