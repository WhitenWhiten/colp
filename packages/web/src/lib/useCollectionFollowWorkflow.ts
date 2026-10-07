import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../api'
import { followIntentErrorPatch } from './followIntentError'

const INVALIDATION_KEY = 'known.collection-follow.invalidate.v1'
const CHANNEL_NAME = 'known.collection-follow.v1'

export type CollectionFollowWorkflowStatus =
  | 'loading'
  | 'ready'
  | 'pending'
  | 'unknown'
  | 'conflict'
  | 'error'
  | 'unavailable'

type CollectionFollowWorkflowState = {
  status: CollectionFollowWorkflowStatus
  following: boolean
  followerCount: number | null
  message: string
  retryKind: 'authority' | 'intent'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isUnexposedFollow(error: unknown): boolean {
  return isProductApiError(error)
    && (error.status === 404 || error.code === 'resource_not_found')
}

export function useCollectionFollowWorkflow(input: {
  actorProfileId: string | null
  collectionId: string | null
  enabled: boolean
}) {
  const { actorProfileId, collectionId, enabled } = input
  const [state, setState] = useState<CollectionFollowWorkflowState>({
    status: 'loading', following: false, followerCount: null,
    message: 'Checking Follow status', retryKind: 'authority',
  })
  const operation = useRef(0)
  const pending = useRef(false)
  const exactIntent = useRef<string | null>(null)
  const authorityController = useRef<AbortController | null>(null)
  const sourceId = useRef(crypto.randomUUID())

  const intentFor = useCallback((following: boolean) => {
    if (!actorProfileId || !collectionId) return ''
    return `collection-follow:${actorProfileId}:${collectionId}:${following ? 'unfollow' : 'follow'}`
  }, [actorProfileId, collectionId])

  const readAuthority = useCallback(async (abandonConflict = false) => {
    if (!enabled || !actorProfileId || !collectionId) return
    /* One authority read in flight at a time: a newer read (scope change,
       retry, cross-tab invalidation, post-mutation refresh) cancels the older
       one, and the mount effect's cleanup cancels the last one on unmount. */
    authorityController.current?.abort()
    const controller = new AbortController()
    authorityController.current = controller
    const current = ++operation.current
    setState((previous) => ({
      ...previous, status: 'loading', message: 'Checking Follow status', retryKind: 'authority',
    }))
    try {
      const authority = await productClient.getCollectionFollowState(collectionId, {
        maxRetries: 0, signal: controller.signal,
      })
      /* Late-response guard: an aborted or superseded read must not paint. */
      if (controller.signal.aborted || current !== operation.current) return
      if (abandonConflict && exactIntent.current) {
        productClient.abandonCollectionFollowIntent(exactIntent.current)
        exactIntent.current = null
      }
      setState({
        status: 'ready',
        following: authority.following,
        followerCount: authority.followerCount,
        message: authority.following ? 'Following' : 'Not following',
        retryKind: 'authority',
      })
    } catch (error) {
      if (controller.signal.aborted || current !== operation.current || isAbortError(error)) return
      if (isUnexposedFollow(error)) {
        setState({
          status: 'unavailable', following: false, followerCount: null,
          message: '', retryKind: 'authority',
        })
        return
      }
      setState((previous) => ({
        ...previous, status: 'error',
        message: isProductApiError(error) ? error.recoveryHint : "Couldn't load the follow status.",
        retryKind: 'authority',
      }))
    } finally {
      if (authorityController.current === controller) authorityController.current = null
    }
  }, [actorProfileId, collectionId, enabled])

  const announceChange = useCallback(() => {
    if (!collectionId) return
    try {
      const value = `${collectionId}:${Date.now()}`
      window.localStorage.setItem(INVALIDATION_KEY, value)
      const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
      channel?.postMessage({ collectionId, sourceId: sourceId.current })
      channel?.close()
    } catch {
      /* Cross-tab invalidation is best effort; every mount still reads authority. */
    }
  }, [collectionId])

  useEffect(() => {
    operation.current += 1
    pending.current = false
    exactIntent.current = null
    if (!enabled || !actorProfileId || !collectionId) return
    void readAuthority()
    /* Unmount and every scope change cancel the in-flight authority read. */
    return () => { authorityController.current?.abort() }
  }, [actorProfileId, collectionId, enabled, readAuthority])

  useEffect(() => {
    if (!enabled || !collectionId) return
    const invalidate = (candidate: string | null) => {
      if (candidate?.startsWith(`${collectionId}:`) || candidate === collectionId) {
        void readAuthority()
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === INVALIDATION_KEY) invalidate(event.newValue)
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
    if (channel) channel.onmessage = (event: MessageEvent<{ collectionId?: string; sourceId?: string }>) => {
      if (event.data?.sourceId === sourceId.current) return
      invalidate(event.data?.collectionId ?? null)
    }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage); channel?.close() }
  }, [collectionId, enabled, readAuthority])

  const runIntent = useCallback(async () => {
    if (pending.current || !actorProfileId || !collectionId) return
    pending.current = true
    const desiredFollowing = !state.following
    const intentId = exactIntent.current ?? intentFor(state.following)
    exactIntent.current = intentId
    setState((previous) => ({
      ...previous, status: 'pending',
      message: desiredFollowing ? 'Following collection' : 'Unfollowing collection',
      retryKind: 'intent',
    }))
    try {
      const mutate = desiredFollowing ? productClient.followCollection : productClient.unfollowCollection
      await mutate(collectionId, { intentId, maxRetries: 0 })
      exactIntent.current = null
      announceChange()
      await readAuthority()
    } catch (error) {
      if (isAbortError(error)) return
      const patch = followIntentErrorPatch(error, 'Follow action failed.')
      setState((previous) => ({ ...previous, ...patch }))
    } finally {
      pending.current = false
    }
  }, [actorProfileId, announceChange, collectionId, intentFor, readAuthority, state.following])

  return {
    ...state,
    toggle: runIntent,
    retryExact: runIntent,
    refresh: () => readAuthority(true),
    retry: () => state.retryKind === 'authority' ? readAuthority() : runIntent(),
  }
}
