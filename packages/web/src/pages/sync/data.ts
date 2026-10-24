import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { markServerFeatureAvailable, markServerFeatureUnavailable } from '../../lib/serverFeatureAvailability'
import {
  ProductApiError,
  productClient,
  type SyncConflictSummary,
  type SyncStatusView,
  type SyncTrashDetail,
  type SyncTrashListItem,
} from '../../api'
import { initialDraft, quotedEntityTag } from './fields'
import type { ConflictDraft } from './types'
import { privateSessionIdentity, subscribeSession } from '../../api/sessionStore'

export function useSyncCenterData() {
  const sessionIdentity = useSyncExternalStore(subscribeSession, privateSessionIdentity, privateSessionIdentity)
  const [status, setStatus] = useState<SyncStatusView | null>(null)
  const [conflicts, setConflicts] = useState<SyncConflictSummary[]>([])
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [conflictsLoading, setConflictsLoading] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, ConflictDraft>>({})
  const [trashItems, setTrashItems] = useState<SyncTrashListItem[]>([])
  const [trashCollectionTitles, setTrashCollectionTitles] = useState<Record<string, string>>({})
  const [trashCollectionId, setTrashCollectionId] = useState<string | null>(null)
  const [trashDetails, setTrashDetails] = useState<Record<string, SyncTrashDetail>>({})
  const [trashError, setTrashError] = useState<string | null>(null)
  const [trashErrorKind, setTrashErrorKind] = useState<'auth' | 'stale' | 'other' | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadErrorKind, setLoadErrorKind] = useState<'auth' | 'unavailable' | 'other' | null>(null)
  const mounted = useRef(true)
  const renderedIdentityRef = useRef(sessionIdentity)
  const selectedCollection = useRef<string | null>(null)
  const conflictHeading = useRef<HTMLHeadingElement>(null)
  const restoreConflictFocus = useRef(false)

  const applyConflicts = useCallback((items: SyncConflictSummary[]) => {
    setConflicts(items)
    setDrafts((current) => Object.fromEntries(items.map((item) => [item.id, current[item.id] ?? initialDraft(item)])))
  }, [])

  const loadTrash = useCallback(async (collectionId: string | null, signal?: AbortSignal): Promise<SyncTrashListItem[]> => {
    const requestIdentity = sessionIdentity
    selectedCollection.current = collectionId
    setTrashCollectionId(collectionId)
    setTrashError(null)
    setTrashErrorKind(null)
    if (!collectionId) {
      setTrashItems([])
      setTrashDetails({})
      return []
    }
    try {
      const items = await productClient.loadSyncTrash({ collectionId, signal, maxRetries: 0, limit: 20 })
      if (signal?.aborted || !mounted.current || selectedCollection.current !== collectionId
        || privateSessionIdentity() !== requestIdentity) return items
      setTrashItems(items)
      setTrashDetails((current) => Object.fromEntries(items.flatMap((item) => {
        const detail = current[item.deletionId]
        return detail ? [[item.deletionId, { ...detail, revision: item.revision, etag: quotedEntityTag(item.revision) }]] : []
      })))
      return items
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return []
      if (!mounted.current || selectedCollection.current !== collectionId
        || privateSessionIdentity() !== requestIdentity) return []
      const apiError = error instanceof ProductApiError ? error : null
      if (apiError?.status === 404 || apiError?.code === 'resource_not_found') {
        setTrashItems([])
        setTrashDetails({})
        setTrashError(null)
        return []
      }
      if (apiError?.code === 'invalid_cursor' || apiError?.code === 'snapshot_expired' || apiError?.code === 'sync_cursor_expired') {
        setTrashItems([])
        setTrashDetails({})
        setTrashErrorKind('stale')
        setTrashError('This list is out of date. Refresh to load deleted items again.')
        return []
      }
      setTrashItems([])
      setTrashErrorKind(apiError?.isAuthRequired ? 'auth' : 'other')
      setTrashError(apiError?.isAuthRequired
        ? 'Sign in again to view deleted items.'
        : apiError?.recoveryHint ?? "Couldn't load deleted items")
      return []
    }
  }, [sessionIdentity])

  /* Every load takes a generation. The abort signal alone cannot order the
     refreshes: view.tsx calls load('refresh') with NO signal, so an older read
     that rejects after a newer one resolved would paint its error over the newer
     status — the last-write-wins the signal guard cannot see. */
  const loadGenerationRef = useRef(0)
  const load = useCallback(async (kind: 'initial' | 'refresh', signal?: AbortSignal) => {
    const requestIdentity = sessionIdentity
    const generation = ++loadGenerationRef.current
    const superseded = () => signal?.aborted === true || generation !== loadGenerationRef.current
      || privateSessionIdentity() !== requestIdentity
    if (kind === 'initial') setLoading(true)
    else setRefreshing(true)
    setLoadError(null)
    setLoadErrorKind(null)
    const current = () => !superseded() && mounted.current
    setConflictError(null); setConflictsLoading(true)
    // These panels are independent recovery surfaces. A slow/broken conflict
    // or library read must never withhold device commands.
    const conflictsRequest = productClient.loadSyncConflicts({ signal, maxRetries: 0, limit: 25 })
      .then(items => { if (current()) applyConflicts(items) })
      .catch(() => { if (current()) setConflictError('Couldn’t load browser conflicts. Refresh to try again.') })
      .finally(() => { if (current()) setConflictsLoading(false) })
    const libraryRequest = productClient.getLibrary({ signal, maxRetries: 0 })
      .then(async library => {
        if (!current()) return
        setTrashCollectionTitles({ [library.id]: library.title })
        await loadTrash(library.id, signal)
      }).catch(() => {
        if (current()) { setTrashErrorKind('other'); setTrashError('Couldn’t load the library. Refresh to try again.') }
      })
    try {
      const nextStatus = await productClient.getSyncStatus({ signal, maxRetries: 0 })
      if (!current()) return
      markServerFeatureAvailable('sync')
      setStatus(nextStatus)
    } catch (error) {
      // An older request must not replace the live request's error state,
      // including refreshes without an AbortSignal.
      if (superseded()) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (!mounted.current) return
      const apiError = error instanceof ProductApiError ? error : null
      if (apiError?.status === 404) markServerFeatureUnavailable('sync')
      setLoadErrorKind(apiError?.isAuthRequired ? 'auth'
        : apiError?.status === 404 ? 'unavailable' : 'other')
      setLoadError(apiError?.isAuthRequired
        ? 'Sign in again to view Sync status.'
        : apiError?.status === 403 ? 'You do not have access to the sync center.'
          : apiError?.recoveryHint ?? 'Check that the server is reachable, then try again.')
    } finally {
      // Clearing the busy flags is what re-enables the retry button, so a
      // superseded pass must still do it for its OWN request but must not stomp
      // the live pass's state.
      if (superseded()) return
      if (mounted.current) { setLoading(false); setRefreshing(false) }
    }
    await Promise.all([conflictsRequest, libraryRequest])
  }, [applyConflicts, loadTrash, sessionIdentity])

  useEffect(() => {
    renderedIdentityRef.current = sessionIdentity
    mounted.current = true
    setConflictError(null); setConflictsLoading(true)
    setStatus(null); setConflicts([]); setDrafts({}); setTrashItems([]); setTrashDetails({});
    setTrashCollectionTitles({}); setTrashCollectionId(null)
    setLoadError(null); setLoadErrorKind(null); setTrashError(null); setTrashErrorKind(null)
    const controller = new AbortController()
    void load('initial', controller.signal)
    return () => { mounted.current = false; controller.abort() }
  }, [load, sessionIdentity])

  useEffect(() => {
    if (!restoreConflictFocus.current) return
    conflictHeading.current?.focus()
    restoreConflictFocus.current = false
  }, [conflicts])

  const setDraft = (id: string, change: Partial<ConflictDraft>) => {
    const conflict = conflicts.find((item) => item.id === id)
    if (!conflict) return
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? initialDraft(conflict)), ...change } }))
  }

  const refreshConflict = async (conflictId: string): Promise<SyncConflictSummary | null> => {
    const requestIdentity = sessionIdentity
    const items = await productClient.loadSyncConflicts({ maxRetries: 0, limit: 25 })
    if (!mounted.current || privateSessionIdentity() !== requestIdentity) return null
    if (!items.some((item) => item.id === conflictId)) restoreConflictFocus.current = true
    applyConflicts(items)
    return items.find((item) => item.id === conflictId) ?? null
  }

  const revealTrashUrl = async (deletionId: string) => {
    const requestIdentity = sessionIdentity
    try {
      const detail = await productClient.getSyncTrashItem(deletionId, { maxRetries: 0 })
      if (!mounted.current || privateSessionIdentity() !== requestIdentity) return
      setTrashDetails((current) => ({ ...current, [deletionId]: detail }))
    } catch (error) {
      if (!mounted.current || privateSessionIdentity() !== requestIdentity) return
      const apiError = error instanceof ProductApiError ? error : null
      if (apiError?.status === 404 || apiError?.code === 'resource_not_found' || apiError?.code === 'resource_purged') {
        await loadTrash(selectedCollection.current)
        return
      }
      setTrashErrorKind(apiError?.isAuthRequired ? 'auth' : 'other')
      setTrashError(apiError?.isAuthRequired
        ? 'Sign in again to view deleted items.'
        : "Couldn't load deleted item details")
    }
  }

  const selectTrashCollection = (collectionId: string) => {
    void loadTrash(collectionId)
  }

  const identityReady = renderedIdentityRef.current === sessionIdentity
  return {
    status: identityReady ? status : null,
    setStatus,
    conflicts: identityReady ? conflicts : [],
    setConflicts,
    conflictError: identityReady ? conflictError : null,
    conflictsLoading: identityReady ? conflictsLoading : true,
    drafts: identityReady ? drafts : {},
    setDrafts,
    trashItems: identityReady ? trashItems : [],
    setTrashItems,
    trashCollectionTitles: identityReady ? trashCollectionTitles : {},
    trashCollectionId: identityReady ? trashCollectionId : null,
    trashDetails: identityReady ? trashDetails : {},
    trashError: identityReady ? trashError : null,
    trashErrorKind: identityReady ? trashErrorKind : null,
    loading: identityReady ? loading : true,
    refreshing: identityReady ? refreshing : false,
    loadError: identityReady ? loadError : null,
    loadErrorKind: identityReady ? loadErrorKind : null,
    mounted,
    conflictHeading,
    restoreConflictFocus,
    load,
    loadTrash,
    setDraft,
    refreshConflict,
    revealTrashUrl,
    selectTrashCollection,
  }
}

export type SyncCenterData = ReturnType<typeof useSyncCenterData>
