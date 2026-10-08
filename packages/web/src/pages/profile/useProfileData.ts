import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { productClient } from '../../api'
import { writeRouteCache } from '../../lib/routeCache'
import {
  emptyActivityList,
  emptyFollowList,
  isAbortError,
  isNotFound,
  profileCacheKey,
  restoredProfile,
} from './helpers'
import {
  FOLLOW_CHANNEL_NAME,
  FOLLOW_INVALIDATION_KEY,
  FOLLOW_PAGE_LIMIT,
  PROFILE_PAGE_LIMIT,
  type ActivityListState,
  type FollowListState,
  type PaginationState,
  type ProfileState,
  type ProfileTab,
} from './types'

const PROFILE_TABS: readonly ProfileTab[] = ['collections', 'activity', 'following', 'followers']

function isProfileTab(value: string | null): value is ProfileTab {
  return value !== null && (PROFILE_TABS as readonly string[]).includes(value)
}

export type ProfilePageData = {
  state: ProfileState
  pagination: PaginationState
  retry: () => void
  loadMore: () => Promise<void>
  collectionLinks: MutableRefObject<Map<string, HTMLAnchorElement>>
  tab: ProfileTab
  setTab: (tab: ProfileTab) => void
  followers: FollowListState
  following: FollowListState
  retryFollowLists: () => void
  loadMoreFollowList: (direction: 'followers' | 'following') => Promise<void>
  activity: ActivityListState
  retryActivity: () => void
  loadMoreActivity: () => Promise<void>
}

