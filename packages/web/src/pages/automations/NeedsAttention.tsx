import { Link } from 'react-router-dom'
import type { AutomationHealthIncident, AutomationRun } from '../../api/automationTypes'
import { Icon } from '../../components/Icon'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import { capitalize, incidentCopy, incidentMessage, incidentNeedsAgent, incidentNeedsFolder, runExplanation } from './copy'
import { ruleEditPath } from './paths'

/* What the owner should look at first (AU-03/04/05/22): open notices from
   the backend's health checks, and runs the backend left for a decision.
   Every action here is a backend command or a link to the place that
   repairs it; dismissing a notice hides it, it never marks it repaired. */

export type DecisionGroup = { key: string; runs: AutomationRun[] }

/** Runs the server put in review, grouped by the bookmark event they share, so two rules that disagree read as one item. */
export function decisionGroups(runs: readonly AutomationRun[]): DecisionGroup[] {
  const groups = new Map<string, AutomationRun[]>()
  for (const run of runs) {
    if (run.status !== 'review') continue
    const key = run.memberEventIds[0] ?? run.id
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  return [...groups.entries()].map(([key, items]) => ({ key, runs: items }))
}

function quoted(names: readonly string[]): string {
  const list = names.map((name) => `“${name}”`)
  if (list.length <= 1) return list[0] ?? 'A rule'
  return `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

export function NeedsAttention({
  incidents,
  decisions,
  ruleName,
  busyId,
  runHref,
  onAcknowledge,
  onRevalidate,
}: {
  incidents: readonly AutomationHealthIncident[]
  decisions: readonly DecisionGroup[]
  ruleName: (id: string) => string | undefined
  busyId: string | null
  /** Where a run opens, once the run page exists. */
  runHref?: (runId: string) => string
  onAcknowledge: (incident: AutomationHealthIncident) => void
  onRevalidate: (incident: AutomationHealthIncident) => void
}) {
  const count = incidents.length + decisions.length
  if (count === 0) return null
  return (
    <section className="automations-section" aria-labelledby="automations-attention-heading">
      <div className="automations-section-head">
        <h2 id="automations-attention-heading">Needs attention</h2>
        <span className="count-pill" data-testid="automations-attention-count">{count}</span>
      </div>
      <ul className="automation-notices">
        {incidents.map((incident) => {
          const copy = incidentCopy(incident)
          const name = ruleName(incident.ruleId)
          const busy = busyId === incident.id
          return (
            <li key={incident.id} className="automation-notice" data-tone={copy.tone} data-code={incident.code}>
              <span className="automation-notice-icon" aria-hidden><Icon name={copy.icon} /></span>
              <div className="automation-notice-body">
                <p className="automation-notice-title" data-testid="automation-notice-title">
                  {name ? <><span className="automation-term">{name}</span>: {copy.title}</> : capitalize(copy.title)}
                </p>
                <p className="automation-notice-text">{incidentMessage(incident)}</p>
                <p className="automation-meta">
                  Since <time dateTime={incident.firstSeenAt} title={formatDateTime(incident.firstSeenAt)}>{formatDate(incident.firstSeenAt)}</time>
                  {incident.blockingStages.length > 0 ? ' · The rule is stopped until this is fixed' : null}
                </p>
              </div>
              <div className="automation-notice-actions">
                {incidentNeedsFolder(incident) && (
                  <Link className="btn btn-secondary btn-sm" to={ruleEditPath(incident.ruleId)}>
                    Choose another folder
                  </Link>
                )}
                {incident.code === 'bindingDeleted' && (
                  <Link className="btn btn-ghost btn-sm" to="/sync">Restore folder</Link>
                )}
                {incidentNeedsAgent(incident) && (
                  <Link className="btn btn-secondary btn-sm" to="/agents">Open Agents</Link>
                )}
                {(incident.code === 'ruleConflict' || incident.code === 'highUndoRate') && (
                  <Link className="btn btn-secondary btn-sm" to={ruleEditPath(incident.ruleId)}>
                    Edit rule
                  </Link>
                )}
                {incident.severity !== 'info' && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onRevalidate(incident)}>
                    Check again
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onAcknowledge(incident)}>
                  Dismiss
                </button>
              </div>
            </li>
          )
        })}
        {decisions.map((group) => {
          const names = [...new Set(group.runs.map((run) => ruleName(run.ruleId) ?? 'A rule'))]
          const [first] = group.runs
          if (!first) return null
          const disagree = group.runs.length > 1
          return (
            <li key={group.key} className="automation-notice" data-tone="warning" data-kind="decision">
              <span className="automation-notice-icon" aria-hidden><Icon name="alert" /></span>
              <div className="automation-notice-body">
                <p className="automation-notice-title" data-testid="automation-notice-title">
                  {disagree ? <>{quoted(names)} disagree about a bookmark</> : <>{quoted(names)} needs a decision</>}
                </p>
                <p className="automation-notice-text">{runExplanation(first.explanation) ?? 'The rule stopped and left the bookmark where it was.'}</p>
                <p className="automation-meta">
                  <time dateTime={first.createdAt} title={formatDateTime(first.createdAt)}>{formatDate(first.createdAt)}</time>
                  {disagree ? ` · ${plural(group.runs.length, 'rule')} involved` : null}
                </p>
              </div>
              <div className="automation-notice-actions">
                {runHref && (
                  <Link className="btn btn-secondary btn-sm" to={runHref(first.id)}>View</Link>
                )}
                {group.runs.map((run) => (
                  <Link key={run.id} className="btn btn-ghost btn-sm" to={ruleEditPath(run.ruleId)}>
                    {disagree ? `Edit “${ruleName(run.ruleId) ?? 'rule'}”` : 'Edit rule'}
                  </Link>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
