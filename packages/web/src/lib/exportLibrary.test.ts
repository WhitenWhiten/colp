// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ExportLibraryDocument } from '../api'
import { serializeLibraryExport } from './exportLibrary'

const doc: ExportLibraryDocument = {
  exportedAt: '2026-09-20T00:00:00.000Z',
  collections: [{
    id: 'collection-1', title: '私人 & notes', visibility: 'private', publicationSlug: null,
    nodes: [
      { id: 'link', parentId: 'folder', kind: 'bookmark', isRoot: false, title: 'Article',
        url: 'https://example.com/a?q=1&b=2', description: 'A useful article', tags: ['学习'], visibility: 'private' },
      { id: 'root', parentId: null, kind: 'folder', isRoot: true, title: 'Root' },
      { id: 'folder', parentId: 'root', kind: 'folder', isRoot: false, title: 'Reading' },
    ],
  }],
}

describe('library export formats', () => {
  it('preserves the complete JSON snapshot', () => {
    const result = serializeLibraryExport(doc, 'JSON')
    expect(JSON.parse(result.content)).toEqual(doc)
    expect(result.extension).toBe('json')
  })

  it('renders Markdown in tree order with sources, stable IDs and metadata', () => {
    const result = serializeLibraryExport(doc, 'Markdown')
    expect(result.extension).toBe('md')
    expect(result.type).toContain('text/markdown')
    expect(result.content).toContain('## 私人 &amp; notes')
    expect(result.content).toContain('  - Reading')
    expect(result.content).toContain('    - [Article](<https://example.com/a?q=1&amp;b=2>)')
    expect(result.content).toContain('Parent: folder')
    expect(result.content).toContain('A useful article')
    expect(result.content).toContain('Tags: 学习')
    expect(result.content).toContain('Visibility: private')
  })

  it('preserves URL authority and literal entities when creating Markdown links', () => {
    const url = 'https://example.com\\@other.example/?literal=&copy;'
    const snapshot = { ...doc, collections: [{ ...doc.collections[0]!, nodes: [{
      ...doc.collections[0]!.nodes[0]!, url,
    }] }] }
    const md = serializeLibraryExport(snapshot, 'Markdown').content
    expect(md).toContain('](<https://example.com/@other.example/?literal=&amp;copy;>)')
    const parsed = new DOMParser().parseFromString(serializeLibraryExport(snapshot, 'HTML').content, 'text/html')
    expect(new URL(parsed.querySelector('a')!.href).hostname).toBe('example.com')
  })

  it('bounds HTML nesting while retaining every node in a deep tree', () => {
    const nodes = Array.from({ length: 2000 }, (_, index) => ({
      id: `node-${index}`, parentId: index ? `node-${index - 1}` : null,
      kind: 'folder' as const, isRoot: index === 0,
    }))
    const snapshot = { ...doc, collections: [{ ...doc.collections[0]!, nodes }] }
    const parsed = new DOMParser().parseFromString(serializeLibraryExport(snapshot, 'HTML').content, 'text/html')
    expect(parsed.querySelectorAll('li')).toHaveLength(2000)
    expect(parsed.querySelectorAll('ul')).toHaveLength(33)
    expect(parsed.body.textContent).toContain('ID: node-1999 · Parent: node-1998')
  })

  it.each([
    ['https://example.com/?q=\\*', 'https://example.com/?q=%5C*'],
    ['https://example.com/?q=\\', 'https://example.com/?q=%5C'],
    ['https://example.com/#\\[section]', 'https://example.com/#%5C[section]'],
    ['https://example.com/?q=\\&literal=&copy;', 'https://example.com/?q=%5C&amp;literal=&amp;copy;'],
  ])('preserves literal backslashes in Markdown link destinations: %s', (url, destination) => {
    const snapshot = { ...doc, collections: [{ ...doc.collections[0]!, nodes: [{
      ...doc.collections[0]!.nodes[0]!, url,
    }] }] }
    expect(serializeLibraryExport(snapshot, 'Markdown').content).toContain(`[Article](<${destination}>)`)
    const restored = new URL(destination.replace(/&amp;/g, '&'))
    expect([...restored.searchParams]).toEqual([...new URL(url).searchParams])
    expect(decodeURIComponent(restored.hash)).toBe(decodeURIComponent(new URL(url).hash))
  })

  it('preserves apostrophes and quotes in Markdown titles', () => {
    const quoted = { ...doc, collections: [{ ...doc.collections[0]!, title: `O'Reilly "Books"` }] }
    expect(serializeLibraryExport(quoted, 'Markdown').content).toContain(`## O'Reilly "Books"`)
  })

  it('renders standalone HTML with real nested folders and escaped links', () => {
    const result = serializeLibraryExport(doc, 'HTML')
    const parsed = new DOMParser().parseFromString(result.content, 'text/html')
    expect(result.extension).toBe('html')
    expect(parsed.querySelector('h2')?.textContent).toBe('私人 & notes')
    expect(parsed.querySelector('section > ul > li > ul > li > ul > li > a')?.getAttribute('href'))
      .toBe('https://example.com/a?q=1&b=2')
    expect(parsed.querySelectorAll('li')).toHaveLength(3)
    expect(parsed.body.textContent).toContain('A useful article')
    expect(parsed.body.textContent).toContain('Tags: 学习')
  })

  it('escapes active HTML, Markdown injection and unsafe source URLs', () => {
    const malicious: ExportLibraryDocument = { ...doc, collections: [{
      ...doc.collections[0]!, title: '<script>alert(1)</script>',
      nodes: [{ id: 'evil', parentId: null, isRoot: false, kind: 'bookmark',
        title: '[evil](javascript:alert(1))', url: 'javascript:alert(1)',
        description: '<img src=x onerror=alert(1)>', tags: ['<iframe>'] }],
    }] }
    const parsed = new DOMParser().parseFromString(serializeLibraryExport(malicious, 'HTML').content, 'text/html')
    expect(parsed.querySelectorAll('script, img, iframe, a')).toHaveLength(0)
    expect(parsed.querySelector('h2')?.textContent).toBe('<script>alert(1)</script>')
    expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')).not.toBeNull()
    const md = serializeLibraryExport(malicious, 'Markdown').content
    expect(md).not.toContain('<script>')
    expect(md).not.toContain('[evil](')
    expect(md).toContain('Source: javascript:')
  })

  it('retains disconnected and cyclic nodes exactly once without recursive overflow', () => {
    const unusual: ExportLibraryDocument = { ...doc, collections: [{ ...doc.collections[0]!, nodes: [
      { id: 'a', parentId: 'b', kind: 'folder', isRoot: false },
      { id: 'b', parentId: 'a', kind: 'folder', isRoot: false },
      { id: 'orphan', parentId: 'missing', kind: 'bookmark', isRoot: false },
    ] }] }
    const parsed = new DOMParser().parseFromString(serializeLibraryExport(unusual, 'HTML').content, 'text/html')
    expect(parsed.querySelectorAll('li')).toHaveLength(3)
    const md = serializeLibraryExport(unusual, 'Markdown').content
    for (const id of ['a', 'b', 'orphan']) expect(md.split(`ID: ${id} ·`)).toHaveLength(2)
  })

  it.each(['Markdown', 'HTML'] as const)('supports an empty library in %s', (format) => {
    expect(serializeLibraryExport({ ...doc, collections: [] }, format).content).toContain('No collections.')
  })
})
