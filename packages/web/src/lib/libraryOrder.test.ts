import { describe, expect, it } from 'vitest'
import { applyLibraryOrder, insertionIndexForPointer, mergeLibraryOrder, moveId } from './libraryOrder'

const idOf = (item: { id: string }) => item.id
const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('applyLibraryOrder', () => {
  it('returns the server order untouched without a saved order', () => {
    expect(applyLibraryOrder(items, undefined, idOf)).toBe(items)
    expect(applyLibraryOrder(items, [], idOf)).toBe(items)
  })

  it('renders saved ids first in saved order and appends unknown items after', () => {
    expect(applyLibraryOrder(items, ['c', 'a'], idOf).map(idOf)).toEqual(['c', 'a', 'b'])
  })

  it('ignores saved ids that no longer resolve to an item', () => {
    expect(applyLibraryOrder(items, ['gone', 'b', 'a'], idOf).map(idOf)).toEqual(['b', 'a', 'c'])
  })

  it('pins a single matching saved id and appends the rest in server order', () => {
    expect(applyLibraryOrder(items, ['gone', 'b'], idOf).map(idOf)).toEqual(['b', 'a', 'c'])
  })

  it('keeps a one-item list in server order even when that id is saved', () => {
    expect(applyLibraryOrder([{ id: 'a' }], ['a'], idOf)).toEqual([{ id: 'a' }])
  })

  it('deduplicates repeated ids by first occurrence', () => {
    expect(applyLibraryOrder(items, ['b', 'b', 'a'], idOf).map(idOf)).toEqual(['b', 'a', 'c'])
  })
})

describe('mergeLibraryOrder', () => {
  it('keeps unloaded saved ranks after the new loaded order', () => {
    expect(mergeLibraryOrder(['c', 'a', 'b'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('appends newly loaded ids and drops duplicates', () => {
    expect(mergeLibraryOrder(['c', 'a', 'b', 'f'], ['a', 'b', 'c', 'd'])).toEqual(['c', 'a', 'b', 'f', 'd'])
  })

  it('caps the merged list at 200 ids', () => {
    const loaded = ['new']
    const previous = Array.from({ length: 200 }, (_, index) => `id-${index}`)
    const merged = mergeLibraryOrder(loaded, previous)
    expect(merged).toHaveLength(200)
    expect(merged[0]).toBe('new')
    expect(merged[199]).toBe('id-198')
  })
})

describe('insertionIndexForPointer', () => {
  const ids = ['a', 'b', 'c']
  const mids = new Map([['a', 10], ['b', 30], ['c', 50]])

  it('inserts in the middle and when dragging up', () => {
    expect(insertionIndexForPointer(ids, 'a', 40, mids)).toBe(1)
    expect(insertionIndexForPointer(ids, 'c', 5, mids)).toBe(0)
  })

  it('lands last when every sibling midpoint is zero, as in happy-dom', () => {
    const zeros = new Map([['b', 0], ['c', 0]])
    expect(insertionIndexForPointer(ids, 'a', 120, zeros)).toBe(2)
  })
})

describe('moveId', () => {
  it('moves an id and clamps the target into bounds', () => {
    expect(moveId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveId(['a', 'b', 'c'], 2, -5)).toEqual(['c', 'a', 'b'])
    expect(moveId(['a', 'b', 'c'], 1, 99)).toEqual(['a', 'c', 'b'])
  })

  it('returns the same array when nothing moves', () => {
    const ids = ['a', 'b']
    expect(moveId(ids, 0, 0)).toBe(ids)
    expect(moveId(ids, 7, 1)).toBe(ids)
  })
})
