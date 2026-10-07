import { describe, expect, it } from 'vitest'
import { resourceKindLabel } from './resourceKind'

describe('resourceKindLabel', () => {
  it('maps known hosts and falls back to Link', () => {
    expect(resourceKindLabel('github.com')).toBe('Repo')
    expect(resourceKindLabel('www.github.com')).toBe('Repo')
    expect(resourceKindLabel('arxiv.org')).toBe('Paper')
    expect(resourceKindLabel('www.youtube.com')).toBe('Video')
    expect(resourceKindLabel('coursera.org')).toBe('Course')
    expect(resourceKindLabel('example.com')).toBe('Link')
    expect(resourceKindLabel('-')).toBe('Link')
  })
})
