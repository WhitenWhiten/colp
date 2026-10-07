// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { EditableNodeView } from '../../api'
import { libraryDeleteRequest } from './LibraryOverlays'

function node(
  partial: Pick<EditableNodeView, 'id' | 'parentId' | 'kind' | 'title'>,
): EditableNodeView {
  return partial as EditableNodeView
}

function renderBody(body: ReactNode): { text: string; html: string } {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(createElement('div', null, body))
  })
  const rendered = { text: host.textContent ?? '', html: host.innerHTML }
  act(() => root.unmount())
  host.remove()
  return rendered
}

describe('libraryDeleteRequest', () => {
  it('names a folder subtree and says the delete cannot be undone', () => {
    const folder = node({ id: 'folder', parentId: 'root', kind: 'folder', title: 'Notes' })
    const sub = node({ id: 'sub', parentId: 'folder', kind: 'folder', title: 'Nested' })
    const direct = node({ id: 'a', parentId: 'folder', kind: 'bookmark', title: 'One' })
    const nested = node({ id: 'b', parentId: 'sub', kind: 'bookmark', title: 'Two' })
    const outside = node({ id: 'out', parentId: 'root', kind: 'bookmark', title: 'Elsewhere' })
    const request = libraryDeleteRequest([folder], [folder, sub, direct, nested, outside])
    const rendered = renderBody(request.body)
    expect(rendered.text).toContain('2 bookmarks and 1 folder')
    expect(rendered.text).toContain("can't be undone")
    expect(rendered.html).toContain('library-delete-title')
    expect(request.confirmLabel).toBe('Delete folder')
  })

  it('omits a zero count and says an empty folder is empty', () => {
    const folder = node({ id: 'folder', parentId: 'root', kind: 'folder', title: 'Notes' })
    const bookmark = node({ id: 'a', parentId: 'folder', kind: 'bookmark', title: 'One' })
    const bookmarksOnly = renderBody(libraryDeleteRequest([folder], [folder, bookmark]).body)
    expect(bookmarksOnly.text).toContain('1 bookmark')
    expect(bookmarksOnly.text).not.toContain('folder')

    const sub = node({ id: 'sub', parentId: 'folder', kind: 'folder', title: 'Nested' })
    const foldersOnly = renderBody(libraryDeleteRequest([folder], [folder, sub]).body)
    expect(foldersOnly.text).toContain('1 folder')
    expect(foldersOnly.text).not.toContain('bookmark')

    const empty = renderBody(libraryDeleteRequest([folder], [folder]).body)
    expect(empty.text).toBe("Delete “Notes”. It's empty. This can't be undone.")
    expect(empty.text).not.toContain('everything in it')
    expect(empty.text).not.toContain('0 ')
    expect(empty.html).toContain('library-delete-title')
  })

  it('words empty multi-deletes for what was picked', () => {
    const first = node({ id: 'f1', parentId: 'root', kind: 'folder', title: 'Notes' })
    const second = node({ id: 'f2', parentId: 'root', kind: 'folder', title: 'Drafts' })
    const loose = node({ id: 'a', parentId: 'root', kind: 'bookmark', title: 'One' })
    expect(libraryDeleteRequest([first, second], [first, second]).body)
      .toBe("Delete 2 folders. They're empty. This can't be undone.")
    expect(libraryDeleteRequest([first, loose], [first, loose]).body)
      .toBe("Delete 2 items. The selected folders are empty. This can't be undone.")
  })

  it('leaves a bookmark-only confirm as a question', () => {
    const bookmark = node({ id: 'a', parentId: 'root', kind: 'bookmark', title: 'One' })
    const other = node({ id: 'b', parentId: 'root', kind: 'bookmark', title: 'Two' })
    const single = libraryDeleteRequest([bookmark])
    const rendered = renderBody(single.body)
    expect(rendered.text).toBe('Delete “One”?')
    expect(rendered.text).not.toContain("can't be undone")
    expect(rendered.html).toContain('library-delete-title')
    expect(single.confirmLabel).toBeUndefined()
    expect(libraryDeleteRequest([bookmark, other]).body).toBe('Delete 2 bookmarks?')
  })
})
