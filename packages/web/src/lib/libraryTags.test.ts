import { describe, expect, it } from 'vitest'
import { countTags, matchesTags, readTagParams, retag, toggleTag, writeTagParams } from './libraryTags'

describe('library tags', () => {
  it('counts each tag once per bookmark, case-folded, under its most used spelling', () => {
    expect(countTags([
      { tags: ['Rust', 'rust'] },
      { tags: ['Rust', 'web'] },
      { tags: ['rust'] },
      { tags: ['Rust'] },
      { tags: [] },
    ])).toEqual([
      { tag: 'Rust', count: 4 },
      { tag: 'web', count: 1 },
    ])
  })

  it('matches all or any selected tags', () => {
    expect(matchesTags(['Rust', 'web'], ['rust', 'WEB'], 'all')).toBe(true)
    expect(matchesTags(['Rust'], ['rust', 'web'], 'all')).toBe(false)
    expect(matchesTags(['Rust'], ['rust', 'web'], 'any')).toBe(true)
    expect(matchesTags(undefined, [], 'all')).toBe(true)
  })

  it('toggles case-insensitively', () => {
    expect(toggleTag(['Rust'], 'web')).toEqual(['Rust', 'web'])
    expect(toggleTag(['Rust', 'web'], 'rust')).toEqual(['web'])
  })

  it('round-trips tags with commas through the URL and keeps other parameters', () => {
    const params = writeTagParams(new URLSearchParams('node=n1'), ['a, b', 'c'], 'any')
    expect(params.toString()).toBe('node=n1&tag=a%2C+b&tag=c&tagmatch=any')
    expect(readTagParams(params)).toEqual({ tags: ['a, b', 'c'], match: 'any' })
    expect(writeTagParams(params, ['c'], 'any').toString()).toBe('node=n1&tag=c')
  })

  it('retags in place: removes case-insensitively, adds only what is missing, keeps spellings', () => {
    expect(retag(['Rust', 'web', 'ml'], ['RUST', 'new'], ['WEB'])).toEqual(['Rust', 'ml', 'new'])
    expect(retag(['a', 'b'], ['c'], [], 2)).toEqual(['a', 'b'])
  })
})
