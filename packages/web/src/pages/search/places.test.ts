import { describe, expect, it } from 'vitest'
import type { SearchResult } from '../../api/types'
import { compactTrail, placeFor, type PlaceIndex } from './places'

const index: PlaceIndex = {
  title: 'Reading notes',
  rootId: 'root',
  nodes: {
    a: { kind: 'folder', parentId: 'root', title: 'A' },
    b: { kind: 'folder', parentId: 'a', title: 'B' },
    loop: { kind: 'folder', parentId: 'loop', title: 'Loop' },
    hit: { kind: 'bookmark', parentId: 'b', title: 'Hit' },
    stray: { kind: 'bookmark', parentId: 'loop', title: 'Stray' },
  },
}

const node = (resourceId: string): SearchResult => ({
  resourceType: 'node', resourceId, collectionId: 'c1', title: resourceId, urlHost: null, snippet: '', rank: 0.5,
})

describe('search places', () => {
  it('walks the folder trail from the collection down to the parent', () => {
    expect(placeFor(node('hit'), index)).toEqual({ kind: 'bookmark', trail: ['Reading notes', 'A', 'B'], subjectTitle: null })
    expect(placeFor(node('a'), index)).toEqual({ kind: 'folder', trail: ['Reading notes'], subjectTitle: null })
  })

  it('stops on a cycle and keeps an unknown node to its collection', () => {
    expect(placeFor(node('stray'), index)?.trail).toEqual(['Reading notes', 'Loop'])
    expect(placeFor(node('missing'), index)).toEqual({ kind: null, trail: ['Reading notes'], subjectTitle: null })
    expect(placeFor(node('hit'), null)).toBeNull()
  })

  it('names an annotation subject, including the collection itself', () => {
    const onCollection: SearchResult = {
      resourceType: 'annotation', resourceId: 'x', collectionId: 'c1', annotationType: 'note',
      subject: { type: 'collection', id: 'c1' }, snippet: 'Note', rank: 0.5,
    }
    expect(placeFor(onCollection, index)).toEqual({ kind: null, trail: [], subjectTitle: 'Reading notes' })
  })

  it('keeps both ends of a long trail', () => {
    expect(compactTrail(['Notes', 'A'])).toEqual(['Notes', 'A'])
    expect(compactTrail(['Notes', 'A', 'B', 'C'])).toEqual(['Notes', '…', 'C'])
  })
})
