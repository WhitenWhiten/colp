import type { ExploreCollection } from '../api'
import type { CollectionKind } from '../api/types'
import type { Collection } from '../types/catalog'
import { formatDate } from './formatDate'

/** Matches the backend restrict_publication creator sentinel. Not a profile or mute key. */
const EXPLORE_UNKNOWN_CREATOR_ID = 'unknown'

/** Shared card shape for live Explore collections (Landing, Share, Explore). */
export type ExploreCard = Omit<Collection, 'resources' | 'followers'> & {
  updatedAt: string
  followers?: number
  viewCount?: number
  curatorAvatar?: string | null
  kind?: CollectionKind
  /** Latest public collection tldr (curator recommendation), when present. */
  curatorNote?: string | null
  /** True on a moderation tombstone (#21): the card keeps its slot, inert. */
  hiddenPublic?: boolean
  /** BCP language tag — feeds the Explore language picker's options. */
  language?: string | null
}

export function mapExploreItem(item: ExploreCollection): ExploreCard {
  const creator = item.creators[0]
  const restricted = creator?.id === EXPLORE_UNKNOWN_CREATOR_ID
  return {
    id: item.id,
    slug: item.publicationSlug ?? '',
    title: item.title,
    description: item.summary ?? '',
    curator: restricted ? 'Unknown' : (creator?.name ?? 'Unknown'),
    curatorHandle: restricted ? '' : (creator?.handle ?? ''),
    curatorAvatar: restricted ? null : (creator?.avatar ?? null),
    tags: item.tags,
    kind: item.kind as CollectionKind,
    viewCount: item.viewCount ?? 0,
    links: item.nodeCount,
    updated: formatDate(item.updatedAt),
    updatedAt: item.updatedAt,
    public: item.visibility === 'public',
    curatorNote: item.curatorNote ?? null,
    language: item.language ?? null,
    ...(item.hiddenPublic === true ? { hiddenPublic: true } : {}),
  }
}
