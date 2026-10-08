/* CS-01 community vote workflow shared by the four target pages
   (collection, bookmark, digest series, digest edition). Resolves the live
   target + vote state through productClient.resolveCommunityTarget, submits
   durable votes through setCommunityVote with a stable intent/command id per
   (target, generation, desired value), and routes revision_conflict to a
   fresh target resolution — the next explicit click is the user's
   confirmation on the new generation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../api'
import type { CommunityTarget, CommunityTargetQuery, CommunityTargetView } from '../api'
import { followIntentErrorPatch } from './followIntentError'

export type CommunityVoteStatus =
  | 'loading'
  | 'ready'
  | 'pending'
  | 'unknown'
  | 'conflict'
  | 'error'
  | 'unavailable'

export type CommunityVoteState = {
  status: CommunityVoteStatus
  /** Resolved view (target identity incl. server generation, counts, flags). */
  view: CommunityTargetView | null
  myVote: -1 | 0 | 1 | null
  up: number | null
  down: number | null
  canVote: boolean
  message: string
  retryKind: 'authority' | 'intent'
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isUnexposedCommunity(error: unknown): boolean {
  return isProductApiError(error)
    && (error.status === 404 || error.code === 'resource_not_found')
}

function isRevisionConflict(error: unknown): boolean {
  return isProductApiError(error) && error.code === 'revision_conflict'
}

function queryKey(query: CommunityTargetQuery): string {
  return `${query.kind}:${query.id}:${query.collectionId ?? ''}:${query.seriesId ?? ''}`
}

export function useCommunityVote(input: {
  /** Target selector; null keeps the hook idle (page not ready / no target). */
  query: CommunityTargetQuery | null
  /** Exposure gate: feature flag + page readiness. */
  enabled: boolean
}) {
  const { query, enabled } = input
  const [state, setState] = useState<CommunityVoteState>({
    status: 'loading', view: null, myVote: null, up: null, down: null,
    canVote: false, message: 'Resolving community target', retryKind: 'authority',
  })
  const operation = useRef(0)
  const pending = useRef(false)
  const pendingDirection = useRef<1 | -1>(1)
  const exactIntent = useRef<string | null>(null)

  const readAuthority = useCallback(async (abandonConflict = false) => {
    if (!enabled || !query) return
    const current = ++operation.current
    setState((previous) => ({
      ...previous, status: 'loading', message: 'Resolving community target', retryKind: 'authority',
    }))
    try {
      const view = await productClient.resolveCommunityTarget(query, { maxRetries: 0 })
      if (current !== operation.current) return
      if (abandonConflict && exactIntent.current) {
        productClient.abandonCommunityVoteIntent(exactIntent.current)
        exactIntent.current = null
      }
      setState({
        status: 'ready',
        view,
        myVote: view.votes.myVote,
        up: view.votes.up,
        down: view.votes.down,
        canVote: view.canVote,
        message: 'Community vote state resolved',
        retryKind: 'authority',
      })
    } catch (error) {
      if (current !== operation.current || isAbortError(error)) return
      if (isUnexposedCommunity(error)) {
        setState({
          status: 'unavailable', view: null, myVote: null, up: null, down: null,
          canVote: false, message: '', retryKind: 'authority',
        })
        return
      }
      setState((previous) => ({
        ...previous, status: 'error',
        message: isProductApiError(error) ? error.recoveryHint : "Couldn't load community votes.",
        retryKind: 'authority',
      }))
    }
  }, [query?.kind, query?.id, query?.collectionId, query?.seriesId, enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    operation.current += 1
    pending.current = false
    exactIntent.current = null
    if (!enabled || !query) {
      setState({
        status: 'loading', view: null, myVote: null, up: null, down: null,
        canVote: false, message: 'Resolving community target', retryKind: 'authority',
      })
      return
    }
    void readAuthority()
  }, [queryKey(query ?? { kind: 'collection', id: '' }), enabled, readAuthority]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Desired value for a click: toggling the active vote removes it (0). */
  const desiredFor = useCallback((direction: 1 | -1): -1 | 0 | 1 => (
    state.myVote === direction ? 0 : direction
  ), [state.myVote])

  const runVote = useCallback(async (direction: 1 | -1) => {
    if (pending.current || !query) return
    const target = state.view?.target
    if (!target || state.canVote !== true) return
    const desired = desiredFor(direction)
    pending.current = true
    pendingDirection.current = direction
    /* One intent id per (target identity incl. generation, desired value):
       an exact request retry reuses the command id; a generation change is
       a different intent and allocates a fresh command id. */
    const intentId = exactIntent.current
      ?? `community-vote:${target.kind}:${target.id}:${target.generation}:${desired}`
    exactIntent.current = intentId
    setState((previous) => ({
      ...previous, status: 'pending',
      message: desired === 0 ? 'Removing vote' : desired === 1 ? 'Upvoting' : 'Downvoting',
      retryKind: 'intent',
    }))
    try {
      const result = await productClient.setCommunityVote(
        target as CommunityTarget, desired, { intentId, maxRetries: 0 },
      )
      exactIntent.current = null
      /* The vote response carries the authoritative post-write state; apply
         it without a second resolve round-trip. */
      setState((previous) => ({
        ...previous,
        status: 'ready',
        view: previous.view
          ? { ...previous.view, votes: result, canVote: previous.view.canVote }
          : previous.view,
        myVote: result.myVote,
        up: result.up,
        down: result.down,
        message: 'Vote recorded',
        retryKind: 'authority',
      }))
    } catch (error) {
      if (isAbortError(error)) return
      if (isRevisionConflict(error)) {
        /* Stale generation: re-resolve the target. The user's next click on
           the fresh view is the contract's confirmation. */
        exactIntent.current = null
        setState((previous) => ({
          ...previous, status: 'conflict', retryKind: 'authority',
          message: 'This target changed. Refresh to see the latest votes, then vote again.',
        }))
        return
      }
      const patch = followIntentErrorPatch(error, 'Vote action failed.')
      setState((previous) => ({ ...previous, ...patch }))
    } finally {
      pending.current = false
    }
  }, [desiredFor, query, state.canVote, state.view?.target])

  const retry = useCallback(async () => {
    if (state.retryKind === 'authority') {
      await readAuthority(state.status === 'conflict')
      return
    }
    /* Exact-intent retry: same direction → same desired value (myVote is
       unchanged) → same intent id → same durable command id. */
    await runVote(pendingDirection.current)
  }, [readAuthority, runVote, state.retryKind, state.status])

  return {
    ...state,
    vote: runVote,
    refresh: () => readAuthority(true),
    retry,
  }
}
