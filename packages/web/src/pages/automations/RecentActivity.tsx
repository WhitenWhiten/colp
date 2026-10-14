import { Link } from 'react-router-dom'
import type { AutomationRun } from '../../api/automationTypes'
import { formatDateTime, formatRelative } from '../../lib/formatDate'
import { RUN_KIND, RUN_STATUS, runExplanation } from './copy'
import { runPath } from './paths'
import type { Load } from './shared'
import { errorMessage } from './shared'

/* The Automations page's live column: the latest runs the server reports,
   newest first, each a way into its run. A dot carries the run's state; the
   words appear only when it is not simply done. Read-only: every state is
   the server's. */

const SHOWN = 6

export function RecentActivity({
  runs,
  ruleName,
  onRetry,
}: {
  runs: Load<{ items: AutomationRun[] }>
  ruleName: (id: string) => string | undefined
  onRetry: () => void
}) {
  const items = runs.status === 'ready' ? runs.data.items.slice(0, SHOWN) : []
  const unread = runs.status === 'ready' ? runs.data.items.filter((run) => run.unread && run.outputCount > 0).length : 0
  return (
    <section className="automation-activity" aria-labelledby="automations-activity-heading" data-testid="automations-activity">
      <div className="automation-activity-head">
        <h2 id="automations-activity-heading">Recent activity</h2>
        <Link className="automation-activity-more" to="/automations/digests">
          Digests
          {unread > 0 && <span className="automations-count" data-tone="accent">{unread}</span>}
        </Link>
      </div>
      {runs.status === 'loading' && (
        <ul className="automation-activity-list" aria-hidden>
          {[0, 1, 2].map((key) => <li key={key} className="automation-activity-skeleton" />)}
        </ul>
      )}
      {runs.status === 'error' && (
        <div className="automation-inline-error" role="alert">
          <p>{errorMessage(runs.error, 'Could not load recent runs.')}</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>
        </div>
      )}
      {runs.status === 'ready' && items.length === 0 && (
        <p className="automation-activity-empty">
          Nothing has run yet. Each time a rule files a bookmark, it shows up here.
        </p>
      )}
      {items.length > 0 && (
        <ol className="automation-activity-list">
          {items.map((run) => {
            const status = RUN_STATUS[run.status]
            const name = ruleName(run.ruleId)
            return (
              <li key={run.id} className="automation-activity-item" data-run-id={run.id} data-status={run.status}>
                <span className="automation-dot" data-tone={status.tone} aria-hidden />
                <div className="automation-activity-body">
                  <Link className="automation-activity-title" to={runPath(run.id)}>
                    {runExplanation(run.explanation) ?? RUN_KIND[run.kind]}
                  </Link>
                  <p className="automation-meta">
                    {name ?? 'A rule'}
                    {' · '}
                    <time dateTime={run.createdAt} title={formatDateTime(run.createdAt)}>{formatRelative(run.createdAt)}</time>
                    {run.status !== 'completed' && <> · <span className="automation-activity-state" data-tone={status.tone}>{status.label}</span></>}
                    {run.unread && run.outputCount > 0 && <> · <span className="automation-activity-state" data-tone="accent">New text</span></>}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
