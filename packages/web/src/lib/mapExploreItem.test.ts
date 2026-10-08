import { describe, expect, it } from 'vitest'
import type { ExploreCollection } from '../api/types'
import { formatDate } from './formatDate'
import { mapExploreItem } from './mapExploreItem'

const item: ExploreCollection = {
  id: 'col-u01-01',
  title: 'LLM learning path',
  summary: 'A public reading path.',
  kind: 'reading_path',
  tags: ['ML'],
  nodeCount: 16,
  updatedAt: '2026-07-24T12:00:00.000Z',
  publicationSlug: 'llm-learning-path',
  visibility: 'public',
  creators: [{ id: 'p1', name: 'Lin Yichen', handle: 'lin', avatar: null }],
}

describe('mapExploreItem', () => {
  it('maps publication slug, node count, first creator, and default viewCount 0', () => {
    const mapped = mapExploreItem(item)
    expect(mapped).toEqual({
      id: 'col-u01-01',
      slug: 'llm-learning-path',
      title: 'LLM learning path',
      description: 'A public reading path.',
      curator: 'Lin Yichen',
      curatorHandle: 'lin',
      curatorAvatar: null,
      curatorNote: null,
      tags: ['ML'],
      kind: 'reading_path',
      viewCount: 0,
      links: 16,
      updated: formatDate('2026-07-24T12:00:00.000Z'),
      updatedAt: '2026-07-24T12:00:00.000Z',
      public: true,
      language: null,
    })
    expect(mapped).not.toHaveProperty('followers')
  })

  it('passes through the first creator avatar when present', () => {
    const withAvatar: ExploreCollection = {
      ...item,
      creators: [{ id: 'p1', name: 'Lin Yichen', handle: 'lin', avatar: 'https://example.com/avatar.png' }],
    }
    expect(mapExploreItem(withAvatar).curatorAvatar).toBe('https://example.com/avatar.png')
    expect(mapExploreItem({ ...item, creators: [] }).curatorAvatar).toBeNull()
  })

  it('passes through viewCount when the Explore item includes it', () => {
    expect(mapExploreItem({ ...item, viewCount: 12 })).toEqual(expect.objectContaining({ viewCount: 12 }))
    expect(mapExploreItem({ ...item, viewCount: 12 })).not.toHaveProperty('followers')
  })

  it('passes through the Explore curatorNote and defaults missing notes to null', () => {
    expect(mapExploreItem({ ...item, curatorNote: 'A curated pick.' }).curatorNote).toBe('A curated pick.')
    expect(mapExploreItem(item).curatorNote).toBeNull()
  })

  it('passes through the Explore language tag for the language picker', () => {
    expect(mapExploreItem({ ...item, language: 'en' }).language).toBe('en')
    expect(mapExploreItem(item).language).toBeNull()
  })

  it('renders the restricted Unknown sentinel without a handle, avatar, or filterable name leak', () => {
    const mapped = mapExploreItem({
      ...item,
      creators: [{ id: 'unknown', name: 'Ada', handle: 'ada', avatar: 'https://cdn.example/a.png' }],
    })
    expect(mapped.curator).toBe('Unknown')
    expect(mapped.curatorHandle).toBe('')
    expect(mapped.curatorAvatar).toBeNull()
  })

  it('does not attach mock extra resources', () => {
    expect(mapExploreItem(item)).not.toHaveProperty('resources')
  })
})
