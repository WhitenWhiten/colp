// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { applyMeView, applySessionView, clearSession } from '../../api/sessionStore'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { FolderShareDialog } from './FolderShareDialog'

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), stop: vi.fn(), copy: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../api', async original => {
  const actual = await original<typeof import('../../api')>()
  return { ...actual, productClient: { ...actual.productClient, getFolderShare: mocks.get, putFolderShare: mocks.put, deleteFolderShare: mocks.stop } }
})
vi.mock('../../components/AppToast', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }))
vi.mock('../../lib/clipboard', () => ({ copyTextToClipboard: mocks.copy }))
const share = { id: 'share', collectionId: 'library', nodeId: 'folder', slug: 'folder-reading', createdAt: '2026-10-16T00:00:00Z' }
const close = vi.fn(), changed = vi.fn(async () => undefined)
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
function render() { mountTree(<FolderShareDialog collectionId="library" nodeId="folder" title="Reading" onClose={close} onChanged={changed} />) }
beforeEach(() => {
  vi.clearAllMocks(); mocks.get.mockReset(); mocks.put.mockReset(); mocks.stop.mockReset()
  clearSession(); applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
  applyMeView({ account: { id: 'owner', email: 'owner@test' }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } })
  mocks.get.mockResolvedValue({ share: null }); mocks.put.mockResolvedValue({ share }); mocks.stop.mockResolvedValue({ share: null }); mocks.copy.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); clearSession() })

test('creating, copying and stopping a folder share updates its link and the tree, with toasts', async () => {
  render(); await waitForDom(() => Boolean(button('Create link')))
  expect(document.body.textContent).toContain('Anyone with the link can view this folder.')
  act(() => button('Create link').click()); await waitForDom(() => Boolean(button('Stop sharing')))
  expect(mocks.put).toHaveBeenCalledWith('library', 'folder', expect.objectContaining({ intentId: expect.any(String), signal: expect.any(AbortSignal) }))
  expect(document.querySelector('[data-testid="copy-field-value"]')?.textContent).toContain('/c/folder-reading')
  act(() => button('Copy').click()); await waitForDom(() => mocks.success.mock.calls.some(([message]) => message === 'Link copied'))
  expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining('/c/folder-reading'))
  act(() => button('Stop sharing').click()); await waitForDom(() => Boolean(button('Create link')))
  expect(document.querySelector('[data-testid="copy-field"]')).toBeNull()
  expect(changed).toHaveBeenCalledTimes(2)
  expect(mocks.success).toHaveBeenCalledWith('Sharing stopped. The link no longer works.')
})
test('an existing share is read without creating another one', async () => {
  mocks.get.mockResolvedValue({ share }); render(); await waitForDom(() => Boolean(button('Stop sharing')))
  expect(mocks.put).not.toHaveBeenCalled(); expect(document.querySelector('a')?.getAttribute('href')).toContain('/c/folder-reading')
})
test('a failed create keeps the folder private and retries the same command intent', async () => {
  mocks.put.mockRejectedValue(new ProductApiError({ status: 503, code: 'feature_temporarily_unavailable', message: 'internal-secret' }))
  render(); await waitForDom(() => Boolean(button('Create link')))
  act(() => button('Create link').click()); await waitForDom(() => mocks.error.mock.calls.length === 1 && !button('Create link').disabled)
  expect(document.querySelector('[data-testid="copy-field"]')).toBeNull(); expect(document.body.textContent).not.toContain('internal-secret')
  act(() => button('Create link').click()); await waitForDom(() => mocks.put.mock.calls.length === 2)
  expect(mocks.put.mock.calls[0]![2].intentId).toBe(mocks.put.mock.calls[1]![2].intentId)
})
test('a late response cannot reveal another account’s link', async () => {
  const pending: Array<(value: { share: typeof share }) => void> = []
  mocks.get.mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  render(); await waitForDom(() => pending.length > 0)
  await act(async () => {
    applyMeView({ account: { id: 'other', email: 'other@test' }, profile: { id: 'other', handle: 'other', displayName: 'Other', avatarUrl: null } })
    for (const resolve of pending) resolve({ share })
  })
  expect(document.querySelector('[data-testid="copy-field"]')).toBeNull(); expect(close).toHaveBeenCalled()
})
test('a failed read offers retry and reports the failure as a toast', async () => {
  mocks.get.mockRejectedValue(new Error('offline')); render(); await waitForDom(() => Boolean(button('Try again')))
  expect(mocks.error).toHaveBeenCalledWith('Could not load this folder’s share link. Try again.')
  mocks.get.mockResolvedValue({ share }); act(() => button('Try again').click()); await waitForDom(() => Boolean(button('Stop sharing')))
})
