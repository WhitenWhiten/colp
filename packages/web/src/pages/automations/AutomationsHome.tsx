import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AutomationHealthIncident, AutomationPauseState, AutomationRule } from '../../api/automationTypes'
import { useToast } from '../../components/AppToast'
import { EmptyState } from '../../components/EmptyState'
import { FilterRail } from '../../components/FilterRail'
import { Icon, type IconName } from '../../components/Icon'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { classifyRouteError } from '../../lib/classifyRouteError'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import { isAutomationUnavailableError, publishAutomationPause, publishAutomationUnavailable } from '../../lib/automationStatus'
import { decisionGroups, NeedsAttention } from './NeedsAttention'
import { ruleEditPath, rulePath, runPath } from './paths'
import { RecentActivity } from './RecentActivity'
import { RuleSentence } from './RuleSentence'
import { errorMessage, isStale, RuleStateBadge, useAutomationDeps, useLoad } from './shared'
import { useAutomationNames, type AutomationNames } from './useAutomationNames'

/* The promises rules keep, shown where they matter: before the first rule. */
const HOW_IT_WORKS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    icon: 'check',
    title: 'Your choice wins',
    body: 'Rules only file bookmarks saved without a folder. A folder you pick while saving is never overridden.',
  },
  {
    icon: 'eye',
    title: 'Preview first',
    body: 'A rule runs only after you preview it on your recent bookmarks and turn it on.',
  },
  {
    icon: 'refresh',
    title: 'Undo one thing',
    body: 'Each bookmark shows what a rule did to it, with Undo when that is safe.',
  },
  {
    icon: 'lock',
    title: 'One switch stops everything',
    body: 'Pause all stops every rule at once. Browsers follow within about five minutes.',
  },
]

type RuleFilter = 'all' | 'on' | 'off'

