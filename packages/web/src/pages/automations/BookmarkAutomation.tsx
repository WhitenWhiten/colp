import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AutomationEffectReceipt, AutomationRun } from '../../api/automationTypes'
import { useToast } from '../../components/AppToast'
import { Icon } from '../../components/Icon'
import { StatusBadge } from '../../components/StatusBadge'
import { formatDateTime, formatRelative } from '../../lib/formatDate'
import { isAutomationUnavailableError } from '../../lib/automationStatus'
import { RUN_KIND, RUN_STATUS, runExplanation, undoReason } from './copy'
import { errorMessage, isStale, useAutomationDeps, useLoad } from './shared'

/* AU-13: what automation did to this bookmark, newest first, with Undo for
   the one effect the backend says can be undone safely. Availability and
   its reason come from the effect receipt; this section never infers Undo
   from what is on screen. Hidden where the server has no automations. */

const EFFECT_LABEL: Record<AutomationEffectReceipt['kind'], string> = {
  placement: 'Moved by the rule',
  plan: 'Agent change',
}

const EFFECT_STATUS: Record<AutomationEffectReceipt['status'], string | null> = {
  committed: null,
  reverted: 'Undone',
  unavailable: 'No longer available',
}

function EffectRow({
  effect,
  busy,
  onUndo,
}: {
  effect: AutomationEffectReceipt
  busy: boolean
  onUndo: () => void
}) {
  const status = EFFECT_STATUS[effect.status]
  return (
    <li className="automation-effect" data-effect-id={effect.id} data-status={effect.status}>
      <div className="automation-effect-body">
        <p className="automation-effect-title" data-testid="automation-effect-title">
          {EFFECT_LABEL[effect.kind]}
          {status && <StatusBadge tone="muted">{status}</StatusBadge>}
        </p>
        {!effect.undoAvailable && effect.status === 'committed' && (
          <p className="automation-effect-note" data-testid="automation-undo-reason">{undoReason(effect.undoReason)}</p>
        )}
      </div>
      {effect.undoAvailable && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy}
          title={undoReason(effect.undoReason)}
          onClick={onUndo}
        >
          Undo
        </button>
      )}
    </li>
  )
}

export function BookmarkAutomation({ collectionId, nodeId }: { collectionId: string; nodeId: string }) {
  const { api } = useAutomationDeps()
  const { success, error: toastError } = useToast()
  const runs = useLoad(`runs:${collectionId}:${nodeId}`, (signal) => api.listRuns({ collectionId, nodeId }, signal))
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map())
  const [busyId, setBusyId] = useState<string | null>(null)

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

  async function undo(run: AutomationRun, effect: AutomationEffectReceipt) {
    setBusyId(effect.id)
    try {
      await api.undoRunEffect(run.id, {
        reason: 'Owner undid one automation effect from the bookmark page.',
        expectedEffectDigest: effect.effectDigest,
        effectReceiptId: effect.id,
      }, run.revision)
      success(effect.kind === 'placement' ? 'Undone. The bookmark is back in the folder it came from.' : 'Undone.')
    } catch (error) {
      toastError(isStale(error)
        ? 'Nothing was changed: the bookmark changed since this was done.'
        : errorMessage(error, 'Could not undo this.'))
    } finally {
      setBusyId(null)
      runs.reload()
    }
  }

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
          {items.map((run) => {
            const tone = RUN_STATUS[run.status]
            const name = ruleNames.get(run.ruleId)
            return (
              <li key={run.id} className="automation-history-item" data-run-id={run.id}>
                <span className="automation-history-icon" aria-hidden><Icon name="bolt" /></span>
                <div className="automation-history-body">
                  <p className="automation-history-title">
                    {runExplanation(run.explanation) ?? RUN_KIND[run.kind]}
                  </p>
                  <p className="automation-meta">
                    {name ? <>Rule “{name}”</> : 'A rule'}
                    {' · '}
                    <time dateTime={run.createdAt} title={formatDateTime(run.createdAt)}>{formatRelative(run.createdAt)}</time>
                    {run.kind !== 'intake' ? <> · {RUN_KIND[run.kind]}</> : null}
                    {' '}
                    <StatusBadge tone={tone.tone}>{tone.label}</StatusBadge>
                  </p>
                  {run.effects.length > 0 && (
                    <ul className="automation-effects">
                      {run.effects.map((effect) => (
                        <EffectRow
                          key={effect.id}
                          effect={effect}
                          busy={busyId !== null}
                          onUndo={() => void undo(run, effect)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
