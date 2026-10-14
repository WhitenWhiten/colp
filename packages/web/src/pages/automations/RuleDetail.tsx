import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { AutomationDependency, AutomationHealthIncident, AutomationRule, AutomationRun } from '../../api/automationTypes'
import { useToast } from '../../components/AppToast'
import { Breadcrumb } from '../../components/Breadcrumb'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { classifyRouteError } from '../../lib/classifyRouteError'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { DEPENDENCY_STATUS, dependencyLabel, RULE_STATE_DETAIL } from './copy'
import { NeedsAttention } from './NeedsAttention'
import { ruleEditPath, runOncePath } from './paths'
import { RunItem } from './RunItem'
import { RuleSentence } from './RuleSentence'
import { errorMessage, isStale, RuleStateBadge, useAutomationDeps, useLoad } from './shared'
import { UsagePanel } from './UsagePanel'
import { useAutomationNames } from './useAutomationNames'

/* One rule (AU-22/AU-23): what it says, what is wrong with it, what it has
   waiting and used, what it relies on, and every run it made. States,
   counts and checks are the server's; this page only lays them out. */

const RUN_PAGE = 100
/** Runs are listed account-wide; one look reads at most this many pages for this rule's runs. */
const PAGES_PER_LOOK = 5
const RUNS_PER_LOOK = 20

type RuleRuns = {
  runs: AutomationRun[]
  cursor: string | null
  status: 'loading' | 'ready' | 'error'
  error?: unknown
}

/** This rule's runs, newest first, read from the account's run list (it has no rule filter yet). */
function useRuleRuns(ruleId: string) {
  const { api } = useAutomationDeps()
  const [state, setState] = useState<RuleRuns>({ runs: [], cursor: null, status: 'loading' })
  const generation = useRef(0)

  const look = useCallback(async (from: string | null, keep: AutomationRun[], signal?: AbortSignal) => {
    const mine = generation.current
    setState((current) => ({ ...current, status: 'loading' }))
    try {
      const found: AutomationRun[] = []
      let cursor = from
      for (let page = 0; page < PAGES_PER_LOOK; page += 1) {
        const result = await api.listRuns({ cursor, limit: RUN_PAGE }, signal)
        found.push(...result.items.filter((run) => run.ruleId === ruleId))
        cursor = result.nextCursor
        if (!cursor || found.length >= RUNS_PER_LOOK) break
      }
      if (signal?.aborted || mine !== generation.current) return
      setState({ runs: [...keep, ...found], cursor, status: 'ready' })
    } catch (error) {
      if (signal?.aborted || mine !== generation.current) return
      setState((current) => ({ ...current, status: 'error', error }))
    }
  }, [api, ruleId])

  useEffect(() => {
    generation.current += 1
    const controller = new AbortController()
    void look(null, [], controller.signal)
    return () => controller.abort()
  }, [look])

  return {
    state,
    more: () => void look(state.cursor, state.runs),
    retry: () => void look(state.cursor, state.runs),
  }
}

type DependencyGroup = { key: string; kind: AutomationDependency['kind']; role: string; items: AutomationDependency[] }

function dependencyGroups(items: readonly AutomationDependency[]): DependencyGroup[] {
  const groups = new Map<string, DependencyGroup>()
  for (const item of items) {
    const key = `${item.kind}:${item.role}`
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { key, kind: item.kind, role: item.role, items: [item] })
  }
  return [...groups.values()]
}

function groupStatus(group: DependencyGroup): AutomationDependency['status'] {
  if (group.items.some((item) => item.status === 'blocked')) return 'blocked'
  if (group.items.some((item) => item.status === 'warning')) return 'warning'
  return 'valid'
}

