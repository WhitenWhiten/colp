import { describe, expect, it } from 'vitest'
import { feedItemCanonicalPath, itemBody, itemTitle } from './feedItemCopy'

const actor = { profileId: 'p1', handle: 'mira.writer', displayName: 'Mira', avatarUrl: null }
const collectionItem = {
  feedItemId: 'f1', kind: 'collection_change' as const, collectionId: 'public-id', actor,
  publishedAt: '2026-07-29T08:00:00.000Z', publicationSlug: 'llm-learning-path', collectionTitle: 'LLM learning path',
}
const unpublishedCollectionItem = {
  feedItemId: 'f-unpublished', kind: 'collection_change' as const, collectionId: 'public-id', actor,
  publishedAt: '2026-07-29T08:00:00.000Z', publicationSlug: null, collectionTitle: null,
}
const encodedSlugItem = {
  ...collectionItem, feedItemId: 'f-encoded', publicationSlug: 'llm/learning-path',
}
const followItem = { feedItemId: 'f2', kind: 'follow_activity' as const, collectionId: null, actor, publishedAt: '2026-07-29T07:00:00.000Z' }

describe('feedItemCopy', () => {
  it('keeps title gold sentences and public canonical paths independent of summary', () => {
    expect(feedItemCanonicalPath(collectionItem)).toBe('/c/llm-learning-path')
    expect(feedItemCanonicalPath(unpublishedCollectionItem)).toBe('/u/mira.writer')
    expect(feedItemCanonicalPath(unpublishedCollectionItem)).not.toBe('/c/public-id')
    expect(feedItemCanonicalPath(encodedSlugItem)).toBe(`/c/${encodeURIComponent('llm/learning-path')}`)
    expect(feedItemCanonicalPath(followItem)).toBe('/u/mira.writer')
    expect(itemTitle(collectionItem)).toBe('Mira updated LLM learning path')
    expect(itemTitle(unpublishedCollectionItem)).toBe('Mira updated a public collection')
    expect(itemTitle(followItem)).toBe('Mira followed your work')
  })

  it('maps only public_collection_updated collection changes to body copy', () => {
    expect(itemBody({ ...collectionItem, summary: 'public_collection_updated' })).toBe(
      'Resources or path order changed in this public collection.',
    )
    expect(itemBody({ ...followItem, summary: 'new_follower' })).toBeNull()
    expect(itemBody({ ...collectionItem, summary: null })).toBeNull()
    expect(itemBody({ ...collectionItem, summary: undefined })).toBeNull()
    expect(itemBody({ ...collectionItem, summary: '' })).toBeNull()
    expect(itemBody({ ...collectionItem, summary: 'please_subscribe' })).toBeNull()
    expect(itemBody({ ...followItem, summary: 'public_collection_updated' })).toBeNull()
  })
})
