import { Link } from 'react-router-dom'
import type { AutomationRuleUsage } from '../../api/automationTypes'
import { ProgressBar } from '../../components/ProgressBar'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { plural } from '../../lib/plural'

/* AU-22/AU-23: what a rule (or one run) has waiting, done and used, exactly
   as the server counted it. Job states are distinct counts and are listed,
   never added up; "on hold" overlaps them and says so. The allowance is the
   server's observation, not a promise that the next call will pass. */

type Row = { key: string; label: string; value: number; note?: string; href?: string }

function rows(usage: AutomationRuleUsage): Row[] {
  const all: Row[] = [
    { key: 'pending', label: 'Waiting', value: usage.pendingJobs ?? 0 },
    { key: 'ready', label: 'Ready for an agent', value: usage.readyJobs },
    { key: 'leased', label: 'With an agent', value: usage.leasedJobs ?? 0 },
    { key: 'committing', label: 'Saving', value: usage.committingJobs ?? 0 },
    { key: 'approval', label: 'Needs your approval', value: usage.awaitingApprovalJobs ?? 0, href: '/approvals' },
    { key: 'uncertain', label: 'Outcome unknown', value: usage.uncertainJobs ?? 0 },
    {
      key: 'blocked',
      label: 'Blocked by a limit or policy',
      value: usage.policyBlockedJobs ?? 0,
      note: usage.budgetBlockedJobs ? `${usage.budgetBlockedJobs} over the daily allowance` : undefined,
    },
    { key: 'held', label: 'On hold', value: usage.heldJobs, note: 'also counted above' },
    { key: 'succeeded', label: 'Done', value: usage.succeededJobs },
  ]
  return all.filter((row) => row.value > 0)
}

/** "1234567" micros → "1.234567"; the unit is whatever the agent reported. */
export function formatMicros(micros: string): string | null {
  if (!/^\d{1,30}$/u.test(micros)) return null
  const padded = micros.padStart(7, '0')
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/u, '')
  const fraction = padded.slice(-6).replace(/0+$/u, '')
  return fraction ? `${whole}.${fraction}` : whole
}

function costLine(usage: AutomationRuleUsage): string {
  const calls = usage.optionalCalls ?? 0
  if (usage.externalCosts === 'notApplicable' || calls === 0) return 'No agent calls that could cost money.'
  const reported = usage.reportedCostMicros ? formatMicros(usage.reportedCostMicros) : null
  if (usage.externalCosts === 'unknownDisclosed') {
    const unknown = usage.unknownCostCalls ?? 0
    return `${plural(calls, 'agent call')}, ${unknown} with an unknown cost. Your agent bills these; COLP can’t see the amount.`
  }
  return reported
    ? `${plural(calls, 'agent call')}. Your agent reported ${reported} in total. That is its own report, not a verified bill.`
    : `${plural(calls, 'agent call')}, each with a cost your agent reported. Not a verified bill.`
}

export function UsagePanel({
  usage,
  title,
  headingId,
  scope,
}: {
  usage: AutomationRuleUsage | undefined
  title: string
  headingId: string
  scope: 'rule' | 'run'
}) {
  if (!usage) {
    return (
      <section className="automation-panel" aria-labelledby={headingId} data-testid="automation-usage">
        <h2 id={headingId} className="automation-panel-title">{title}</h2>
        <p className="automation-panel-text">
          {scope === 'rule'
            ? 'This rule only files bookmarks, so there is no agent work or cost to show. Counts appear here once a rule asks an agent to do something.'
            : 'The server kept no counts for this run.'}
        </p>
      </section>
    )
  }

  const work = rows(usage)
  const limit = usage.dailyRunLimit
  const reserved = usage.reservedRuns ?? 0
  const remaining = usage.remainingRuns
  return (
    <section className="automation-panel" aria-labelledby={headingId} data-testid="automation-usage">
      <h2 id={headingId} className="automation-panel-title">{title}</h2>
      <p className="automation-meta">
        <time dateTime={usage.periodStart} title={formatDateTime(usage.periodStart)}>{formatDate(usage.periodStart)}</time>
        {' – '}
        <time dateTime={usage.periodEnd} title={formatDateTime(usage.periodEnd)}>{formatDate(usage.periodEnd)}</time>
        {scope === 'rule' ? <> · {plural(usage.admittedRuns, 'run')}</> : null}
      </p>

      {limit !== undefined && limit > 0 && (
        <div className="automation-allowance" data-testid="automation-allowance">
          <div className="automation-allowance-head">
            <span>Runs with agent work today</span>
            <span className="automation-allowance-count">{reserved} of {limit}</span>
          </div>
          <ProgressBar
            value={(reserved / limit) * 100}
            tone={remaining === 0 ? 'danger' : reserved / limit >= 0.8 ? 'warning' : 'accent'}
            label="Today’s allowance used"
          />
          <p className="automation-meta">
            {remaining === 0
              ? 'None left today. Bookmarks are still filed; agent work over the allowance doesn’t start.'
              : remaining !== undefined ? `${remaining} left today.` : null}
            {usage.budgetDay ? ` The day is ${usage.budgetDay} in UTC.` : null}
            {' '}The server still checks every call.
          </p>
        </div>
      )}

      {work.length > 0 ? (
        <dl className="automation-usage">
          {work.map((row) => (
            <div key={row.key} className="automation-usage-row" data-key={row.key}>
              <dt>
                {row.href ? <Link to={row.href}>{row.label}</Link> : row.label}
                {row.note ? <span className="automation-usage-note">{row.note}</span> : null}
              </dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="automation-panel-text">No agent work {scope === 'rule' ? 'in this period' : 'in this run'}.</p>
      )}

      <p className="automation-panel-text" data-testid="automation-cost">{costLine(usage)}</p>
      {usage.deliveryCapability === 'available' && typeof usage.acceptedDeliveries === 'number' && (
        <p className="automation-meta">{plural(usage.acceptedDeliveries, 'wake-up')} accepted by agents.</p>
      )}
      {usage.deliveryCapability === 'unavailable' && (
        <p className="automation-meta">Agents check for work themselves; instant wake-ups are off on this server.</p>
      )}
    </section>
  )
}
