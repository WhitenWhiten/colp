import { useState, type MutableRefObject } from 'react'
import {
  ProductApiError,
  productClient,
  recoveryStrategyFor,
  type SyncTrashEmptyView,
  type SyncTrashListItem,
  type SyncTrashRestoreBatchView,
} from '../../api'
import { EMPTY_BATCH_RESTORE, EMPTY_EMPTY_TRASH, type BatchRestoreDraft, type EmptyTrashDraft } from './types'

export function useTrashBatchMutations(options: {
  mounted: MutableRefObject<boolean>
  items: SyncTrashListItem[]
  collectionId: string | null
  loadTrash: (collectionId: string | null, signal?: AbortSignal) => Promise<SyncTrashListItem[]>
}) {
  const { mounted, items, collectionId, loadTrash } = options
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [batchDraft, setBatchDraft] = useState<BatchRestoreDraft>(EMPTY_BATCH_RESTORE)
  const [emptyDraft, setEmptyDraft] = useState<EmptyTrashDraft>(EMPTY_EMPTY_TRASH)
  const [batchView, setBatchView] = useState<SyncTrashRestoreBatchView | null>(null)
  const [emptyView, setEmptyView] = useState<SyncTrashEmptyView | null>(null)

  const toggleSelected = (deletionId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(deletionId)) next.delete(deletionId)
      else next.add(deletionId)
      return next
    })
  }

  const toggleAll = () => {
    setSelected((current) => {
      if (items.length > 0 && items.every((item) => current.has(item.deletionId))) return new Set()
      return new Set(items.map((item) => item.deletionId))
    })
  }

  const submitBatch = async (replay = false) => {
    if (!collectionId) return
    const draft = batchDraft
    let frozen = replay ? draft.frozen : null
    const chosen = items.filter((item) => (frozen?.deletionIds ?? [...selected]).includes(item.deletionId))
    if (!frozen) {
      if (chosen.length < 1) {
        setBatchDraft({ phase: 'blocked', message: 'Select at least one deleted item to restore.', frozen: null })
        return
      }
      frozen = { intentId: `sync-trash-restore-batch:${collectionId}:${crypto.randomUUID()}`,
        deletionIds: chosen.map((item) => item.deletionId) }
    }
    const requestItems = items.filter((item) => frozen!.deletionIds.includes(item.deletionId))
      .map((item) => ({ deletionId: item.deletionId, expectedRevision: item.revision }))
    if (requestItems.length < 1) {
      setBatchDraft({ phase: 'blocked', message: 'Select at least one deleted item to restore.', frozen: null })
      return
    }
    setBatchDraft({ phase: 'submitting', message: null, frozen })
    try {
      const receipt = await productClient.restoreSyncTrashBatch({ collectionId, items: requestItems }, {
        intentId: frozen.intentId, clearIntentOnSuccess: false, maxRetries: 0,
      })
      productClient.abandonSyncTrashIntent(frozen.intentId)
      if (!mounted.current) return
      setBatchView(receipt)
      setBatchDraft(EMPTY_BATCH_RESTORE)
      setSelected(new Set())
      await loadTrash(collectionId)
    } catch (error) {
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : new ProductApiError({
        status: 0, code: 'transport_error', message: 'The batch restore may not have completed.',
        recovery: 'same_request', sameRequestRetrySafe: true,
      })
      const strategy = recoveryStrategyFor(apiError)
      if (strategy === 'retry_same_command') {
        setBatchDraft({
          phase: 'unknown',
          message: 'The batch restore may not have completed. Try again to confirm the result.',
          frozen,
        })
        return
      }
      productClient.abandonSyncTrashIntent(frozen.intentId)
      setBatchDraft({
        phase: 'blocked',
        message: apiError.isAuthRequired
          ? 'Sign in again before restoring selected items.'
          : 'Could not restore the selected items. Review the per-item results after refresh.',
        frozen: null,
      })
    }
  }

  const submitSubtree = async (item: SyncTrashListItem, replay = false) => {
    if (!collectionId) return
    const draft = batchDraft
    let frozen = replay ? draft.frozen : null
    if (!frozen) frozen = {
      intentId: `sync-trash-restore-subtree:${item.deletionId}:${crypto.randomUUID()}`,
      deletionIds: [item.deletionId],
    }
    setBatchDraft({ phase: 'submitting', message: null, frozen })
    try {
      const receipt = await productClient.restoreSyncTrashSubtree(item.deletionId, `"${item.revision}"`, {
        intentId: frozen.intentId, clearIntentOnSuccess: false, maxRetries: 0,
      })
      productClient.abandonSyncTrashIntent(frozen.intentId)
      if (!mounted.current) return
      setBatchView(receipt)
      setBatchDraft(EMPTY_BATCH_RESTORE)
      setSelected(new Set())
      await loadTrash(collectionId)
    } catch (error) {
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : new ProductApiError({
        status: 0, code: 'transport_error', message: 'The folder tree restore may not have completed.',
        recovery: 'same_request', sameRequestRetrySafe: true,
      })
      if (recoveryStrategyFor(apiError) === 'retry_same_command') {
        setBatchDraft({
          phase: 'unknown',
          message: 'The folder tree restore may not have completed. Try again to confirm the result.',
          frozen,
        })
        return
      }
      productClient.abandonSyncTrashIntent(frozen.intentId)
      setBatchDraft({
        phase: apiError.status === 412 ? 'blocked' : 'blocked',
        message: apiError.status === 410
          ? 'This folder is no longer restorable.'
          : apiError.status === 412
            ? 'This folder changed. Refresh deleted items, then restore the tree again.'
            : 'Could not restore this folder tree.',
        frozen: null,
      })
    }
  }

  const startEmpty = () => {
    const frozen = emptyDraft.frozen
    if (frozen) productClient.abandonSyncTrashIntent(frozen.intentId)
    setEmptyDraft({ phase: 'confirming', message: null, frozen: null })
  }

  const cancelEmpty = () => {
    const frozen = emptyDraft.frozen
    if (frozen) productClient.abandonSyncTrashIntent(frozen.intentId)
    setEmptyDraft(EMPTY_EMPTY_TRASH)
  }

  const submitEmpty = async (replay = false) => {
    if (!collectionId) return
    const draft = emptyDraft
    let frozen = replay ? draft.frozen : null
    if (!frozen) frozen = {
      intentId: `sync-trash-empty:${collectionId}:${crypto.randomUUID()}`,
      expectedCount: items.length,
    }
    if (frozen.expectedCount < 1) {
      setEmptyDraft({ phase: 'blocked', message: 'There are no deleted items to empty.', frozen: null })
      return
    }
    setEmptyDraft({ phase: 'submitting', message: null, frozen })
    try {
      const receipt = await productClient.emptySyncTrash({
        collectionId, expectedCount: frozen.expectedCount, confirmation: 'permanently_delete',
      }, { intentId: frozen.intentId, clearIntentOnSuccess: false, maxRetries: 0 })
      productClient.abandonSyncTrashIntent(frozen.intentId)
      if (!mounted.current) return
      setEmptyView(receipt)
      setEmptyDraft(EMPTY_EMPTY_TRASH)
      setSelected(new Set())
      await loadTrash(collectionId)
    } catch (error) {
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : new ProductApiError({
        status: 0, code: 'transport_error', message: 'Emptying the trash may not have finished.',
        recovery: 'same_request', sameRequestRetrySafe: true,
      })
      if (recoveryStrategyFor(apiError) === 'retry_same_command') {
        setEmptyDraft({
          phase: 'unknown',
          message: 'Emptying the trash may not have finished. Try again to confirm the result.',
          frozen,
        })
        return
      }
      productClient.abandonSyncTrashIntent(frozen.intentId)
      if (apiError.status === 412) {
        await loadTrash(collectionId)
        setEmptyDraft({
          phase: 'stale',
          message: 'Deleted items changed. Review the latest count, then confirm empty again.',
          frozen: null,
        })
        return
      }
      setEmptyDraft({
        phase: 'blocked',
        message: apiError.isAuthRequired
          ? 'Sign in again before emptying trash.'
          : "Couldn't empty trash. Items a browser still needs were kept.",
        frozen: null,
      })
    }
  }

  return {
    selected,
    batchDraft,
    emptyDraft,
    batchView,
    emptyView,
    toggleSelected,
    toggleAll,
    submitBatch,
    submitSubtree,
    startEmpty,
    cancelEmpty,
    submitEmpty,
  }
}

export type TrashBatchMutations = ReturnType<typeof useTrashBatchMutations>
