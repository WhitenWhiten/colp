import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import {
  ProductApiError,
  productClient,
  recoveryStrategyFor,
  type ProductSyncConflictResolution,
  type ProductSyncConflictResolutionView,
  type SyncConflictSummary,
  type SyncReplicaView,
  type SyncStatusView,
  type SyncTrashListItem,
  type SyncTrashRestoreView,
} from '../../api'
import { initialDraft, parseCustomValue, quotedEntityTag } from './fields'
import { EMPTY_RESTORE, EMPTY_RETIRE, type ConflictDraft, type RestoreDraft, type RetireDraft } from './types'

export function useSyncCenterMutations(options: {
  mounted: MutableRefObject<boolean>
  drafts: Record<string, ConflictDraft>
  setDraft: (id: string, change: Partial<ConflictDraft>) => void
  refreshConflict: (conflictId: string) => Promise<SyncConflictSummary | null>
  load: (kind: 'initial' | 'refresh', signal?: AbortSignal) => Promise<void>
  loadTrash: (collectionId: string | null, signal?: AbortSignal) => Promise<SyncTrashListItem[]>
  trashCollectionId: string | null
  setStatus: Dispatch<SetStateAction<SyncStatusView | null>>
  setConflicts: Dispatch<SetStateAction<SyncConflictSummary[]>>
  setDrafts: Dispatch<SetStateAction<Record<string, ConflictDraft>>>
  restoreConflictFocus: MutableRefObject<boolean>
  success: (message: string) => void
}) {
  const {
    mounted,
    drafts,
    setDraft,
    refreshConflict,
    load,
    loadTrash,
    trashCollectionId,
    setStatus,
    setConflicts,
    setDrafts,
    restoreConflictFocus,
    success,
  } = options

  const [retireDrafts, setRetireDrafts] = useState<Record<string, RetireDraft>>({})
  const [restoreDrafts, setRestoreDrafts] = useState<Record<string, RestoreDraft>>({})
  const [conflictReceipts, setConflictReceipts] = useState<Record<string, ProductSyncConflictResolutionView>>({})
  const [restoreReceipts, setRestoreReceipts] = useState<Record<string, SyncTrashRestoreView>>({})
  const [restoreNotices, setRestoreNotices] = useState<Record<string, string>>({})

  const submit = async (conflict: SyncConflictSummary, replay = false) => {
    const draft = drafts[conflict.id] ?? initialDraft(conflict)
    let frozen = replay ? draft.frozen : null
    if (!frozen) {
      let request: ProductSyncConflictResolution
      if (draft.resolution === 'custom') {
        const parsed = parseCustomValue(conflict, draft.customText)
        if ('error' in parsed) { setDraft(conflict.id, { phase: 'invalid', message: parsed.error ?? 'Enter a valid custom value.' }); return }
        request = { resolution: 'custom', value: parsed.value }
      } else request = { resolution: draft.resolution }
      frozen = { intentId: `sync-conflict:${conflict.id}:${crypto.randomUUID()}`, revision: conflict.etag, request }
    }
    setDraft(conflict.id, { phase: 'submitting', message: null, frozen })
    try {
      const receipt = await productClient.resolveSyncConflict(conflict.id, frozen.request, frozen.revision, {
        intentId: frozen.intentId, clearIntentOnSuccess: false, maxRetries: 0,
      })
      productClient.abandonSyncConflictIntent(frozen.intentId)
      if (!mounted.current) return
      if (receipt?.status === 'resolved') setConflictReceipts((current) => ({ ...current, [conflict.id]: receipt }))
      setConflicts((items) => items.filter((item) => item.id !== conflict.id))
      setDrafts((current) => { const next = { ...current }; delete next[conflict.id]; return next })
      restoreConflictFocus.current = true
    } catch (error) {
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : new ProductApiError({ status: 0, code: 'transport_error', message: 'The resolution may not have completed.', recovery: 'same_request', sameRequestRetrySafe: true })
      const strategy = recoveryStrategyFor(apiError)
      if (strategy === 'retry_same_command') {
        setDraft(conflict.id, { phase: 'unknown', message: 'The resolution may not have completed. Try again to confirm the result.', frozen })
        return
      }
      if (apiError.status === 404 || apiError.code === 'resource_not_found') {
        try { await refreshConflict(conflict.id) } catch { setDraft(conflict.id, { phase: 'blocked', message: 'This conflict may already be resolved. Refresh to confirm.', frozen: null }) }
        return
      }
      if (strategy === 'refresh_and_retry') {
        productClient.abandonSyncConflictIntent(frozen.intentId)
        try {
          const latest = await refreshConflict(conflict.id)
          if (!latest) return
          setDraft(conflict.id, { phase: 'stale', message: 'This conflict changed. Review the latest server value, then confirm again.', frozen: null })
        } catch {
          setDraft(conflict.id, { phase: 'refresh_required', message: 'This conflict changed. Refresh it before confirming again.', frozen: null })
        }
        return
      }
      if (strategy === 'new_user_intent') {
        setDraft(conflict.id, { phase: 'blocked', message: 'This action could not be completed. Review the current conflict and try again.', frozen })
        return
      }
      setDraft(conflict.id, { phase: 'blocked', message: apiError.isAuthRequired
        ? 'Sign in again before resolving this conflict.'
        : apiError.status === 403 ? 'You no longer have permission to resolve this conflict.'
          : apiError.recoveryHint, frozen })
    }
  }

  const startNewIntent = (conflict: SyncConflictSummary) => {
    const frozen = drafts[conflict.id]?.frozen
    if (frozen) productClient.abandonSyncConflictIntent(frozen.intentId)
    setDraft(conflict.id, { phase: 'idle', message: null, frozen: null })
  }

  const setRetireDraft = (id: string, change: Partial<RetireDraft>) => {
    setRetireDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_RETIRE), ...change } }))
  }

  const startRetire = (replica: SyncReplicaView) => {
    const frozen = retireDrafts[replica.id]?.frozen
    if (frozen) productClient.abandonSyncReplicaIntent(frozen.intentId)
    setRetireDraft(replica.id, { phase: 'confirming', message: null, frozen: null })
  }

  const cancelRetire = (replica: SyncReplicaView) => {
    const frozen = retireDrafts[replica.id]?.frozen
    if (frozen) productClient.abandonSyncReplicaIntent(frozen.intentId)
    setRetireDraft(replica.id, EMPTY_RETIRE)
  }

  const submitRetire = async (replica: SyncReplicaView, replay = false) => {
    const draft = retireDrafts[replica.id] ?? EMPTY_RETIRE
    let frozen = replay ? draft.frozen : null
    if (!frozen) frozen = { intentId: `sync-retire:${replica.id}:${crypto.randomUUID()}`, etag: replica.etag }
    setRetireDraft(replica.id, { phase: 'submitting', message: null, frozen })
    try {
      await productClient.retireSyncReplica(replica.id, frozen.etag, {
        intentId: frozen.intentId, clearIntentOnSuccess: false, maxRetries: 0,
      })
      productClient.abandonSyncReplicaIntent(frozen.intentId)
      if (!mounted.current) return
      success('Stopped syncing this browser')
      await load('refresh')
      if (!mounted.current) return
      setRetireDraft(replica.id, EMPTY_RETIRE)
    } catch (error) {
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : new ProductApiError({
        status: 0, code: 'transport_error', message: 'Syncing may not have stopped.',
        recovery: 'same_request', sameRequestRetrySafe: true,
      })
      const strategy = recoveryStrategyFor(apiError)
      if (strategy === 'retry_same_command') {
        setRetireDraft(replica.id, {
          phase: 'unknown',
          message: 'Syncing may not have stopped. Try again to confirm the result.',
          frozen,
        })
        return
      }
      if (apiError.status === 404 || apiError.code === 'resource_not_found') {
        productClient.abandonSyncReplicaIntent(frozen.intentId)
        try {
          const nextStatus = await productClient.getSyncStatus({ maxRetries: 0 })
          if (!mounted.current) return
          setStatus(nextStatus)
          if (!nextStatus.replicas.some((item) => item.id === replica.id)) {
            setRetireDraft(replica.id, EMPTY_RETIRE)
            return
          }
          setRetireDraft(replica.id, {
            phase: 'blocked',
            message: 'This browser already stopped syncing or is unavailable. Refresh to confirm.',
            frozen: null,
          })
        } catch {
          setRetireDraft(replica.id, {
            phase: 'blocked',
            message: 'This browser may no longer be listed. Refresh to confirm.',
            frozen: null,
          })
        }
        return
      }
      if (strategy === 'refresh_and_retry') {
        productClient.abandonSyncReplicaIntent(frozen.intentId)
        try {
          const nextStatus = await productClient.getSyncStatus({ maxRetries: 0 })
          if (!mounted.current) return
          setStatus(nextStatus)
          const latest = nextStatus.replicas.find((item) => item.id === replica.id)
          if (!latest || latest.status === 'retired') {
            setRetireDraft(replica.id, EMPTY_RETIRE)
            return
          }
          setRetireDraft(replica.id, {
            phase: 'stale',
            message: "This browser's copy changed. Refresh the latest version, then confirm again.",
            frozen: null,
          })
        } catch {
          setRetireDraft(replica.id, {
            phase: 'blocked',
            message: "This browser's copy changed. Refresh Sync status before confirming again.",
            frozen: null,
          })
        }
        return
      }
      if (strategy === 'new_user_intent') {
        productClient.abandonSyncReplicaIntent(frozen.intentId)
        try {
          const nextStatus = await productClient.getSyncStatus({ maxRetries: 0 })
          if (!mounted.current) return
          setStatus(nextStatus)
          const latest = nextStatus.replicas.find((item) => item.id === replica.id)
          if (!latest || latest.status === 'retired') {
            setRetireDraft(replica.id, EMPTY_RETIRE)
            return
          }
        } catch { /* keep the current status and require a new confirm */ }
        if (!mounted.current) return
        setRetireDraft(replica.id, {
          phase: 'confirming',
          message: 'This action could not be completed. Confirm again.',
          frozen: null,
        })
        return
      }
      productClient.abandonSyncReplicaIntent(frozen.intentId)
      setRetireDraft(replica.id, {
        phase: 'blocked',
        message: apiError.isAuthRequired
          ? 'Sign in again to stop syncing this browser.'
          : apiError.status === 403
            ? 'You no longer have permission to stop syncing this browser. Refresh the session and try again.'
            : apiError.recoveryHint,
        frozen: null,
      })
    }
  }

  const setRestoreDraft = (id: string, change: Partial<RestoreDraft>) => {
    setRestoreDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? EMPTY_RESTORE), ...change } }))
  }

  const restoreIfMatch = (item: SyncTrashListItem) => quotedEntityTag(item.revision)

  const submitRestore = async (item: SyncTrashListItem, replay = false) => {
    const draft = restoreDrafts[item.deletionId] ?? EMPTY_RESTORE
    let frozen = replay ? draft.frozen : null
    if (!frozen) frozen = { intentId: `sync-trash-restore:${item.deletionId}:${crypto.randomUUID()}`, ifMatch: restoreIfMatch(item) }
    setRestoreDraft(item.deletionId, { phase: 'submitting', message: null, frozen })
    try {
      const receipt = await productClient.restoreSyncTrashItem(item.deletionId, frozen.ifMatch, {
        intentId: frozen.intentId, clearIntentOnSuccess: false, maxRetries: 0,
      })
      productClient.abandonSyncTrashIntent(frozen.intentId)
      if (!mounted.current) return
      if (receipt) {
        setRestoreReceipts((current) => ({ ...current, [item.deletionId]: receipt }))
        setRestoreNotices((current) => { const next = { ...current }; delete next[item.deletionId]; return next })
      }
      setRestoreDraft(item.deletionId, EMPTY_RESTORE)
      await loadTrash(trashCollectionId)
    } catch (error) {
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : new ProductApiError({
        status: 0, code: 'transport_error', message: 'The restore may not have completed.',
        recovery: 'same_request', sameRequestRetrySafe: true,
      })
      const strategy = recoveryStrategyFor(apiError)
      if (strategy === 'retry_same_command') {
        setRestoreDraft(item.deletionId, {
          phase: 'unknown',
          message: 'The restore may not have completed. Try again to confirm the result.',
          frozen,
        })
        return
      }
      if (apiError.status === 410 || apiError.code === 'resource_purged') {
        productClient.abandonSyncTrashIntent(frozen.intentId)
        setRestoreDraft(item.deletionId, {
          phase: 'blocked',
          message: 'This item is no longer restorable.',
          frozen: null,
        })
        return
      }
      if (apiError.status === 404 || apiError.code === 'resource_not_found') {
        productClient.abandonSyncTrashIntent(frozen.intentId)
        await loadTrash(trashCollectionId)
        if (!mounted.current) return
        setRestoreDraft(item.deletionId, EMPTY_RESTORE)
        setRestoreNotices((current) => ({ ...current, [item.deletionId]: 'Already restored.' }))
        return
      }
      if (strategy === 'refresh_and_retry') {
        productClient.abandonSyncTrashIntent(frozen.intentId)
        try {
          const latestItems = await loadTrash(trashCollectionId)
          if (!mounted.current) return
          const latest = latestItems.find((row) => row.deletionId === item.deletionId)
          if (!latest) {
            setRestoreDraft(item.deletionId, EMPTY_RESTORE)
            setRestoreNotices((current) => ({ ...current, [item.deletionId]: 'Already restored.' }))
            return
          }
          setRestoreDraft(item.deletionId, {
            phase: 'stale',
            message: 'This item changed. Refresh the latest version, then restore again.',
            frozen: null,
          })
        } catch {
          setRestoreDraft(item.deletionId, {
            phase: 'blocked',
            message: 'This item changed. Refresh deleted items before restoring again.',
            frozen: null,
          })
        }
        return
      }
      if (strategy === 'new_user_intent') {
        productClient.abandonSyncTrashIntent(frozen.intentId)
        setRestoreDraft(item.deletionId, {
          phase: 'idle',
          message: 'This restore could not be completed. Review the item and try again.',
          frozen: null,
        })
        return
      }
      productClient.abandonSyncTrashIntent(frozen.intentId)
      setRestoreDraft(item.deletionId, {
        phase: 'blocked',
        message: apiError.isAuthRequired
          ? 'Sign in again before restoring this item.'
          : apiError.status === 403
            ? 'You no longer have permission to restore this item.'
            : 'Could not restore this item. It was not removed from the browser.',
        frozen: null,
      })
    }
  }

  const startNewRestore = (item: SyncTrashListItem) => {
    const frozen = restoreDrafts[item.deletionId]?.frozen
    if (frozen) productClient.abandonSyncTrashIntent(frozen.intentId)
    setRestoreDraft(item.deletionId, EMPTY_RESTORE)
  }

  const retryStaleRefresh = async (conflict: SyncConflictSummary) => {
    try {
      const latest = await refreshConflict(conflict.id)
      if (latest) setDraft(conflict.id, { phase: 'stale', message: 'Review the latest server value, then confirm again.', frozen: null })
    } catch {
      setDraft(conflict.id, { phase: 'refresh_required', message: "Couldn't load the latest conflict. Try refreshing it again.", frozen: null })
    }
  }

  return {
    retireDrafts,
    restoreDrafts,
    conflictReceipts,
    restoreReceipts,
    restoreNotices,
    submit,
    startNewIntent,
    startRetire,
    cancelRetire,
    submitRetire,
    submitRestore,
    startNewRestore,
    retryStaleRefresh,
  }
}

export type SyncCenterMutations = ReturnType<typeof useSyncCenterMutations>
