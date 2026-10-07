import { describe, expect, it } from 'vitest'
import { plural, pluralNoun } from './plural'

describe('plural', () => {
  it('uses the singular only for 1', () => {
    expect(plural(0, 'link')).toBe('0 links')
    expect(plural(1, 'link')).toBe('1 link')
    expect(plural(2, 'link')).toBe('2 links')
  })

  it('accepts an irregular plural form', () => {
    expect(plural(1, 'item needs', 'items need')).toBe('1 item needs')
    expect(plural(3, 'item needs', 'items need')).toBe('3 items need')
  })

  it('returns the noun without the count', () => {
    expect(pluralNoun(1, 'bookmark')).toBe('bookmark')
    expect(pluralNoun(4, 'bookmark')).toBe('bookmarks')
  })
})
