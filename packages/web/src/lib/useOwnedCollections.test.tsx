// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { LibraryCollection, OwnedCollectionPage } from '../api/types'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { cleanup, mountTree, settled, waitForDom } from '../test/render'
import { useOwnedCollections } from './useOwnedCollections'
const mocks = vi.hoisted(() => ({ library: vi.fn(), editor: vi.fn() }))
vi.mock('../api', async original => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, getLibrary: mocks.library, getCollectionEditorPage: mocks.editor } }
})
function page(ids: string[], hasMore = false, nextCursor: string | null = null): OwnedCollectionPage {
  return {
    items: ids.map((id) => ({
      collection: {
        id, kind: 'bookmarks', title: `Collection ${id}`, summary: null, visibility: 'private',
        allowSearchIndexing: false, publicationSlug: null, publishedAt: null, rootNodeId: `root-${id}`,
        revision: 'r', etag: '"r"', contentRevision: 'c', contentEtag: '"c"', policyRevision: 'p',
        policyEtag: '"p"', createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
      capabilities: {
        updateCollection: true, managePublication: false, createNode: true,
        updateNode: true, moveNode: true, deleteNode: true,
      },
    })),
    page: { returnedCount: ids.length, hasMore, nextCursor },
  }
}

const library = (id: string): LibraryCollection => ({ id, title: 'Bookmarks', rootNodeId: `root-${id}`, library: true, bookmarksBarId: 'bar', otherBookmarksId: 'other' })
function Harness() {
  const data = useOwnedCollections()
  return <div data-state={data.state}><span id="ids">{data.items.map(item => item.collection.id).join(',')}</span>
    <button onClick={() => void data.reload()}>Reload</button></div>
}
beforeEach(() => {
  clearSession(); mocks.library.mockReset(); mocks.editor.mockReset()
  applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
  applyMeView({ account: { id: 'a', email: 'a@test' }, profile: { id: 'a', handle: 'a', displayName: 'A', avatarUrl: null } })
  mocks.library.mockResolvedValue(library('one'))
  mocks.editor.mockImplementation(async (id: string) => ({ ...page([id]).items[0] }))
})
afterEach(() => { cleanup(); clearSession() })
test('ensures the account library and loads its capabilities without listing collections', async () => {
  mountTree(<Harness />)
  await waitForDom(() => document.getElementById('ids')?.textContent === 'one')
  expect(mocks.editor).toHaveBeenCalledWith('one', { limit: 1 }, expect.objectContaining({ maxRetries: 0 }))
})
test('a late library response cannot paint a different account', async () => {
  let finish: (value: LibraryCollection) => void = () => undefined
  mocks.library.mockImplementation(() => new Promise<LibraryCollection>(resolve => { finish = resolve }))
  mountTree(<Harness />); await settled()
  const old = finish
  mocks.library.mockResolvedValue(library('two'))
  await act(async () => { applyMeView({ account: { id: 'b', email: 'b@test' }, profile: { id: 'b', handle: 'b', displayName: 'B', avatarUrl: null } }) })
  await waitForDom(() => document.getElementById('ids')?.textContent === 'two')
  await act(async () => { old(library('one')); await Promise.resolve() })
  expect(document.getElementById('ids')?.textContent).toBe('two')
})
test('failed discovery shows an actionable error without fabricating a library', async () => {
  mocks.library.mockRejectedValue(new Error('offline')); mountTree(<Harness />)
  await waitForDom(() => document.querySelector('[data-state="error"]') !== null)
  expect(document.getElementById('ids')?.textContent).toBe('')
})
