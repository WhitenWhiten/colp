import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { AutomationRun } from '../../api/automationTypes'
import { Icon } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDateTime, formatRelative } from '../../lib/formatDate'
import { RUN_KIND, RUN_STATUS, runExplanation } from './copy'
import { runPath } from './paths'

/** One run in a timeline: what happened, which rule, when, its state, and a way into the run. */
export function RunItem({
  run,
  ruleName,
  children,
}: {
  run: AutomationRun
  /** Omitted where the page is already about one rule. */
  ruleName?: string | null
  children?: ReactNode
}) {
  const tone = RUN_STATUS[run.status]
  return (
    <li className="automation-history-item" data-run-id={run.id} data-status={run.status}>
      <span className="automation-history-icon" aria-hidden><Icon name="bolt" /></span>
      <div className="automation-history-body">
        <p className="automation-history-title">
          <Link to={runPath(run.id)}>{runExplanation(run.explanation) ?? RUN_KIND[run.kind]}</Link>
        </p>
        <p className="automation-meta">
          {ruleName !== undefined && <>{ruleName ? <>Rule “{ruleName}”</> : 'A rule'}{' · '}</>}
          <time dateTime={run.createdAt} title={formatDateTime(run.createdAt)}>{formatRelative(run.createdAt)}</time>
          {run.kind !== 'intake' ? <> · {RUN_KIND[run.kind]}</> : null}
          {' '}
          <StatusBadge tone={tone.tone}>{tone.label}</StatusBadge>
          {run.held ? <>{' '}<StatusBadge tone="warning">On hold</StatusBadge></> : null}
        </p>
        {children}
      </div>
    </li>
  )
}