export function useProfileData(handle: string, canReadFollowGraph: boolean): ProfilePageData {
  const [state, setState] = useState<ProfileState>(() => restoredProfile(handle))
  const [pagination, setPagination] = useState<PaginationState>('idle')
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [followReloadKey, setFollowReloadKey] = useState(0)
  // The tab lives in ?tab= so a profile section can be linked and survives
  // Back; Collections is the default and keeps the URL clean.
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab')
  const tab: ProfileTab = isProfileTab(rawTab) ? rawTab : 'collections'
  const setTab = useCallback((next: ProfileTab) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current)
      if (next === 'collections') params.delete('tab')
      else params.set('tab', next)
      return params
    }, { replace: false })
  }, [setSearchParams])
  const [followers, setFollowers] = useState<FollowListState>(() => emptyFollowList('unavailable'))
  const [following, setFollowing] = useState<FollowListState>(() => emptyFollowList('unavailable'))
  const [activity, setActivity] = useState<ActivityListState>(() => emptyActivityList('idle'))
  const [activityRetryKey, setActivityRetryKey] = useState(0)
  const requestGeneration = useRef(0)
  const firstPageController = useRef<AbortController | null>(null)
  const paginationController = useRef<AbortController | null>(null)
  const followListController = useRef<AbortController | null>(null)
  const followListProfileId = useRef<string | null>(null)
  const followMoreController = useRef<AbortController | null>(null)
  const activityController = useRef<AbortController | null>(null)
  const activityMoreController = useRef<AbortController | null>(null)
  const collectionLinks = useRef(new Map<string, HTMLAnchorElement>())
  const pendingFocusId = useRef<string | null>(null)
  const readyProfileId = state.status === 'ready' ? state.value.profile.profileId : null
  const readyProfileHandle = state.status === 'ready' ? state.value.profile.handle : null

  useEffect(() => {
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    firstPageController.current?.abort()
    paginationController.current?.abort()
    followListController.current?.abort()
    followMoreController.current?.abort()
    activityController.current?.abort()
    activityMoreController.current?.abort()
    const controller = new AbortController()
    firstPageController.current = controller
    paginationController.current = null
    pendingFocusId.current = null
    collectionLinks.current.clear()
    setPagination('idle')
    setFollowers(emptyFollowList('unavailable'))
    setFollowing(emptyFollowList('unavailable'))
    setActivity(emptyActivityList('idle'))
    // Paint the last page for this handle and revalidate behind it, so a trip
    // out to a collection and back does not replay the whole profile.
    const cached = restoredProfile(handle)
    setState(cached)
    const revalidating = cached.status === 'ready'

    void productClient.getPublicProfilePage(
      handle,
      { limit: PROFILE_PAGE_LIMIT },
      { signal: controller.signal, maxRetries: 0 },
    ).then((value) => {
      if (controller.signal.aborted || requestGeneration.current !== generation) return
      writeRouteCache(profileCacheKey(handle), value)
      setState({ status: 'ready', value })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return
      if (requestGeneration.current !== generation) return
      // A removed profile must surface even if we still hold a page for it;
      // any other failed revalidation keeps what is already rendered.
      if (isNotFound(error)) {
        setState({ status: 'not-found' })
        return
      }
      if (revalidating) return
      setState({ status: 'error' })
    })

    return () => {
      controller.abort()
      paginationController.current?.abort()
      followListController.current?.abort()
      followMoreController.current?.abort()
      activityController.current?.abort()
      activityMoreController.current?.abort()
      if (requestGeneration.current === generation) requestGeneration.current += 1
    }
  }, [handle, retryGeneration])

  useEffect(() => {
    const id = pendingFocusId.current
    if (!id || state.status !== 'ready') return
    const target = collectionLinks.current.get(id)
    if (!target) return
    pendingFocusId.current = null
    target.focus()
  }, [state])

  useEffect(() => {
    followListController.current?.abort()
    followMoreController.current?.abort()
    if (!readyProfileId || !canReadFollowGraph) {
      followListProfileId.current = null
      setFollowers(emptyFollowList('unavailable'))
      setFollowing(emptyFollowList('unavailable'))
      return
    }

    const controller = new AbortController()
    followListController.current = controller
    // A follow/unfollow invalidation revalidates the profile already on
    // screen. Emptying first made the header counts disappear and the
    // Followers/Following tabs blank until the refetch landed, so only a
    // different profile starts from the loading state.
    if (followListProfileId.current !== readyProfileId) {
      followListProfileId.current = readyProfileId
      setFollowers(emptyFollowList('loading'))
      setFollowing(emptyFollowList('loading'))
    }

    void productClient.getFollowersPage(
      readyProfileId,
      { limit: FOLLOW_PAGE_LIMIT },
      { signal: controller.signal, maxRetries: 0 },
    ).then((page) => {
      if (controller.signal.aborted) return
      setFollowers({
        status: 'ready',
        items: page.items,
        nextCursor: page.nextCursor,
        pagination: 'idle',
      })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return
      // A failed revalidation keeps the rows already on screen.
      setFollowers((current) => current.items.length > 0 ? current : emptyFollowList('error'))
    })

    void productClient.getFollowingPage(
      readyProfileId,
      { limit: FOLLOW_PAGE_LIMIT },
      { signal: controller.signal, maxRetries: 0 },
    ).then((page) => {
      if (controller.signal.aborted) return
      setFollowing({
        status: 'ready',
        items: page.items,
        nextCursor: page.nextCursor,
        pagination: 'idle',
      })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return
      setFollowing((current) => current.items.length > 0 ? current : emptyFollowList('error'))
    })

    return () => {
      controller.abort()
    }
  }, [readyProfileId, canReadFollowGraph, followReloadKey])

  useEffect(() => {
    if (!readyProfileId || !canReadFollowGraph) return
    const matches = (candidate: string | null) =>
      candidate === readyProfileId || Boolean(candidate?.startsWith(`${readyProfileId}:`))
    const onStorage = (event: StorageEvent) => {
      if (event.key === FOLLOW_INVALIDATION_KEY && matches(event.newValue)) {
        setFollowReloadKey((value) => value + 1)
      }
    }
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(FOLLOW_CHANNEL_NAME)
    if (channel) {
      channel.onmessage = (event: MessageEvent<{ targetProfileId?: string }>) => {
        if (event.data?.targetProfileId === readyProfileId) {
          setFollowReloadKey((value) => value + 1)
        }
      }
    }
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
      channel?.close()
    }
  }, [readyProfileId, canReadFollowGraph])

  useEffect(() => {
    activityController.current?.abort()
    activityMoreController.current?.abort()
    if (
      tab !== 'activity'
      || !readyProfileHandle
      || readyProfileHandle.toLowerCase() !== handle.toLowerCase()
    ) {
      return
    }

    const controller = new AbortController()
    activityController.current = controller
    const requestedHandle = handle
    setActivity(emptyActivityList('loading'))

    void productClient.getPublicProfileActivity(
      { handle: requestedHandle, limit: PROFILE_PAGE_LIMIT },
      { signal: controller.signal, maxRetries: 0 },
    ).then((page) => {
      if (controller.signal.aborted) return
      setActivity({
        status: 'ready',
        items: page.items,
        nextCursor: page.nextCursor,
        pagination: 'idle',
      })
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return
      setActivity(emptyActivityList('error'))
    })

    return () => {
      controller.abort()
    }
  }, [tab, handle, readyProfileHandle, activityRetryKey])

  const retry = useCallback(() => {
    setRetryGeneration((value) => value + 1)
  }, [])

  const retryFollowLists = useCallback(() => {
    setFollowReloadKey((value) => value + 1)
  }, [])

  const retryActivity = useCallback(() => {
    setActivityRetryKey((value) => value + 1)
  }, [])

  const loadMore = useCallback(async () => {
    if (state.status !== 'ready' || pagination === 'loading') return
    const cursor = state.value.page.cursor
    if (!state.value.page.hasMore || !cursor) return

    paginationController.current?.abort()
    const controller = new AbortController()
    paginationController.current = controller
    const generation = requestGeneration.current
    const requestedHandle = handle
    setPagination('loading')

    try {
      const next = await productClient.getPublicProfilePage(
        requestedHandle,
        { limit: PROFILE_PAGE_LIMIT, cursor },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (
        controller.signal.aborted
        || requestGeneration.current !== generation
        || requestedHandle !== handle
      ) return
      const continuationIsInvalid = next.profile.handle !== state.value.profile.handle
        || (next.page.hasMore
          ? !next.page.cursor || next.page.cursor === cursor
          : next.page.cursor !== null)
      if (continuationIsInvalid) throw new Error('Invalid public Profile continuation')

      setState((current) => {
        if (current.status !== 'ready') return current
        const seen = new Set(current.value.collections.map(({ id }) => id))
        const additions = next.collections.filter(({ id }) => !seen.has(id))
        pendingFocusId.current = additions[0]?.id ?? null
        return {
          status: 'ready',
          value: {
            profile: next.profile,
            collections: [...current.value.collections, ...additions],
            page: next.page,
          },
        }
      })
      setPagination('idle')
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      if (requestGeneration.current !== generation || requestedHandle !== handle) return
      setPagination('error')
    }
  }, [handle, pagination, state])

  const loadMoreFollowList = useCallback(async (direction: 'followers' | 'following') => {
    if (!readyProfileId) return
    const list = direction === 'followers' ? followers : following
    if (list.status !== 'ready' || list.pagination === 'loading' || !list.nextCursor) return

    followMoreController.current?.abort()
    const controller = new AbortController()
    followMoreController.current = controller
    const requestedProfileId = readyProfileId
    const cursor = list.nextCursor
    const setList = direction === 'followers' ? setFollowers : setFollowing
    setList((current) => ({ ...current, pagination: 'loading' }))

    try {
      const query = { cursor }
      const next = direction === 'followers'
        ? await productClient.getFollowersPage(requestedProfileId, query, { signal: controller.signal, maxRetries: 0 })
        : await productClient.getFollowingPage(requestedProfileId, query, { signal: controller.signal, maxRetries: 0 })
      if (controller.signal.aborted || requestedProfileId !== readyProfileId) return
      setList((current) => {
        const seen = new Set(current.items.map((person) => person.profileId))
        const additions = next.items.filter((person) => !seen.has(person.profileId))
        return {
          status: 'ready',
          items: [...current.items, ...additions],
          nextCursor: next.nextCursor,
          pagination: 'idle',
        }
      })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      if (requestedProfileId !== readyProfileId) return
      setList((current) => ({ ...current, pagination: 'error' }))
    }
  }, [followers, following, readyProfileId])

  const loadMoreActivity = useCallback(async () => {
    if (activity.status !== 'ready' || activity.pagination === 'loading' || !activity.nextCursor) return

    activityMoreController.current?.abort()
    const controller = new AbortController()
    activityMoreController.current = controller
    const requestedHandle = handle
    const cursor = activity.nextCursor
    setActivity((current) => ({ ...current, pagination: 'loading' }))

    try {
      const next = await productClient.getPublicProfileActivity(
        { handle: requestedHandle, cursor },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestedHandle !== handle) return
      setActivity((current) => {
        const seen = new Set(current.items.map((item) => item.activityId))
        const additions = next.items.filter((item) => !seen.has(item.activityId))
        return {
          status: 'ready',
          items: [...current.items, ...additions],
          nextCursor: next.nextCursor,
          pagination: 'idle',
        }
      })
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return
      if (requestedHandle !== handle) return
      setActivity((current) => ({ ...current, pagination: 'error' }))
    }
  }, [activity, handle])

  return {
    state,
    pagination,
    retry,
    loadMore,
    collectionLinks,
    tab,
    setTab,
    followers,
    following,
    retryFollowLists,
    loadMoreFollowList,
    activity,
    retryActivity,
    loadMoreActivity,
  }
}