const RULE_FILTERS: ReadonlyArray<{ value: RuleFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

function ruleIsOn(rule: AutomationRule): boolean {
  return rule.effectiveState === 'active' || rule.effectiveState === 'degraded'
}

/** "2 rules on · 1 blocked · 1 draft": the server's states, counted. */
function ruleTally(rules: readonly AutomationRule[]): string {
  const count = (state: AutomationRule['effectiveState']) => rules.filter((rule) => rule.effectiveState === state).length
  const on = rules.filter(ruleIsOn).length
  const parts = [
    on > 0 ? `${plural(on, 'rule')} on` : 'No rule is on yet',
    count('blocked') > 0 ? `${count('blocked')} blocked` : null,
    count('paused') > 0 ? `${count('paused')} paused` : null,
    count('draft') > 0 ? plural(count('draft'), 'draft') : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

function pausedLine(pause: AutomationPauseState): string {
  const when = pause.pausedAt ? ` on ${formatDate(pause.pausedAt)}` : ''
  const who = pause.pausedBy === 'restore'
    ? `Paused after a restore${when}.`
    : pause.pausedBy === 'capacity'
      ? `Paused because the server was busy${when}.`
      : `Paused by you${when}.`
  const held = pause.heldJobs > 0 ? ` ${plural(pause.heldJobs, 'job')} on hold.` : ''
  return `${who}${held} New bookmarks are saved as usual, and no rule moves them until you resume. Bookmarks saved while paused are not processed later.`
}

function downloadJson(value: unknown, filename: string) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function RuleRow({
  rule,
  names,
  busy,
  onPause,
}: {
  rule: AutomationRule
  names: AutomationNames
  busy: boolean
  onPause: (rule: AutomationRule) => void
}) {
  const folder = names.ruleFolder(rule)
  const collection = names.collectionTitle(rule.definition.scope.collectionId)
  const editHref = ruleEditPath(rule.id)
  const canPause = rule.desiredState === 'enabled'
  return (
    <article className="automation-rule" data-rule-id={rule.id} data-state={rule.effectiveState} aria-labelledby={`automation-rule-${rule.id}`}>
      <div className="automation-rule-main">
        <h3 className="automation-rule-name" id={`automation-rule-${rule.id}`}>
          <Link to={rulePath(rule.id)}>{rule.definition.name}</Link>
        </h3>
        <RuleSentence
          rule={rule}
          collectionTitle={collection ?? null}
          folder={folder}
          className="automation-rule-sentence"
        />
        <p className="automation-meta">
          {/* No runs in the server's period (which starts at a UTC day, before a rule made today) says nothing about runs. */}
          {rule.usage && rule.usage.admittedRuns > 0
            ? <>{plural(rule.usage.admittedRuns, 'run')} since {formatDate(rule.usage.periodStart)}</>
            : <>Updated <time dateTime={rule.updatedAt} title={formatDateTime(rule.updatedAt)}>{formatDate(rule.updatedAt)}</time></>}
          {rule.definition.priority !== 100 ? <> · Priority {rule.definition.priority}</> : null}
        </p>
      </div>
      <div className="automation-rule-state">
        <RuleStateBadge state={rule.effectiveState} />
      </div>
      <div className="automation-rule-actions">
        {canPause ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onPause(rule)}>
            Pause
          </button>
        ) : rule.desiredState !== 'archived' ? (
          <Link className="btn btn-ghost btn-sm" to={`${editHref}#preview`}>Preview and turn on</Link>
        ) : null}
        <Link className="btn btn-secondary btn-sm" to={editHref}>Edit</Link>
      </div>
    </article>
  )
}

/** The whole account's switch, with what it means right now. */
function StatusBar({
  pause,
  rules,
  busy,
  onToggle,
}: {
  pause: AutomationPauseState | null
  rules: readonly AutomationRule[] | null
  busy: boolean
  onToggle: () => void
}) {
  const paused = pause?.paused ?? false
  return (
    <section
      className="automations-status"
      data-state={pause ? (paused ? 'paused' : 'running') : 'loading'}
      aria-labelledby="automations-status-title"
    >
      <span className="automations-status-mark" aria-hidden><Icon name={paused ? 'lock' : 'bolt'} /></span>
      <div className="automations-status-copy">
        <h2 className="automations-status-title" id="automations-status-title">
          {!pause ? 'Checking automations…' : paused ? 'All automations are paused' : 'Automations are on'}
        </h2>
        {pause && paused && (
          <p className="automations-status-text" role="status" data-testid="automations-paused">{pausedLine(pause)}</p>
        )}
        {pause && !paused && rules && (
          <p className="automations-status-text">
            {rules.length === 0 ? 'Make a rule to start filing bookmarks as you save them.' : `${ruleTally(rules)}.`}
          </p>
        )}
      </div>
      <button
        type="button"
        className={paused ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
        data-testid="automations-pause-all"
        disabled={!pause || busy}
        aria-pressed={paused}
        onClick={onToggle}
      >
        {paused ? 'Resume all' : 'Pause all'}
      </button>
    </section>
  )
}

/** First visit: the two ways to make a rule, and the promises every rule keeps. */
function FirstRule() {
  return (
    <div className="automations-onboarding">
      <EmptyState
        icon="bolt"
        className="automations-empty"
        data-testid="automations-empty"
        title="No rules yet"
        description="A rule files bookmarks for you, such as “pages from arxiv.org go to Academic”. Start here, or choose Automate… on a folder in your library."
        action={(
          <>
            <Link className="btn btn-primary btn-sm" to="/automations/new">New rule</Link>
            <Link className="btn btn-secondary btn-sm" to="/library">Open library</Link>
          </>
        )}
      />
      <ul className="automations-promises" aria-label="How rules work">
        {HOW_IT_WORKS.map((item) => (
          <li key={item.title}>
            <span className="automations-promise-icon" aria-hidden><Icon name={item.icon} /></span>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AutomationsHome() {
  const { api } = useAutomationDeps()
  const { success, error: toastError } = useToast()
  const pause = useLoad('pause', async (signal) => {
    try {
      const state = await api.getPause(signal)
      publishAutomationPause(state)
      return state
    } catch (error) {
      if (isAutomationUnavailableError(error)) publishAutomationUnavailable()
      throw error
    }
  })
  const rules = useLoad('rules', (signal) => api.listRules(null, signal))
  const incidents = useLoad('incidents', (signal) => api.listIncidents(null, signal))
  const runs = useLoad('runs', (signal) => api.listRuns({}, signal))
  const [moreRules, setMoreRules] = useState<{ items: AutomationRule[]; cursor: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [filter, setFilter] = useState<RuleFilter>('all')

  const ruleList = rules.state.status === 'ready' ? [...rules.state.data.items, ...(moreRules?.items ?? [])] : null
  const visibleRules = ruleList?.filter((rule) => rule.desiredState !== 'archived') ?? null
  const nextCursor = moreRules ? moreRules.cursor : rules.state.status === 'ready' ? rules.state.data.nextCursor : null
  const names = useAutomationNames(ruleList)
  const ruleName = (id: string) => names.ruleName(id)

  if (pause.state.status === 'error') {
    const kind = classifyRouteError(pause.state.error)
    return (
      <PageShell data-testid="automations-page">
        <RouteState
          kind={kind}
          icon="compass"
          titleAs="h1"
          title={kind === 'unavailable' ? 'Automations are not available yet' : kind === 'auth' ? 'Sign in to manage automations' : undefined}
          feature="Automations"
          onRetry={pause.reload}
        />
      </PageShell>
    )
  }

  const pauseState = pause.state.status === 'ready' ? pause.state.data : null

  async function togglePauseAll() {
    if (!pauseState || pausing) return
    setPausing(true)
    try {
      const next = await api.setPause(!pauseState.paused, pauseState.revision)
      pause.replace(next)
      publishAutomationPause(next)
      rules.reload()
      success(next.paused
        ? 'All automations are paused.'
        : 'Automations resumed. Bookmarks saved while paused were not processed.')
    } catch (error) {
      if (isStale(error)) pause.reload()
      toastError(errorMessage(error, pauseState.paused ? 'Could not resume automations.' : 'Could not pause automations.'))
    } finally {
      setPausing(false)
    }
  }

  async function pauseRule(rule: AutomationRule) {
    setBusyId(rule.id)
    try {
      await api.setRuleLifecycle(rule.id, { state: 'paused', pendingRuns: 'hold', reason: 'Owner paused the rule.' }, rule.revision)
      rules.reload()
      setMoreRules(null)
      success(`Paused “${rule.definition.name}”. To turn it back on, preview it again.`)
    } catch (error) {
      if (isStale(error)) rules.reload()
      toastError(errorMessage(error, `Could not pause “${rule.definition.name}”.`))
    } finally {
      setBusyId(null)
    }
  }

  async function acknowledge(incident: AutomationHealthIncident) {
    setBusyId(incident.id)
    try {
      await api.acknowledgeIncident(incident.id)
      incidents.reload()
    } catch (error) {
      toastError(errorMessage(error, 'Could not dismiss the notice.'))
    } finally {
      setBusyId(null)
    }
  }

  async function revalidate(incident: AutomationHealthIncident) {
    setBusyId(incident.id)
    let rule = ruleList?.find((item) => item.id === incident.ruleId)
    try {
      // A notice can be about a rule past the first page of the list.
      rule ??= await api.getRule(incident.ruleId)
      const report = await api.revalidateRule(rule.id, rule.revision)
      incidents.reload()
      rules.reload()
      const open = report.incidents.filter((item) => item.state === 'open').length
      success(open === 0 ? `“${rule.definition.name}” checks out now.` : `“${rule.definition.name}” still needs attention.`)
    } catch (error) {
      if (isStale(error)) rules.reload()
      toastError(errorMessage(error, 'Could not check the rule again.'))
    } finally {
      setBusyId(null)
    }
  }

  async function loadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const page = await api.listRules(nextCursor)
      setMoreRules((current) => ({ items: [...(current?.items ?? []), ...page.items], cursor: page.nextCursor }))
    } catch (error) {
      toastError(errorMessage(error, 'Could not load more rules.'))
    } finally {
      setLoadingMore(false)
    }
  }

  async function exportRules() {
    setExporting(true)
    try {
      downloadJson(await api.exportAutomations(), 'automations-export.json')
    } catch (error) {
      toastError(errorMessage(error, 'Could not export your rules.'))
    } finally {
      setExporting(false)
    }
  }

  const openIncidents = incidents.state.status === 'ready'
    ? incidents.state.data.items.filter((item) => item.state === 'open')
    : []
  const decisions = runs.state.status === 'ready' ? decisionGroups(runs.state.data.items) : []

  const filtered = visibleRules?.filter((rule) => filter === 'all' || (filter === 'on') === ruleIsOn(rule)) ?? null
  const onCount = visibleRules?.filter(ruleIsOn).length ?? 0
  const filterCounts: Record<RuleFilter, number> = {
    all: visibleRules?.length ?? 0,
    on: onCount,
    off: (visibleRules?.length ?? 0) - onCount,
  }
  const firstVisit = visibleRules !== null && visibleRules.length === 0 && !nextCursor

  return (
    <PageShell data-testid="automations-page">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        title="Automations"
        documentTitle="Automations"
        lede="Rules file the bookmarks you save into the right folder. Nothing runs until you preview a rule and turn it on."
        actions={(
          <Link className="btn btn-primary" to="/automations/new">
            <Icon name="plus" />
            New rule
          </Link>
        )}
      />

      <StatusBar pause={pauseState} rules={visibleRules} busy={pausing} onToggle={() => void togglePauseAll()} />

      {firstVisit ? <FirstRule /> : (
        <div className="automations-layout">
          <div className="automations-main">
            <NeedsAttention
              incidents={openIncidents}
              decisions={decisions}
              ruleName={ruleName}
              busyId={busyId}
              runHref={runPath}
              onAcknowledge={(incident) => void acknowledge(incident)}
              onRevalidate={(incident) => void revalidate(incident)}
            />

            <section className="automations-section" aria-labelledby="automations-rules-heading">
              <div className="automations-section-head">
                <h2 id="automations-rules-heading">Rules</h2>
                {visibleRules && visibleRules.length > 0 && (
                  <>
                    <FilterRail<RuleFilter>
                      variant="segments"
                      className="view-switch"
                      label="Show rules"
                      value={filter}
                      options={RULE_FILTERS.map((option) => ({
                        value: option.value,
                        label: <>{option.label} <span className="automations-filter-count">{filterCounts[option.value]}</span></>,
                      }))}
                      onChange={setFilter}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm automations-section-action"
                      disabled={exporting}
                      onClick={() => void exportRules()}
                    >
                      <Icon name="download" />
                      Export
                    </button>
                  </>
                )}
              </div>
              {rules.state.status === 'loading' && <RouteState kind="loading" loadingLabel="Loading rules…" />}
              {rules.state.status === 'error' && (
                <RouteState
                  kind={classifyRouteError(rules.state.error)}
                  icon="alert"
                  title="Couldn't load your rules"
                  description={errorMessage(rules.state.error, 'Check your connection and try again.')}
                  onRetry={rules.reload}
                />
              )}
              {filtered && filtered.length > 0 && (
                <ul className="automation-rules">
                  {filtered.map((rule) => (
                    <li key={rule.id}>
                      <RuleRow rule={rule} names={names} busy={busyId === rule.id} onPause={(item) => void pauseRule(item)} />
                    </li>
                  ))}
                </ul>
              )}
              {filtered && filtered.length === 0 && visibleRules && visibleRules.length > 0 && (
                <p className="automation-empty-line">
                  {filter === 'on' ? 'No rule is on. Preview a rule and turn it on to start filing.' : 'Every rule is on.'}
                </p>
              )}
              {nextCursor && (
                <LoadMoreButton loading={loadingMore} onClick={() => void loadMore()}>Load more rules</LoadMoreButton>
              )}
            </section>
          </div>

          <aside className="automations-aside" aria-label="Recent activity">
            <RecentActivity runs={runs.state} ruleName={ruleName} onRetry={runs.reload} />
          </aside>
        </div>
      )}
    </PageShell>
  )
}
