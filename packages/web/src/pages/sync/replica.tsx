import type { SyncReplicaView } from '../../api'
import { useConfirm } from '../../components/ConfirmModal'
import { DataTableCell } from '../../components/DataTable'
import { INTENT_MESSAGE_CLASS, type RetireDraft } from './types'

const RETIRE_WARNING = 'This browser stops syncing. To sync it again, sign in from the extension. Open conflicts are not resolved automatically.'

export function ReplicaRetireControls({ replica, draft, disabled, onStart, onConfirm, onCancel, onReplay }: {
  replica: SyncReplicaView; draft: RetireDraft; disabled: boolean
  onStart(): void; onConfirm(): void; onCancel(): void; onReplay(): void
}) {
  const confirm = useConfirm()
  /* Retired rows keep an empty actions cell so the table grid stays aligned. */
  if (replica.status === 'retired') return <DataTableCell className="replica-actions" />
  const busy = draft.phase === 'submitting'
  // The first confirm is the shared danger modal; a stale replica (changed
  // under the prompt) asks again inline next to its message.
  const reconfirming = draft.phase === 'stale'
  const message = draft.message
  const messageTone = draft.phase
  const start = async () => {
    onStart()
    const ok = await confirm({ title: `Stop syncing ${replica.name}?`, body: RETIRE_WARNING, confirmLabel: 'Stop syncing' })
    if (ok) onConfirm()
    else onCancel()
  }
  return <>
    <DataTableCell className="replica-actions">
      {draft.phase === 'unknown'
        ? <button type="button" className="btn btn-danger btn-sm" disabled={disabled} onClick={onReplay}>Try again</button>
        : busy ? <button type="button" className="btn btn-danger btn-sm" disabled>Stopping…</button>
          : reconfirming ? <>
            <button type="button" className="btn btn-danger btn-sm" disabled={disabled} onClick={onConfirm}>Stop syncing</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={onCancel}>Cancel</button>
          </>
            : <button type="button" className="btn btn-danger-ghost btn-sm" disabled={disabled || draft.phase === 'confirming'}
              aria-label={`Stop syncing ${replica.name}`} onClick={() => void start()}>Stop syncing</button>}
    </DataTableCell>
    {message && (
      <DataTableCell full>
        <div className={`replica-message ${INTENT_MESSAGE_CLASS[messageTone] ?? ''}`.trim()} role="alert">{message}</div>
      </DataTableCell>
    )}
  </>
}
