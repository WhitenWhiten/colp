import { describe, expect, it } from 'vitest'
import { cleanSnippet, highlightQuery, isDuplicateSnippet } from './searchHighlight'

describe('highlightQuery', () => {
  it('wraps case-insensitive hits and leaves unmatched text alone', () => {
    const nodes = highlightQuery('Systems thinking', 'systems')
    expect(Array.isArray(nodes)).toBe(true)
    const parts = nodes as Array<{ props?: { className?: string; children?: string } } | string>
    expect(parts.some((part) => typeof part === 'object' && part?.props?.className === 'search-hit')).toBe(true)
    expect(highlightQuery('No match here', 'systems')).toBe('No match here')
  })

  it('treats identical title and snippet as a duplicate', () => {
    expect(isDuplicateSnippet('Systems', 'systems')).toBe(true)
    expect(isDuplicateSnippet('Systems', 'A path about systems')).toBe(false)
  })

  it('cleans snippet repeating the title at the start', () => {
    expect(cleanSnippet('React 生态精选', 'React 生态精选 React 及其生态的权威文档…')).toBe('React 及其生态的权威文档…')
    expect(cleanSnippet('React 生态精选', 'React 生态精选 — React 及其生态的权威文档…')).toBe('React 及其生态的权威文档…')
    expect(cleanSnippet('Systems', 'systems')).toBe('')
    expect(cleanSnippet('Systems', 'Independent snippet')).toBe('Independent snippet')
  })
})
