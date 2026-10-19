import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AutomationRun, AutomationRunOutput } from '../../api/automationTypes'
import { Breadcrumb } from '../../components/Breadcrumb'
import { EmptyState } from '../../components/EmptyState'
import { FilterRail } from '../../components/FilterRail'
import { LoadMoreButton } from '../../components/LoadMoreButton'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge } from '../../components/StatusBadge'
import { classifyRouteError } from '../../lib/classifyRouteError'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { RUN_KIND } from './copy'
import { runPath } from './paths'
import { errorMessage, useAutomationDeps } from './shared'

/* AU-24: every run that wrote something, newest first, with the server's
   unread state and the opening of its first digest. The list never counts
   or groups bookmarks itself; a run's text and read state are the server's. */

const RUN_PAGE = 100
const PAGES_PER_LOOK = 5
const SNIPPETS = 10

type DigestFilter = 'all' | 'unread'

const TEXT_TYPE: Record<AutomationRunOutput['output']['textType'], string> = {
  digest: 'Digest',
  review: 'Review',
  summary: 'Summary',
}

type Listing = { runs: AutomationRun[]; cursor: string | null; status: 'loading' | 'ready' | 'error'; error?: unknown }

/** Runs with output, read from the account's run list (it has no output filter). */
function useWritingRuns() {
  const { api } = useAutomationDeps()
  const [state, setState] = useState<Listing>({ runs: [], cursor: null, status: 'loading' })
  const generation = useRef(0)

  const look = useCallback(async (from: string | null, keep: AutomationRun[], signal?: AbortSignal) => {
    const mine = generation.current
    setState((current) => ({ ...current, status: 'loading' }))
    try {
      const found: AutomationRun[] = []
      let cursor = from
      for (let page = 0; page < PAGES_PER_LOOK; page += 1) {
        const result = await api.listRuns({ cursor, limit: RUN_PAGE }, signal)
        found.push(...result.items.filter((run) => run.outputCount > 0))
        cursor = result.nextCursor
        if (!cursor || found.length >= 20) break
      }
      if (signal?.aborted || mine !== generation.current) return
      setState({ runs: [...keep, ...found], cursor, status: 'ready' })
    } catch (error) {
      if (signal?.aborted || mine !== generation.current) return
      setState((current) => ({ ...current, status: 'error', error }))
    }
  }, [api])

  useEffect(() => {
    generation.current += 1
    const controller = new AbortController()
    void look(null, [], controller.signal)
    return () => controller.abort()
  }, [look])

  return { state, more: () => void look(state.cursor, state.runs) }
}

/** The opening lines of the first few runs: their first digest, else their first text. */
function useSnippets(runs: readonly AutomationRun[]) {
  const { api } = useAutomationDeps()
  const [snippets, setSnippets] = useState<ReadonlyMap<string, AutomationRunOutput | null>>(new Map())
  const requested = useRef(new Set<string>())
  const ids = runs.slice(0, SNIPPETS).map((run) => run.id).join(',')

  useEffect(() => {
    for (const id of ids ? ids.split(',') : []) {
      if (requested.current.has(id)) continue
      requested.current.add(id)
      api.listRunOutputs(id, { limit: 3 })
        .then((page) => {
          const pick = page.items.find((item) => item.output.textType === 'digest') ?? page.items[0] ?? null
          setSnippets((current) => new Map(current).set(id, pick))
        })
        .catch(() => setSnippets((current) => new Map(current).set(id, null)))
    }
  }, [api, ids])

  return snippets
}

