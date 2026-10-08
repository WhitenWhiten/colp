import type {
  SyncTrashDetail, SyncTrashEmptyView, SyncTrashListItem, SyncTrashRestoreBatchView, SyncTrashRestoreView,
} from '../../api'
import { useConfirm } from '../../components/ConfirmModal'
import { DataTable, DataTableCell, DataTableRow } from '../../components/DataTable'
import { EmptyState } from '../../components/EmptyState'
import { RouteState } from '../../components/RouteState'
import { formatInstant } from './fields'
import {
  EMPTY_RESTORE, EMPTY_SKIP_LABELS, INTENT_MESSAGE_CLASS,
  RESTORE_OUTCOME_LABELS, TRASH_KIND_LABELS,
  type BatchRestoreDraft, type EmptyTrashDraft, type RestoreDraft,
} from './types'
import { productName } from '../../lib/edition'

export function TrashSection({
  collections, collectionTitles = {}, collectionId, items, details, drafts, receipts, notices,
  selected, batchDraft, emptyDraft, batchView, emptyView,
  error, errorKind, disabled, onCollection, onRevealUrl, onRestore, onReplay, onNewIntent, onRetry,
  onToggleSelected, onToggleAll, onRestoreSelected, onReplayBatch, onRestoreSubtree, onStartEmpty,
  onCancelEmpty, onConfirmEmpty, onReplayEmpty,
}: {
  collections: string[]
  collectionTitles?: Record<string, string>
  collectionId: string | null
  items: SyncTrashListItem[]
  details: Record<string, SyncTrashDetail>
  drafts: Record<string, RestoreDraft>
  receipts: Record<string, SyncTrashRestoreView>
  notices: Record<string, string>
  selected: ReadonlySet<string>
  batchDraft: BatchRestoreDraft
  emptyDraft: EmptyTrashDraft
  batchView: SyncTrashRestoreBatchView | null
  emptyView: SyncTrashEmptyView | null
  error: string | null
  errorKind: 'auth' | 'stale' | 'other' | null
  disabled: boolean
  onCollection(collectionId: string): void
  onRevealUrl(deletionId: string): void
  onRestore(item: SyncTrashListItem): void
  onReplay(item: SyncTrashListItem): void
  onNewIntent(item: SyncTrashListItem): void
  onRetry(): void
  onToggleSelected(deletionId: string): void
  onToggleAll(): void
  onRestoreSelected(): void
  onReplayBatch(): void
  onRestoreSubtree(item: SyncTrashListItem): void
  onStartEmpty(): void
  onCancelEmpty(): void
  onConfirmEmpty(): void
  onReplayEmpty(): void
}) {
  const receiptList = Object.values(receipts)
  const noticeList = Object.entries(notices)
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.deletionId))
  const busy = batchDraft.phase === 'submitting' || emptyDraft.phase === 'submitting'
  const confirm = useConfirm()
  const scopeCopy = collectionId ? `from “${collectionTitles[collectionId] || collectionId}” in ${productName()} trash` : `from ${productName()} trash`
  const emptyCopy = `Permanently delete ${items.length} item${items.length === 1 ? '' : 's'} ${scopeCopy}. This can't be undone. Items are kept at least 30 days and while a browser still needs the deletion; offline browsers can delay this.`
  // The first confirm is the shared danger modal; a stale count (trash changed
  // under the prompt) asks again inline next to its message.
  const startEmpty = async () => {
    onStartEmpty()
    const ok = await confirm({ title: 'Empty trash?', body: emptyCopy, confirmLabel: 'Permanently delete' })
    if (ok) onConfirmEmpty()
    else onCancelEmpty()
  }
  return (
    <section className="sync-section" aria-labelledby="trash-heading">
      <div className="section-head section-head--split">
        <div>
          <p className="section-label">Private trash</p>
          <div className="sync-heading-row">
            <h2 id="trash-heading">Deleted items</h2>
            {items.length > 0 && <span className="sync-count" data-testid="sync-count">{items.length}</span>}
          </div>
        </div>
        {collections.length > 1 && (
          <label className="field trash-collection">
            <span>Collection</span>
            <select aria-label="Trash collection" value={collectionId ?? ''} disabled={disabled}
              onChange={(event) => onCollection(event.target.value)}>
              {collections.map((id) => <option key={id} value={id}>{collectionTitles[id] || id}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && errorKind === 'auth' && (
        <RouteState className="empty-state--compact" kind="auth" icon="link" title="Sign in to see deleted items" description="Sign in again to view deleted items." />
      )}
      {error && errorKind !== 'auth' && (
        <RouteState className="sync-error empty-state--compact" kind="error" icon="link"
          title="Couldn't load deleted items" description={error} onRetry={onRetry} />
      )}
      {!error && items.length === 0 && receiptList.length === 0 && noticeList.length === 0
        && !batchView && !emptyView && (
        <EmptyState className="sync-empty" icon="folder" title="No deleted items"
          description={`Deleted bookmarks from collections you own appear here. Restoring puts them back in ${productName()}; your browsers get them on their next sync.`} />
      )}
      {(receiptList.length > 0 || noticeList.length > 0 || batchView || emptyView) && (
        <div className="trash-receipt-list">
          {receiptList.map((receipt) => (
            <article className="trash-receipt" key={receipt.deletionId} data-trash-receipt={receipt.deletionId}>
              <span className="conflict-field">Result</span>
              <h3>Restored</h3>
              <dl className="trash-facts">
                <div><dt>Restored at</dt><dd><time dateTime={receipt.restoredAt}>{formatInstant(receipt.restoredAt)}</time></dd></div>
              </dl>
            </article>
          ))}
          {batchView && <BatchResultView view={batchView} />}
          {emptyView && <EmptyResultView view={emptyView} />}
          {noticeList.map(([id, message]) => (
            <p className="trash-notice" key={id} role="status">{message}</p>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="trash-toolbar">
          <label className="trash-select-all">
            <input type="checkbox" checked={allSelected} disabled={disabled || busy}
              onChange={onToggleAll} aria-label="Select all deleted items" />
            <span>{selected.size} selected</span>
          </label>
          {batchDraft.phase === 'unknown'
            ? <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={onReplayBatch}>Retry restore</button>
            : <button type="button" className="btn btn-primary btn-sm" disabled={disabled || busy || selected.size < 1}
              onClick={onRestoreSelected}>Restore selected</button>}
          {emptyDraft.phase === 'stale' ? (
            <div className="trash-empty-confirm" role="alertdialog" aria-labelledby="empty-trash-copy">
              <p id="empty-trash-copy">{emptyCopy}</p>
              <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={onCancelEmpty}>Cancel</button>
              <button type="button" className="btn btn-danger btn-sm" disabled={disabled || busy}
                onClick={onConfirmEmpty}>Permanently delete</button>
            </div>
          ) : emptyDraft.phase === 'unknown' ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={onReplayEmpty}>Retry empty trash</button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy || emptyDraft.phase === 'confirming'}
              onClick={() => void startEmpty()}>Empty trash</button>
          )}
        </div>
      )}
      {(batchDraft.message || emptyDraft.message) && (
        <p className={`trash-message ${INTENT_MESSAGE_CLASS[batchDraft.phase] ?? INTENT_MESSAGE_CLASS[emptyDraft.phase] ?? ''}`.trim()}
          role="alert">{batchDraft.message ?? emptyDraft.message}</p>
      )}
      {items.length > 0 && (
        <DataTable className="trash-list" label="Deleted items" columns={[
          { key: 'select', label: <span className="visually-hidden">Select</span> },
          { key: 'item', label: 'Item' },
          { key: 'dates', label: 'Dates' },
          { key: 'actions', label: <span className="visually-hidden">Actions</span> },
        ]}>{items.map((item) => {
          const draft = drafts[item.deletionId] ?? EMPTY_RESTORE
          const detail = details[item.deletionId]
          const url = typeof detail?.url === 'string' && detail.url.length > 0 ? detail.url : null
          const subtree = item.kind === 'folder'
            && items.some((row) => row.originalParentId === item.nodeId)
          return <TrashRow key={item.deletionId} item={item} draft={draft} url={url} revealed={detail !== undefined}
            selected={selected.has(item.deletionId)} subtree={subtree}
            disabled={disabled} busy={busy} onToggle={() => onToggleSelected(item.deletionId)}
            onReveal={() => onRevealUrl(item.deletionId)}
            onRestore={() => onRestore(item)} onReplay={() => onReplay(item)} onNewIntent={() => onNewIntent(item)}
            onRestoreSubtree={() => onRestoreSubtree(item)} />
        })}</DataTable>
      )}
    </section>
  )
}

function BatchResultView({ view }: { view: SyncTrashRestoreBatchView }) {
  const failed = view.summary.applied !== view.results.length
  return (
    <article className="trash-receipt" data-trash-batch-result="">
      <span className="conflict-field">Result</span>
      <h3>{failed ? `Restored ${view.summary.applied} of ${view.results.length}` : `Restored ${view.summary.applied}`}</h3>
      <ul className="trash-outcome-list">
        {view.results.map((result) => (
          <li key={result.deletionId} data-outcome={result.outcome} data-deletion-id={result.deletionId}>
            {RESTORE_OUTCOME_LABELS[result.outcome] ?? result.outcome}
            {result.nodeId ? ` · ${result.nodeId}` : ` · ${result.deletionId}`}
          </li>
        ))}
      </ul>
    </article>
  )
}

function EmptyResultView({ view }: { view: SyncTrashEmptyView }) {
  return (
    <article className="trash-receipt" data-trash-empty-result="">
      <span className="conflict-field">Result</span>
      <h3>
        {view.summary.skipped > 0
          ? `Permanently removed ${view.summary.purged} of ${view.results.length}. ${view.summary.skipped} skipped.`
          : `Permanently removed ${view.summary.purged}`}
      </h3>
      <ul className="trash-outcome-list">
        {view.results.map((result) => (
          <li key={result.deletionId} data-outcome={result.outcome}>
            {result.outcome === 'purged' ? 'Permanently deleted'
              : EMPTY_SKIP_LABELS[result.reason ?? ''] ?? 'Skipped'}
          </li>
        ))}
      </ul>
    </article>
  )
}

function TrashRow({ item, draft, url, revealed, selected, subtree, disabled, busy, onToggle, onReveal, onRestore, onReplay, onNewIntent, onRestoreSubtree }: {
  item: SyncTrashListItem; draft: RestoreDraft; url: string | null; revealed: boolean; selected: boolean
  subtree: boolean; disabled: boolean; busy: boolean
  onToggle(): void; onReveal(): void; onRestore(): void; onReplay(): void; onNewIntent(): void; onRestoreSubtree(): void
}) {
  const rowBusy = draft.phase === 'submitting' || busy
  const location = item.originalParentTitle ?? 'Original location unavailable'
  return <DataTableRow className="trash-row" data-deletion-id={item.deletionId}>
    <DataTableCell>
      <label className="trash-select">
        <input type="checkbox" checked={selected} disabled={disabled || rowBusy} onChange={onToggle}
          aria-label={`Select ${item.title ?? 'deleted item'}`} />
      </label>
    </DataTableCell>
    <DataTableCell className="trash-identity">
      <strong>{item.title ?? 'Untitled'}</strong>
      <span>{TRASH_KIND_LABELS[item.kind]} · {location}</span>
    </DataTableCell>
    <DataTableCell>
      <dl className="trash-facts">
        <div><dt>Deleted</dt><dd><time dateTime={item.deletedAt}>{formatInstant(item.deletedAt)}</time></dd></div>
        <div><dt>Deleted for good after</dt><dd><time dateTime={item.purgeAfter}>{formatInstant(item.purgeAfter)}</time></dd></div>
      </dl>
    </DataTableCell>
    <DataTableCell className="trash-actions">
      {!revealed && <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || rowBusy} onClick={onReveal}>Show URL</button>}
      {item.kind === 'folder' && subtree && draft.phase === 'idle' && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || rowBusy}
          onClick={onRestoreSubtree} aria-label={`Restore folder tree ${item.title ?? 'deleted folder'}`}>Restore folder tree</button>
      )}
      {draft.phase === 'unknown'
        ? <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={onReplay}>Retry restore</button>
        : draft.phase === 'stale'
          ? <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={onRestore}>Restore with latest version</button>
          : draft.phase === 'blocked' && draft.frozen
            ? <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={onNewIntent}>Start new restore</button>
            : <button type="button" className="btn btn-primary btn-sm" disabled={disabled || rowBusy} onClick={onRestore}
              aria-label={`Restore ${item.title ?? 'deleted item'}`}>{rowBusy && draft.phase === 'submitting' ? 'Restoring…' : 'Restore'}</button>}
    </DataTableCell>
    {/* Full-width spills render after the actions cell so grid auto-placement
        keeps the four primary cells on the first row. */}
    {url && <DataTableCell full><p className="trash-url">{url}</p></DataTableCell>}
    {draft.message && (
      <DataTableCell full>
        <div className={`trash-message ${INTENT_MESSAGE_CLASS[draft.phase] ?? ''}`.trim()} role="alert">{draft.message}</div>
      </DataTableCell>
    )}
  </DataTableRow>
}
