import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { isLive } from '../../api'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge } from '../../components/StatusBadge'
import { ConflictEditor, ConflictReceipt } from './conflict'
import type { SyncCenterData } from './data'
import { formatInstant, initialDraft } from './fields'
import { formatRelative } from '../../lib/formatDate'
import { plural } from '../../lib/plural'
import type { SyncCenterMutations } from './mutations'
import { ReplicaHealth, replicaBadge } from './health'
import { ReplicaRetireControls } from './replica'
import { TrashSection } from './trash'
import type { TrashBatchMutations } from './trash-batch'
import { EMPTY_RETIRE, REPLICA_KIND_LABELS } from './types'

export function SyncView({ data, mutations, trashBatch }: {
  data: SyncCenterData
  mutations: SyncCenterMutations
  trashBatch: TrashBatchMutations
}) {
  const { status, conflicts, drafts, loading, refreshing, loadError, loadErrorKind, conflictHeading, load, setDraft } = data
  const {
    retireDrafts, restoreDrafts, conflictReceipts, restoreReceipts, restoreNotices,
    submit, startNewIntent, startRetire, cancelRetire, submitRetire, submitRestore, startNewRestore, retryStaleRefresh,
  } = mutations

  const deviceNames = useMemo(() => new Map(status?.devices.map((device) => [device.id, device.name]) ?? []), [status])
  const recoveryCount = status?.replicas.filter((replica) => replica.status === 'recovery_required').length ?? 0
  const retireBusy = Object.values(retireDrafts).some((draft) => draft.phase === 'submitting')
  const restoreBusy = Object.values(restoreDrafts).some((draft) => draft.phase === 'submitting')
    || trashBatch.batchDraft.phase === 'submitting' || trashBatch.emptyDraft.phase === 'submitting'
  const receiptList = Object.values(conflictReceipts)

  return (
    <PageShell variant="grid" className="sync-page">
        <PageHead
          as="header"
          layout="split"
          variant="workbench"
          title="Sync center"
          documentTitle="Sync"
          lede={isLive('collaborators')
            ? 'Every browser that syncs with this server, the changes that need your decision, and what was deleted. The extension syncs your library, not collections shared with you.'
            : 'Every browser that syncs with this server, the changes that need your decision, and what was deleted.'}
          actions={
            <button type="button" className="btn btn-secondary btn-sm" disabled={loading || refreshing || retireBusy || restoreBusy}
              onClick={() => void load('refresh')}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          }
        />

        <div className="visually-hidden" aria-live="polite">{loading && !status ? '' : loading ? 'Loading Sync status…' : refreshing ? 'Refreshing Sync status…' : ''}</div>
        {loadError && loadErrorKind === 'auth' && (
          <RouteState
            className="empty-state--compact"
            kind="auth"
            icon="link"
            title="Sign in to see sync status"
            description="Sign in again to view Sync status."
          />
        )}
        {loadError && loadErrorKind === 'unavailable' && (
          <RouteState
            className="empty-state--compact"
            kind="unavailable"
            icon="link"
            title="Sync is not available yet"
            feature="browser sync"
          />
        )}
        {loadError && loadErrorKind === 'other' && (
          <RouteState
            className="sync-error empty-state--compact"
            kind="error"
            icon="link"
            title="Couldn't load sync status"
            description={loadError}
            onRetry={() => void load('refresh')}
          />
        )}
        {loading && !status && <LoadingState label="Loading Sync status…" />}

        {!loading && !loadError && <>
          <section className="sync-section" aria-labelledby="replica-heading">
            <div className="section-head section-head--split">
              <div className="sync-heading-row">
                <h2 id="replica-heading">Connected browsers</h2>
                {(status?.replicas.length ?? 0) > 0 && (
                  <span className="count-pill" data-testid="sync-count">{status?.replicas.length}</span>
                )}
              </div>
              {(status?.replicas.length ?? 0) > 0 && (
                <Link to="/extension" className="btn btn-secondary btn-sm">Connect another browser</Link>
              )}
            </div>
            {(status?.replicas.length ?? 0) === 0 ? (
              <EmptyState
                className="empty-state--compact empty-state--slot sync-empty"
                icon="browser"
                title="No browsers syncing yet"
                description="Install the browser extension and connect it to this server. Its bookmarks then sync with your library, and the browser shows up here with its last sync."
                action={<Link to="/extension" className="btn btn-primary btn-sm">Connect a browser</Link>}
              />
            )
              : <ul className="replica-list" aria-label="Connected browsers">
                {status?.replicas.map((replica) => (
                  <li className="replica-card" key={replica.id} data-status={replica.status}>
                    <div className="replica-head">
                      <span className="replica-icon" aria-hidden><Icon name="browser" /></span>
                      <div className="replica-identity">
                        <strong>{replica.name}</strong>
                        <span>{deviceNames.get(replica.deviceId) ?? 'Unknown device'} · {REPLICA_KIND_LABELS[replica.kind]}</span>
                      </div>
                      <StatusBadge tone={replicaBadge(replica).tone} className="replica-state" data-testid="replica-state">{replicaBadge(replica).label}</StatusBadge>
                    </div>
                    <dl className="replica-facts">
                      <div>
                        <dt>Syncs</dt>
                        <dd>{replica.collectionId in data.trashCollectionTitles ? 'Your library' : 'A collection you own'}</dd>
                      </div>
                      <div>
                        <dt>Last synced</dt>
                        <dd title={formatInstant(replica.lastAckAt)}>{replica.lastAckAt ? formatRelative(replica.lastAckAt) : 'Not yet'}</dd>
                      </div>
                      <div>
                        <dt>Last seen</dt>
                        <dd title={formatInstant(replica.lastSeenAt)}>{formatRelative(replica.lastSeenAt)}</dd>
                      </div>
                    </dl>
                    <ReplicaHealth replica={replica} onChanged={() => void load('refresh')}>
                      <ReplicaRetireControls replica={replica} draft={retireDrafts[replica.id] ?? EMPTY_RETIRE}
                        disabled={refreshing} onStart={() => startRetire(replica)}
                        onConfirm={() => void submitRetire(replica)} onReplay={() => void submitRetire(replica, true)}
                        onCancel={() => cancelRetire(replica)} />
                    </ReplicaHealth>
                  </li>
                ))}
              </ul>}
          </section>

          {recoveryCount > 0 && <aside className="sync-recovery" role="status"><strong>Catching up</strong><span>{plural(recoveryCount, 'browser')} will reload your library from this server on {recoveryCount === 1 ? 'its' : 'their'} next sync to take in changes made here. If one stays here, open the extension on that browser.</span></aside>}

          <section className="sync-section" aria-labelledby="conflict-heading">
            <div className="section-head section-head--split">
              <div className="sync-heading-row">
                <h2 id="conflict-heading" ref={conflictHeading} tabIndex={-1}>Review browser changes</h2>
                {conflicts.length > 0 && <span className="count-pill" data-testid="sync-count">{conflicts.length}</span>}
              </div>
            </div>
            {conflicts.length === 0 && receiptList.length === 0 ? (
              <EmptyState
                className="empty-state--compact empty-state--slot sync-empty"
                icon="check"
                title="No open conflicts"
                description="When a bookmark changes in two places at once, you choose which version stays here."
              />
            )
              : <div className="conflict-list">
                {receiptList.map((receipt) => <ConflictReceipt key={receipt.conflictId} receipt={receipt} />)}
                {conflicts.map((conflict) => <ConflictEditor key={conflict.id} conflict={conflict}
                draft={drafts[conflict.id] ?? initialDraft(conflict)} onDraft={(change) => setDraft(conflict.id, change)}
                onSubmit={() => void submit(conflict)} onReplay={() => void submit(conflict, true)} onRefresh={() => void retryStaleRefresh(conflict)}
                onNewIntent={() => startNewIntent(conflict)} />)}
              </div>}
          </section>

          <TrashSection
            collectionTitles={data.trashCollectionTitles}
            collectionId={data.trashCollectionId}
            items={data.trashItems}
            details={data.trashDetails}
            drafts={restoreDrafts}
            receipts={restoreReceipts}
            notices={restoreNotices}
            selected={trashBatch.selected}
            batchDraft={trashBatch.batchDraft}
            emptyDraft={trashBatch.emptyDraft}
            batchView={trashBatch.batchView}
            emptyView={trashBatch.emptyView}
            error={data.trashError}
            errorKind={data.trashErrorKind}
            disabled={refreshing || restoreBusy}
            onRevealUrl={(deletionId) => void data.revealTrashUrl(deletionId)}
            onRestore={(item) => void submitRestore(item)}
            onReplay={(item) => void submitRestore(item, true)}
            onNewIntent={startNewRestore}
            onRetry={() => void data.loadTrash(data.trashCollectionId)}
            onToggleSelected={trashBatch.toggleSelected}
            onToggleAll={trashBatch.toggleAll}
            onRestoreSelected={() => void trashBatch.submitBatch()}
            onReplayBatch={() => void trashBatch.submitBatch(true)}
            onRestoreSubtree={(item) => void trashBatch.submitSubtree(item)}
            onStartEmpty={trashBatch.startEmpty}
            onCancelEmpty={trashBatch.cancelEmpty}
            onConfirmEmpty={() => void trashBatch.submitEmpty()}
            onReplayEmpty={() => void trashBatch.submitEmpty(true)}
          />
        </>}
    </PageShell>
  )
}
