import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot, SearchResult } from '../../api/types'
import { clearRouteCache } from '../../lib/routeCache'
import {
  compactTrail,
  loadPlaceIndex,
  MAX_CACHED_PLACE_INDEXES,
  placeFor,
  readCachedPlaceIndex,
  rememberPlaceIndex,
  type PlaceIndex,
} from './places'

const mocks = vi.hoisted(() => ({ loadEditorSnapshot: vi.fn() }))
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    productClient: { ...actual.productClient, loadEditorSnapshot: mocks.loadEditorSnapshot },
  }
})

function snapshot(id: string, title: string): EditorSnapshot {
  return {
    collection: { id, title },
    root: { id: `root-${id}` },
    nodes: [],
  } as unknown as EditorSnapshot
}

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
  beforeEach(() => {
    clearRouteCache()
    mocks.loadEditorSnapshot.mockReset()
  })

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

  it('evicts the least recently used collection index beyond the bound', () => {
    for (let index = 0; index < MAX_CACHED_PLACE_INDEXES; index += 1) {
      rememberPlaceIndex(`c-${index}`, { at: Date.now(), index: null })
    }
    // Touch the oldest entry so it becomes the most recently used.
    expect(readCachedPlaceIndex('c-0')).toBeDefined()
    rememberPlaceIndex('overflow', { at: Date.now(), index: null })

    expect(readCachedPlaceIndex('c-1')).toBeUndefined()
    expect(readCachedPlaceIndex('c-0')).toBeDefined()
    expect(readCachedPlaceIndex('overflow')).toBeDefined()
  })

  it('does not re-page a collection whose cached index is still fresh', async () => {
    rememberPlaceIndex('fresh', { at: Date.now(), index })
    await expect(loadPlaceIndex('fresh')).resolves.toEqual(index)
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalled()
  })

  it('shares one tree read between concurrent lookups and caches the index', async () => {
    let resolve!: (value: EditorSnapshot) => void
    mocks.loadEditorSnapshot.mockReturnValueOnce(new Promise((next) => { resolve = next }))

    const first = loadPlaceIndex('c1')
    const second = loadPlaceIndex('c1')
    expect(second).toBe(first)
    expect(mocks.loadEditorSnapshot).toHaveBeenCalledTimes(1)

    resolve(snapshot('c1', 'Reading notes'))
    await expect(first).resolves.toEqual({ title: 'Reading notes', rootId: 'root-c1', nodes: {} })
    expect(readCachedPlaceIndex('c1')?.index?.title).toBe('Reading notes')
  })
})
