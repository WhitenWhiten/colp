import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { isAutomationUnavailableError } from '../../lib/automationStatus'
import { RunEffects } from './RunEffects'
import { RunItem } from './RunItem'
import { errorMessage, useAutomationDeps, useLoad } from './shared'

/* AU-13: what automation did to this bookmark, newest first, with Undo for
   the one effect the backend says can be undone safely. Availability and
   its reason come from the effect receipt; this section never infers Undo
   from what is on screen. Hidden where the server has no automations. */

export function BookmarkAutomation({ collectionId, nodeId }: { collectionId: string; nodeId: string }) {
  const { api } = useAutomationDeps()
  const runs = useLoad(`runs:${collectionId}:${nodeId}`, (signal) => api.listRuns({ collectionId, nodeId }, signal))
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map())

  const items = runs.state.status === 'ready' ? runs.state.data.items : []
  const ruleIds = [...new Set(items.map((run) => run.ruleId))].sort().join(',')
  useEffect(() => {
    if (!ruleIds) return
    const controller = new AbortController()
    void Promise.all(ruleIds.split(',').map(async (id) => {
      try {
        return [id, (await api.getRule(id, controller.signal)).definition.name] as const
      } catch {
        return null
      }
    })).then((pairs) => {
      if (!controller.signal.aborted) setRuleNames(new Map(pairs.filter((pair) => pair !== null)))
    })
    return () => controller.abort()
  }, [api, ruleIds])

  if (runs.state.status === 'error' && isAutomationUnavailableError(runs.state.error)) return null

  const status = runs.state.status === 'loading'
    ? 'Loading'
    : runs.state.status === 'error'
      ? errorMessage(runs.state.error, 'Could not load what automation did.')
      : items.length === 0 ? 'Nothing yet' : null

  return (
    <section className="resource-section" aria-labelledby="resource-automation-heading" data-testid="bookmark-automation">
      <div className="section-head section-head--split resource-section-head">
        <h2 id="resource-automation-heading">Automation</h2>
        {status && (
          <p className="resource-section-status" role="status" data-error={runs.state.status === 'error' ? 'true' : undefined}>{status}</p>
        )}
      </div>
      {runs.state.status === 'ready' && items.length === 0 && (
        <p className="automation-meta">
          No rule has acted on this bookmark. <Link to="/automations">See your rules</Link>
        </p>
      )}
      {runs.state.status === 'error' && (
        <button type="button" className="btn btn-secondary btn-sm automation-history-retry" onClick={runs.reload}>Try again</button>
      )}
      {items.length > 0 && (
        <ol className="automation-history-list">
          {items.map((run) => (
            <RunItem key={run.id} run={run} ruleName={ruleNames.get(run.ruleId) ?? null}>
              <RunEffects run={run} from="bookmark" onSettled={() => runs.reload()} />
            </RunItem>
          ))}
        </ol>
      )}
    </section>
  )
}
