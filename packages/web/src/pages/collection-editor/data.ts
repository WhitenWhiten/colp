import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import {
  isProductApiError,
  productClient,
  type EditorSnapshot,
} from '../../api'
import type { CursorRecoveryReason, EditorBanner, LoadState } from './types'

export function useCollectionEditorSnapshot(options: {
  collectionId: string | undefined
  isLoggedIn: boolean
  bootstrapping: boolean
  navigate: NavigateFunction
  onSnapshotReadyRef: MutableRefObject<(snap: EditorSnapshot, preserveUserIntent: boolean) => void>
}) {
  const { collectionId, isLoggedIn, bootstrapping, navigate, onSnapshotReadyRef } = options

  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [banner, setBanner] = useState<EditorBanner | null>(null)
  const preserveEditDraftRef = useRef(false)
  const loadRequestRef = useRef<{ generation: number; controller: AbortController } | null>(null)
  const activeCollectionIdRef = useRef(collectionId)
  activeCollectionIdRef.current = collectionId

  const reload = useCallback(
    async (opts?: {
      silent?: boolean
      preserveUserIntent?: boolean
      recoveryReason?: CursorRecoveryReason
    }) => {
      if (!collectionId || activeCollectionIdRef.current !== collectionId) return
      loadRequestRef.current?.controller.abort()
      const request = {
        generation: (loadRequestRef.current?.generation ?? 0) + 1,
        controller: new AbortController(),
      }
      loadRequestRef.current = request
      const isCurrent = () => loadRequestRef.current === request && activeCollectionIdRef.current === collectionId
      if (!opts?.silent) setLoad({ status: 'loading' })
      setBanner(null)
      preserveEditDraftRef.current = opts?.preserveUserIntent === true
      let paginationRecoveryReason: CursorRecoveryReason | undefined
      try {
        const snap = await productClient.loadEditorSnapshot(collectionId, {
          signal: request.controller.signal,
          onCursorRestart: ({ reason }) => {
            if (isCurrent()) paginationRecoveryReason = reason
          },
        })
        if (!isCurrent()) return
        setLoad({ status: 'ready', snap })
        // Hydration is not part of the load: left inside this try, an exception
        // while applying a SUCCESSFUL snapshot is classified by the catch below
        // as a load failure and renders "Couldn't load this collection" with the raw
        // internal message. It must stay VISIBLE though — swallowing it would
        // leave the editor showing a partially-applied snapshot with no
        // indication that anything went wrong.
        try {
          onSnapshotReadyRef.current(snap, opts?.preserveUserIntent === true)
        } catch (hydrationError) {
          if (!isCurrent()) return
          setLoad({
            status: 'error',
            error: hydrationError instanceof Error ? hydrationError : new Error(String(hydrationError)),
            hint: 'This collection loaded, but part of it could not be prepared for editing.',
          })
        }
        const recoveryReason = opts?.recoveryReason ?? paginationRecoveryReason
        if (recoveryReason) {
          const draftStatus = opts?.preserveUserIntent
            ? ' Unsaved form values were kept for review and were not submitted.'
            : ''
          setBanner({
            message: recoveryReason === 'snapshot_expired'
              ? `The snapshot expired. Reloaded from the first page.${draftStatus}`
              : `The page expired while loading. Reloaded from the first page.${draftStatus}`,
            action: opts?.preserveUserIntent ? 'review_drafts' : 'refresh',
          })
        }
      } catch (err) {
        if (!isCurrent() || request.controller.signal.aborted) return
        preserveEditDraftRef.current = false
        const error = err instanceof Error ? err : new Error(String(err))
        const hint = isProductApiError(err) ? err.recoveryHint : 'Try again in a moment.'
        setLoad({ status: 'error', error, hint })
        if (isProductApiError(err) && err.isAuthRequired) {
          // F3 legacy cleanup: the legacy OIDC entry is gone; send the user
          // to the Better Auth login page with a same-origin returnTo.
          navigate(`/login?returnTo=${encodeURIComponent(`/library/${collectionId}`)}`)
        }
      } finally {
        if (isCurrent()) loadRequestRef.current = null
      }
    },
    [collectionId, navigate, onSnapshotReadyRef],
  )

  useEffect(() => {
    if (bootstrapping) return
    if (!isLoggedIn) return
    void reload()
    return () => {
      loadRequestRef.current?.controller.abort()
    }
  }, [bootstrapping, isLoggedIn, collectionId, reload])

  const snap = load.status === 'ready' ? load.snap : null

  return {
    load,
    setLoad,
    snap,
    banner,
    setBanner,
    reload,
    preserveEditDraftRef,
  }
}

export type CollectionEditorSnapshot = ReturnType<typeof useCollectionEditorSnapshot>
