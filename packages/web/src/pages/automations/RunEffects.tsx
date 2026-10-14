import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { AutomationEffectReceipt, AutomationRun } from '../../api/automationTypes'
import { useToast } from '../../components/AppToast'
import { StatusBadge } from '../../components/StatusBadge'
import { undoReason } from './copy'
import { errorMessage, isStale, useAutomationDeps } from './shared'

/* One row per recorded effect, with Undo only where the effect receipt
   says it is available, and its reason where it is not. Undo names that
   one effect, its digest and the run revision; the server decides. */

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
        {effect.kind === 'plan' && effect.planId && (
          <p className="automation-effect-note">
            <Link to={`/approvals/${encodeURIComponent(effect.planId)}`}>See the approved change</Link>
          </p>
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

export function RunEffects({
  run,
  from,
  onSettled,
}: {
  run: AutomationRun
  /** Where the owner pressed Undo, for the audit reason. */
  from: 'bookmark' | 'run'
  /** After any attempt: the run the server returned, or null when it refused. */
  onSettled: (next: AutomationRun | null) => void
}) {
  const { api } = useAutomationDeps()
  const { success, error: toastError } = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function undo(effect: AutomationEffectReceipt) {
    setBusyId(effect.id)
    let next: AutomationRun | null = null
    try {
      next = await api.undoRunEffect(run.id, {
        reason: `Owner undid one automation effect from the ${from} page.`,
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
      onSettled(next)
    }
  }

  if (run.effects.length === 0) return null
  return (
    <ul className="automation-effects">
      {run.effects.map((effect) => (
        <EffectRow key={effect.id} effect={effect} busy={busyId !== null} onUndo={() => void undo(effect)} />
      ))}
    </ul>
  )
}
