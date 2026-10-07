import { useMemo } from 'react'
import { DataTable, DataTableCell, DataTableRow } from '../../components/DataTable'
import { EmptyState, LoadingState } from '../../components/EmptyState'
import { PageHead } from '../../components/PageHead'
import { PageShell } from '../../components/PageShell'
import { RouteState } from '../../components/RouteState'
import { StatusBadge } from '../../components/StatusBadge'
import { ConflictEditor, ConflictReceipt } from './conflict'
import type { SyncCenterData } from './data'
import { formatInstant, initialDraft } from './fields'
import { plural } from '../../lib/plural'
import type { SyncCenterMutations } from './mutations'
import { ReplicaRetireControls } from './replica'
import { TrashSection } from './trash'
import type { TrashBatchMutations } from './trash-batch'
import { EMPTY_RETIRE, REPLICA_KIND_LABELS, REPLICA_STATE_TONE, STATUS_LABELS } from './types'

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
          eyebrow="Tools"
          title="Sync center"
          documentTitle="Sync"
          lede="See which browsers sync your collections and resolve conflicts. The extension only syncs collections you own, not ones shared with you."
          actions={
            <button type="button" className="btn btn-secondary btn-sm" disabled={loading || refreshing || retireBusy || restoreBusy}
              onClick={() => void load('refresh')}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
          }
        />

        <div className="sync-live" aria-live="polite">{loading && !status ? '' : loading ? 'Loading Sync status…' : refreshing ? 'Refreshing Sync status…' : ''}</div>
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
              <div>
                <div className="sync-heading-row">
                  <h2 id="replica-heading">Connected browsers</h2>
                  {(status?.replicas.length ?? 0) > 0 && (
                    <span className="sync-count" data-testid="sync-count">{status?.replicas.length}</span>
                  )}
                </div>
              </div>
            </div>
            {(status?.replicas.length ?? 0) === 0 ? (
              <EmptyState
                className="sync-empty"
                icon="link"
                title="No connected browsers"
                description="Install the browser extension and sign in to sync a collection you own."
              />
            )
              : <DataTable className="replica-list" label="Connected browsers" columns={[
                  { key: 'replica', label: 'Browser' },
                  { key: 'state', label: 'State' },
                  { key: 'sync', label: 'Last sync' },
                  { key: 'actions', label: <span className="visually-hidden">Actions</span> },
                ]}>
                {status?.replicas.map((replica) => <DataTableRow className="replica-row" key={replica.id}>
                  <DataTableCell className="replica-identity"><strong>{replica.name}</strong><span>{deviceNames.get(replica.deviceId) ?? 'Unknown device'} · {REPLICA_KIND_LABELS[replica.kind]}</span></DataTableCell>
                  <DataTableCell><StatusBadge tone={REPLICA_STATE_TONE[replica.status]}>{STATUS_LABELS[replica.status]}</StatusBadge></DataTableCell>
                  <DataTableCell><dl className="replica-facts"><div><dt>Last synced</dt><dd>{formatInstant(replica.lastAckAt)}</dd></div>
                    <div><dt>Last seen</dt><dd>{formatInstant(replica.lastSeenAt)}</dd></div></dl></DataTableCell>
                  <ReplicaRetireControls replica={replica} draft={retireDrafts[replica.id] ?? EMPTY_RETIRE}
                    disabled={refreshing} onStart={() => startRetire(replica)}
                    onConfirm={() => void submitRetire(replica)} onReplay={() => void submitRetire(replica, true)}
                    onCancel={() => cancelRetire(replica)} />
                </DataTableRow>)}
              </DataTable>}
          </section>

          {recoveryCount > 0 && <aside className="sync-recovery" role="status"><strong>Recovery required</strong><span>{plural(recoveryCount, 'browser')} {recoveryCount === 1 ? 'needs' : 'need'} a sync reset before syncing can continue. Open the extension's settings on that browser.</span></aside>}

          <section className="sync-section" aria-labelledby="conflict-heading">
            <div className="section-head section-head--split">
              <div>
                <p className="section-label">Open conflicts</p>
                <div className="sync-heading-row">
                  <h2 id="conflict-heading" ref={conflictHeading} tabIndex={-1}>Review browser changes</h2>
                  {conflicts.length > 0 && <span className="sync-count" data-testid="sync-count">{conflicts.length}</span>}
                </div>
              </div>
            </div>
            {conflicts.length === 0 && receiptList.length === 0 ? (
              <EmptyState
                className="sync-empty"
                icon="folder"
                title="No open conflicts"
                description="New concurrent browser edits will appear here."
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
            collections={data.trashCollections}
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
            onCollection={data.selectTrashCollection}
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