export function Digests() {
  const { api } = useAutomationDeps()
  const { state, more } = useWritingRuns()
  const snippets = useSnippets(state.runs)
  const [ruleNames, setRuleNames] = useState<ReadonlyMap<string, string>>(new Map())
  const [filter, setFilter] = useState<DigestFilter>('all')
  const unread = state.runs.filter((run) => run.unread).length
  const shown = filter === 'unread' ? state.runs.filter((run) => run.unread) : state.runs

  useEffect(() => {
    const controller = new AbortController()
    api.listRules(null, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted) setRuleNames(new Map(page.items.map((rule) => [rule.id, rule.definition.name])))
      })
      .catch(() => { /* names fall back to "A rule" */ })
    return () => controller.abort()
  }, [api])

  if (state.status === 'error' && state.runs.length === 0) {
    const kind = classifyRouteError(state.error)
    return (
      <PageShell>
        <RouteState
          kind={kind}
          icon="compass"
          titleAs="h1"
          title={kind === 'unavailable' ? 'Automations are not available yet' : undefined}
          description={kind === 'error' ? errorMessage(state.error, 'Check your connection and try again.') : undefined}
          feature="Automations"
          onRetry={more}
        />
      </PageShell>
    )
  }

  return (
    <PageShell data-testid="automation-digests">
      <PageHead
        as="header"
        layout="split"
        variant="workbench"
        breadcrumb={<Breadcrumb items={[{ label: 'Automations', to: '/automations' }, { label: 'Digests' }]} />}
        title="Digests"
        documentTitle="Digests"
        lede="What your rules wrote: digests, reviews and summaries, newest first. Opening one marks it read."
      />

      {state.status === 'loading' && state.runs.length === 0 && <RouteState kind="loading" loadingLabel="Loading digests…" />}
      {state.status === 'ready' && state.runs.length === 0 && (
        <EmptyState
          icon="file"
          title={state.cursor ? 'No digests in your recent automation activity' : 'No digests yet'}
          description="When a rule asks an agent to write a digest or a review, it shows up here to read."
          action={<Link className="btn btn-secondary btn-sm" to="/automations">See your rules</Link>}
        />
      )}

      {state.runs.length > 0 && (
        <div className="automation-digests-head">
          <FilterRail<DigestFilter>
            variant="segments"
            className="view-switch"
            label="Show digests"
            value={filter}
            options={[
              { value: 'all', label: <>All <span className="automations-filter-count">{state.runs.length}</span></> },
              { value: 'unread', label: <>Unread <span className="automations-filter-count">{unread}</span></> },
            ]}
            onChange={setFilter}
          />
        </div>
      )}

      {shown.length > 0 && (
        <ol className="automation-digests">
          {shown.map((run) => {
            const snippet = snippets.get(run.id)
            return (
              <li key={run.id}>
                <article className="automation-digest" data-run-id={run.id} data-unread={run.unread ? 'true' : undefined}>
                  <header className="automation-digest-head">
                    <h2>
                      <Link to={`${runPath(run.id)}#outputs`}>{ruleNames.get(run.ruleId) ?? 'A rule'}</Link>
                    </h2>
                    {run.unread && <StatusBadge tone="accent">New</StatusBadge>}
                    <time className="automation-digest-date" dateTime={run.createdAt} title={formatDateTime(run.createdAt)}>{formatDate(run.createdAt)}</time>
                  </header>
                  {snippet && (
                    <p className="automation-digest-snippet" lang={snippet.output.language}>{snippet.output.text}</p>
                  )}
                  {snippet === null && (
                    <p className="automation-meta">Open it to read.</p>
                  )}
                  <p className="automation-meta">
                    {snippet ? <>{TEXT_TYPE[snippet.output.textType]} · </> : null}
                    {RUN_KIND[run.kind]}
                    {' · '}{run.outputCount === 1 ? '1 text' : `${run.outputCount} texts`}
                  </p>
                </article>
              </li>
            )
          })}
        </ol>
      )}
      {filter === 'unread' && shown.length === 0 && state.runs.length > 0 && (
        <p className="automation-empty-line automation-digests-empty">Nothing new. You have read everything here.</p>
      )}

      {state.status === 'error' && state.runs.length > 0 && (
        <p className="automation-meta" role="alert">{errorMessage(state.error, 'Could not load more.')}</p>
      )}
      {state.cursor && state.runs.length > 0 && (
        <LoadMoreButton loading={state.status === 'loading'} onClick={more}>Look further back</LoadMoreButton>
      )}
      {state.cursor && state.runs.length === 0 && state.status === 'ready' && (
        <LoadMoreButton loading={false} onClick={more}>Look further back</LoadMoreButton>
      )}
    </PageShell>
  )
}
