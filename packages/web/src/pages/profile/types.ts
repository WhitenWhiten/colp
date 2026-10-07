import { productClient, type ProfileSummary, type PublicProfilePage } from '../../api'

export const PROFILE_PAGE_LIMIT = 24
export const FOLLOW_PAGE_LIMIT = 100
export const FOLLOW_INVALIDATION_KEY = 'known.follow.invalidate.v1'
export const FOLLOW_CHANNEL_NAME = 'known.follow.v1'

export type ProfileState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error' }
  | { status: 'ready'; value: PublicProfilePage }

export type PaginationState = 'idle' | 'loading' | 'error'
export type ProfileMode = 'profile' | 'journal'
export type ProfileTab = 'collections' | 'activity' | 'following' | 'followers'

export type FollowListState = {
  status: 'unavailable' | 'loading' | 'error' | 'ready'
  items: ProfileSummary[]
  nextCursor: string | null
  pagination: PaginationState
}

export type PublicProfileActivityPage = Awaited<ReturnType<typeof productClient.getPublicProfileActivity>>
export type PublicProfileActivityItem = PublicProfileActivityPage['items'][number]

export type ActivityListState = {
  status: 'idle' | 'loading' | 'error' | 'ready'
  items: PublicProfileActivityItem[]
  nextCursor: string | null
  pagination: PaginationState
}