export function RuleDetail() {
  const { ruleId = '' } = useParams<{ ruleId: string }>()
  const { api } = useAutomationDeps()
  const { success, error: toastError } = useToast()
  const rule = useLoad(`rule:${ruleId}`, (signal) => api.getRule(ruleId, signal))
  const health = useLoad(`health:${ruleId}`, (signal) => api.getRuleHealth(ruleId, signal))
  const dependencies = useLoad(`dependencies:${ruleId}`, (signal) => api.getRuleDependencies(ruleId, signal))
  const history = useRuleRuns(ruleId)
  const [busy, setBusy] = useState<string | null>(null)
  const current = rule.state.status === 'ready' ? rule.state.data : null
  const names = useAutomationNames(current ? [current] : null)

  if (rule.state.status === 'error') {
    const kind = classifyRouteError(rule.state.error)
    return (
      <PageShell>
        <RouteState
          kind={kind}
          icon="compass"
          titleAs="h1"
          title={kind === 'unavailable' ? 'This rule is not available' : undefined}
          description={kind === 'unavailable' ? 'It may belong to another account, or automations are off on this server.' : undefined}
          feature="Automations"
          onRetry={rule.reload}
        />
      </PageShell>
    )
  }
  if (!current) {
    return <PageShell><RouteState kind="loading" loadingLabel="Loading rule…" /></PageShell>
  }

  const shown: AutomationRule = current
  const editHref = ruleEditPath(shown.id)
  const folder = names.ruleFolder(shown)
  const destinationNode = folder?.id
  const collection = names.collectionTitle(shown.definition.scope.collectionId)
  const openIncidents = health.state.status === 'ready'
    ? health.state.data.incidents.filter((incident) => incident.state === 'open')
    : []

  async function pause() {
    setBusy('pause')
    try {
      rule.replace(await api.setRuleLifecycle(shown.id, { state: 'paused', pendingRuns: 'hold', reason: 'Owner paused the rule.' }, shown.revision))
      success(`Paused “${shown.definition.name}”. To turn it back on, preview it again.`)
    } catch (error) {
      if (isStale(error)) rule.reload()
      toastError(errorMessage(error, `Could not pause “${shown.definition.name}”.`))
    } finally {
      setBusy(null)
    }
  }

  async function acknowledge(incident: AutomationHealthIncident) {
    setBusy(incident.id)
    try {
      await api.acknowledgeIncident(incident.id)
      health.reload()
    } catch (error) {
      toastError(errorMessage(error, 'Could not dismiss the notice.'))
    } finally {
      setBusy(null)
    }
  }

  async function revalidate(incident: AutomationHealthIncident) {
    setBusy(incident.id)
    try {
      const report = await api.revalidateRule(shown.id, shown.revision)
      health.replace(report)
      rule.reload()
      dependencies.reload()
      const open = report.incidents.filter((item) => item.state === 'open').length
      success(open === 0 ? `“${shown.definition.name}” checks out now.` : `“${shown.definition.name}” still needs attention.`)
    } catch (error) {
      if (isStale(error)) rule.reload()
      toastError(errorMessage(error, 'Could not check the rule again.'))
    } finally {
      setBusy(null)
    }
  }

  const runs = history.state.runs
  return (
    <PageShell data-testid="automation-rule">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={<Breadcrumb items={[{ label: 'Automations', to: '/automations' }, { label: shown.definition.name }]} />}
        title={shown.definition.name}
        documentTitle={shown.definition.name}
        afterTitle={(
          <span className="automation-head-state">
            <RuleStateBadge state={shown.effectiveState} />
            <span>{RULE_STATE_DETAIL[shown.effectiveState]}</span>
          </span>
        )}
        actions={(
          <>
            {shown.desiredState !== 'archived' && (
              <Link className="btn btn-secondary" to={runOncePath(shown.id)} data-testid="automation-run-once-link">Run once</Link>
            )}
            {shown.desiredState === 'enabled' ? (
              <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void pause()}>
                Pause
              </button>
            ) : shown.desiredState !== 'archived' ? (
              <Link className="btn btn-secondary" to={`${editHref}#preview`}>Preview and turn on</Link>
            ) : null}
            {shown.desiredState !== 'archived' && <Link className="btn btn-primary" to={editHref}>Edit</Link>}
          </>
        )}
      >
        <RuleSentence
          rule={shown}
          collectionTitle={collection ?? null}
          folder={folder}
          className="automation-head-sentence"
        />
      </PageHead>

      <div className="automations-layout">
        <div className="automations-main">
          <NeedsAttention
            incidents={openIncidents}
            decisions={[]}
            ruleName={() => undefined}
            busyId={busy}
            onAcknowledge={(incident) => void acknowledge(incident)}
            onRevalidate={(incident) => void revalidate(incident)}
          />

          <section className="automations-section" aria-labelledby="automation-rule-runs">
            <div className="automations-section-head">
              <h2 id="automation-rule-runs">Runs</h2>
              {runs.length > 0 && <span className="automations-count">{runs.length}{history.state.cursor ? '+' : ''}</span>}
            </div>
            {history.state.status === 'loading' && runs.length === 0 && <RouteState kind="loading" loadingLabel="Loading runs…" />}
            {history.state.status === 'error' && (
              <div className="automation-inline-error" role="alert">
                <p>{errorMessage(history.state.error, 'Could not load this rule’s runs.')}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={history.retry}>Try again</button>
              </div>
            )}
            {history.state.status === 'ready' && runs.length === 0 && (
              <p className="automation-panel-text automation-empty-line" data-testid="automation-rule-no-runs">
                {history.state.cursor
                  ? 'No runs among your recent automation activity.'
                  : shown.desiredState === 'enabled'
                    ? 'No runs yet. That is fine: the rule runs when you save a bookmark it matches.'
                    : 'No runs yet.'}
              </p>
            )}
            {runs.length > 0 && (
              <ol className="automation-history-list automation-history-list--boxed">
                {runs.map((run) => <RunItem key={run.id} run={run} />)}
              </ol>
            )}
            {history.state.cursor && history.state.status !== 'error' && (
              <LoadMoreButton loading={history.state.status === 'loading'} onClick={history.more}>
                Look further back
              </LoadMoreButton>
            )}
          </section>
        </div>

        <div className="automation-side">
          <section className="automation-panel" aria-labelledby="automation-rule-about">
            <h2 id="automation-rule-about" className="automation-panel-title">About this rule</h2>
            <dl className="automation-facts">
              <div><dt>Created</dt><dd><time dateTime={shown.createdAt} title={formatDateTime(shown.createdAt)}>{formatDate(shown.createdAt)}</time></dd></div>
              <div><dt>Last changed</dt><dd><time dateTime={shown.updatedAt} title={formatDateTime(shown.updatedAt)}>{formatDate(shown.updatedAt)}</time></dd></div>
              <div><dt>Priority</dt><dd>{shown.definition.priority}</dd></div>
              <div><dt>Most runs a day</dt><dd>{shown.definition.policy.maxRunsPerDay}</dd></div>
            </dl>
            <h3 id="automation-rule-checks" className="automation-panel-subtitle">What it relies on</h3>
            {dependencies.state.status === 'loading' && <p className="automation-meta" role="status">Checking…</p>}
            {dependencies.state.status === 'error' && (
              <div className="automation-inline-error" role="alert">
                <p>{errorMessage(dependencies.state.error, 'Could not check what this rule relies on.')}</p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={dependencies.reload}>Try again</button>
              </div>
            )}
            {dependencies.state.status === 'ready' && (
              <ul className="automation-checks" aria-labelledby="automation-rule-checks">
                {dependencyGroups(dependencies.state.data.dependencies).map((group) => {
                  const status = DEPENDENCY_STATUS[groupStatus(group)]
                  const named = group.kind === 'folder' && folder && group.items.some((item) => item.resourceId === destinationNode)
                  return (
                    <li key={group.key} data-kind={group.kind} data-status={groupStatus(group)}>
                      <span className="automation-dot" data-tone={status.tone} aria-hidden />
                      <span className="automation-check-label">
                        {dependencyLabel(group.kind)}
                        {named ? <span className="automation-check-detail">{folder.path}</span> : null}
                        {group.items.length > 1 ? <span className="automation-check-detail">{group.items.length} checked</span> : null}
                      </span>
                      <span className="automation-check-status" data-tone={status.tone}>{status.label}</span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          <UsagePanel usage={shown.usage} title="Work and allowance" headingId="automation-rule-usage" scope="rule" />
        </div>
      </div>
    </PageShell>
  )
}
