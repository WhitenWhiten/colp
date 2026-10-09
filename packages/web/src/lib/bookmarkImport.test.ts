import { describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot, EditableNodeView } from '../api'
import { bookmarkImportAttempt, importBookmarks, previewBookmarkImport } from './bookmarkImport'

const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Research</H3><DL><DT><A HREF="https://example.com/a">A &amp; B</A><DT><A HREF="https://example.com/b">Second</A></DL></DL>'
const snapshot = { collection: { id: 'collection' }, root: { id: 'root' }, nodes: [] } as unknown as EditorSnapshot
const folder = { id: 'folder', kind: 'folder', title: 'Research', parentId: 'root', position: 'a' } as EditableNodeView
const bookmark = { id: 'first', kind: 'bookmark', title: 'A & B', url: 'https://example.com/a', parentId: 'folder', position: 'a' } as EditableNodeView

describe('bookmark HTML import', () => {
  it('previews decoded nested bookmarks and rejects unsafe or relative URLs before any write', () => {
    expect(previewBookmarkImport(html)).toMatchObject({ folders: 1, bookmarks: 2 })
    expect(previewBookmarkImport(html).items[0]).toMatchObject({ children: [{ title: 'A & B' }, { title: 'Second' }] })
    for (const url of ['javascript:alert(1)', '/relative', 'https://user:pass@example.com']) {
      expect(() => previewBookmarkImport(html.replace('https://example.com/a', url))).toThrow()
    }
  })

  it('reuses existing folders and bookmarks while appending remaining entries in file order', async () => {
    const createCollectionNode = vi.fn().mockResolvedValue({ node: { ...bookmark, id: 'second', url: 'https://example.com/b', position: 'b' } })
    const result = await importBookmarks({ snapshot: { ...snapshot, nodes: [folder, bookmark] }, parentId: 'root',
      items: previewBookmarkImport(html).items, skipDuplicates: true, intentFor: bookmarkImportAttempt(),
      signal: new AbortController().signal, onProgress: vi.fn(),
    }, { createCollectionNode } as never)
    expect(result).toEqual({ created: 1, skipped: 2 })
    expect(createCollectionNode).toHaveBeenCalledTimes(1)
    expect(createCollectionNode.mock.calls[0]![1]).toMatchObject({ parentId: 'folder', afterId: 'first', beforeId: null, node: { title: 'Second' } })
  })

  it('retries an ambiguous failure with the original request and command even when duplicates are allowed', async () => {
    const intentFor = bookmarkImportAttempt()
    const options = { snapshot, parentId: 'root', items: previewBookmarkImport(html).items, skipDuplicates: false,
      intentFor, signal: new AbortController().signal, onProgress: vi.fn() }
    const createdSecond = { ...bookmark, id: 'second', position: 'b' }
    const createCollectionNode = vi.fn().mockResolvedValueOnce({ node: folder }).mockResolvedValueOnce({ node: bookmark })
      .mockRejectedValueOnce(new Error('Network disconnected')).mockResolvedValueOnce({ node: createdSecond })
    await expect(importBookmarks(options, { createCollectionNode } as never)).rejects.toThrow('Network disconnected')
    const request = createCollectionNode.mock.calls[2]
    const result = await importBookmarks({ ...options, snapshot: { ...snapshot, nodes: [folder, bookmark, createdSecond] } }, { createCollectionNode } as never)
    expect(result).toEqual({ created: 3, skipped: 0 })
    expect(createCollectionNode).toHaveBeenCalledTimes(4)
    expect(createCollectionNode.mock.calls[3]).toEqual(request)
  })

  it('does not count an already committed retry twice against collection capacity', async () => {
    const items = [{ kind: 'bookmark' as const, title: 'First', url: 'https://example.com/first' },
      { kind: 'bookmark' as const, title: 'Second', url: 'https://example.com/second' }]
    const intentFor = bookmarkImportAttempt()
    const original = { ...snapshot, nodes: Array.from({ length: 9997 }, (_, index) => ({ ...bookmark, id: `existing-${index}` })) }
    const options = { snapshot: original, parentId: 'root', items, skipDuplicates: false, intentFor,
      signal: new AbortController().signal, onProgress: vi.fn() }
    const committed = { ...bookmark, id: 'committed', parentId: 'root', position: 'b' } as EditableNodeView
    const createCollectionNode = vi.fn().mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValueOnce({ node: committed }).mockResolvedValueOnce({ node: { ...committed, id: 'second', position: 'c' } })
    await expect(importBookmarks(options, { createCollectionNode } as never)).rejects.toThrow('Lost response')
    await expect(importBookmarks({ ...options, snapshot: { ...original, nodes: [...original.nodes, committed] } }, { createCollectionNode } as never))
      .resolves.toEqual({ created: 2, skipped: 0 })
  })

  it('imports an untitled bookmark with a long valid URL using a bounded fallback title', async () => {
    const url = `https://example.com/${'a'.repeat(600)}`
    const preview = previewBookmarkImport(`<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="${url}"></A></DL>`)
    const createCollectionNode = vi.fn().mockResolvedValue({ node: bookmark })
    await importBookmarks({ snapshot, parentId: 'root', items: preview.items, skipDuplicates: true,
      intentFor: bookmarkImportAttempt(), signal: new AbortController().signal, onProgress: vi.fn(),
    }, { createCollectionNode } as never)
    expect(createCollectionNode.mock.calls[0]![1].node.title).toHaveLength(512)
    expect(createCollectionNode.mock.calls[0]![1].node.url).toBe(url)
  })
})
