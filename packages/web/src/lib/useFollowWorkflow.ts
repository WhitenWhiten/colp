import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../api'
import { followIntentErrorPatch } from './followIntentError'

const INVALIDATION_KEY = 'known.follow.invalidate.v1'
const CHANNEL_NAME = 'known.follow.v1'

export type FollowWorkflowStatus =
  | 'loading'
  | 'ready'
  | 'pending'
  | 'unknown'
  | 'conflict'
  | 'error'

type FollowWorkflowState = {
  status: FollowWorkflowStatus
  following: boolean
  message: string
  retryKind: 'authority' | 'intent'
}

export function useFollowWorkflow(input: {
  actorProfileId: string | null
  targetProfileId: string | null
  enabled: boolean
}) {
  const { actorProfileId, targetProfileId, enabled } = input
  const [state, setState] = useState<FollowWorkflowState>({
    status: 'loading', following: false, message: 'Checking Follow status', retryKind: 'authority',
  })
  const operation = useRef(0)
  const pending = useRef(false)
  const exactIntent = useRef<string | null>(null)
  const sourceId = useRef(crypto.randomUUID())

  const intentFor = useCallback((following: boolean) => {
    if (!actorProfileId || !targetProfileId) return ''
    return `follow:${actorProfileId}:${targetProfileId}:${following ? 'unfollow' : 'follow'}`
  }, [actorProfileId, targetProfileId])

  const readAuthority = useCallback(async (abandonConflict = false) => {
    if (!enabled || !actorProfileId || !targetProfileId) return
    const current = ++operation.current
    setState((previous) => ({
      ...previous, status: 'loading', message: 'Checking Follow status', retryKind: 'authority',
    }))
    try {
      const following = await productClient.isFollowingProfile(
        actorProfileId, targetProfileId, { maxRetries: 0 },
      )
      if (current !== operation.current) return
      if (abandonConflict && exactIntent.current) {
        productClient.abandonFollowIntent(exactIntent.current)
        exactIntent.current = null
      }
      setState({
        status: 'ready', following,
        message: following ? 'Following' : 'Not following', retryKind: 'authority',
      })
    } catch (error) {
      if (current !== operation.current) return
      setState((previous) => ({
        ...previous, status: 'error',
        message: isProductApiError(error) ? error.recoveryHint : "Couldn't load the follow status.",
        retryKind: 'authority',
      }))
    }
  }, [actorProfileId, enabled, targetProfileId])

  const announceChange = useCallback(() => {
    if (!targetProfileId) return
    try {
      const value = `${targetProfileId}:${Date.now()}`
      window.localStorage.setItem(INVALIDATION_KEY, value)
      const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
      channel?.postMessage({ targetProfileId, sourceId: sourceId.current })
      channel?.close()
    } catch {
      /* Cross-tab invalidation is best effort; every mount still reads authority. */
    }
  }, [targetProfileId])

  useEffect(() => {
    operation.current += 1
    pending.current = false
    exactIntent.current = null
    if (!enabled || !actorProfileId || !targetProfileId) return
    void readAuthority()
  }, [actorProfileId, enabled, readAuthority, targetProfileId])

  useEffect(() => {
    if (!enabled || !targetProfileId) return
    const invalidate = (candidate: string | null) => {
      if (candidate?.startsWith(`${targetProfileId}:`) || candidate === targetProfileId) {
        void readAuthority()
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === INVALIDATION_KEY) invalidate(event.newValue)
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
    if (channel) channel.onmessage = (event: MessageEvent<{ targetProfileId?: string; sourceId?: string }>) => {
      if (event.data?.sourceId === sourceId.current) return
      invalidate(event.data?.targetProfileId ?? null)
    }
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage); channel?.close() }
  }, [enabled, readAuthority, targetProfileId])

  const runIntent = useCallback(async () => {
    if (pending.current || !actorProfileId || !targetProfileId) return
    pending.current = true
    const desiredFollowing = !state.following
    const intentId = exactIntent.current ?? intentFor(state.following)
    exactIntent.current = intentId
    setState((previous) => ({
      ...previous, status: 'pending',
      message: desiredFollowing ? 'Following profile' : 'Unfollowing profile',
      retryKind: 'intent',
    }))
    try {
      const mutate = desiredFollowing ? productClient.followProfile : productClient.unfollowProfile
      await mutate(targetProfileId, { intentId, maxRetries: 0 })
      exactIntent.current = null
      announceChange()
      await readAuthority()
    } catch (error) {
      const patch = followIntentErrorPatch(error, 'Follow action failed.')
      setState((previous) => ({ ...previous, ...patch }))
    } finally {
      pending.current = false
    }
  }, [actorProfileId, announceChange, intentFor, readAuthority, state.following, targetProfileId])

  return {
    ...state,
    toggle: runIntent,
    retryExact: runIntent,
    refresh: () => readAuthority(true),
    retry: () => state.retryKind === 'authority' ? readAuthority() : runIntent(),
  }
}
