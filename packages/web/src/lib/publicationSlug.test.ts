import { describe, expect, it } from 'vitest'
import { PUBLICATION_SLUG, suggestPublicationSlug } from './publicationSlug'

describe('suggestPublicationSlug', () => {
  it('turns a title into a lowercase, hyphenated address', () => {
    expect(suggestPublicationSlug('Reading list')).toBe('reading-list')
    expect(suggestPublicationSlug('  Design & Engineering: 2026  ')).toBe('design-engineering-2026')
    expect(suggestPublicationSlug('Café crème')).toBe('cafe-creme')
  })

  it('keeps the result within the server rule', () => {
    const long = suggestPublicationSlug(`${'a'.repeat(62)} b`)
    expect(long).toBe('a'.repeat(62))
    expect(PUBLICATION_SLUG.test(long)).toBe(true)
  })

  it('offers nothing when the title cannot make a valid address', () => {
    expect(suggestPublicationSlug('AI')).toBe('')
    expect(suggestPublicationSlug('读书清单')).toBe('')
    expect(suggestPublicationSlug('')).toBe('')
  })
})
