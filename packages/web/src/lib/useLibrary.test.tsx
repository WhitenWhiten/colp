// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { LibraryCollection } from '../api/types'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { cleanup, mountTree, settled, waitForDom } from '../test/render'
import { useLibrary } from './useLibrary'
const mocks = vi.hoisted(() => ({ library: vi.fn(), editor: vi.fn() }))
vi.mock('../api', async original => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, getLibrary: mocks.library, getCollectionEditorPage: mocks.editor } }
})
const library = (id: string): LibraryCollection => ({ id, title: 'Bookmarks', rootNodeId: `root-${id}`, library: true, bookmarksBarId: 'bar', otherBookmarksId: 'other' })
function Harness() {
  const data = useLibrary()
  return <div data-state={data.state}><span id="ids">{data.library?.id}</span>
    <button onClick={() => void data.reload()}>Reload</button></div>
}
beforeEach(() => {
  clearSession(); mocks.library.mockReset(); mocks.editor.mockReset()
  applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
  applyMeView({ account: { id: 'a', email: 'a@test' }, profile: { id: 'a', handle: 'a', displayName: 'A', avatarUrl: null } })
  mocks.library.mockResolvedValue(library('one'))
})
afterEach(() => { cleanup(); clearSession() })
test('ensures the account library without an extra editor or listing request', async () => {
  mountTree(<Harness />)
  await waitForDom(() => document.getElementById('ids')?.textContent === 'one')
  expect(mocks.library).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
  expect(mocks.editor).not.toHaveBeenCalled()
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
