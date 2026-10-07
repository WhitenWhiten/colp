import { describe, expect, it } from 'vitest'
import { normalizeBookmarkUrl, replicaSourceMatchesNodeUrl } from './bookmarkUrl'

describe('readable replica bookmark URL compare', () => {
  it('treats a path-less origin as matching its WHATWG trailing slash', () => {
    expect(normalizeBookmarkUrl('https://news.ycombinator.com')).toBe('https://news.ycombinator.com/')
    expect(replicaSourceMatchesNodeUrl(
      'https://news.ycombinator.com/',
      'https://news.ycombinator.com',
    )).toBe(true)
  })

  it('lowercases the host and drops default https port and fragment', () => {
    expect(replicaSourceMatchesNodeUrl(
      'https://news.ycombinator.com/',
      'https://News.YCombinator.com:443/#' ,
    )).toBe(true)
  })

  it('does not match a different path', () => {
    expect(replicaSourceMatchesNodeUrl(
      'https://example.test/old-article',
      'https://example.test/new-article',
    )).toBe(false)
  })

  it('accepts a null node URL and never matches it', () => {
    // ResolvedResourceNode.url is nullable, so Reader can hand this straight in.
    expect(replicaSourceMatchesNodeUrl('https://example.test/article', null)).toBe(false)
    expect(replicaSourceMatchesNodeUrl('', null)).toBe(false)
  })
})
