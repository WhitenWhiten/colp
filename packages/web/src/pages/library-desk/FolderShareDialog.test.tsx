// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FolderShareDialog } from './FolderShareDialog'
import { cleanup, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), stop: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('../../api', async importOriginal => ({
  ...await importOriginal<typeof import('../../api')>(),
  privateSessionIdentity: () => 'owner', subscribeSession: () => () => {},
  productClient: { ...((await importOriginal<typeof import('../../api')>()).productClient), getFolderShare: mocks.get, putFolderShare: mocks.put, deleteFolderShare: mocks.stop },
}))
vi.mock('../../components/AppToast', () => ({ useToast: () => ({ success: mocks.success, error: mocks.error }) }))
const share = { id: 'share', collectionId: 'library', nodeId: 'folder', slug: 'folder-share', createdAt: '2026-10-01T00:00:00Z' }
const close = vi.fn(), changed = vi.fn(async () => {})
beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = '<div id="root"></div>'
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(cleanup)
function render() { mountTree(<FolderShareDialog collectionId="library" nodeId="folder" title="Folder" onClose={close} onChanged={changed} />) }
it.each(['folder_restricted', 'publication_restricted'])('explains %s and prevents creating an unusable link', async unavailableReason => {
  mocks.get.mockResolvedValue({ share: null, unavailableReason })
  render()
  await waitForDom(() => Boolean(document.querySelector('button.btn-primary')))
  expect(document.body.textContent).not.toContain('Anyone with the link can view')
  const create = document.querySelector<HTMLButtonElement>('button.btn-primary')!
  expect(create.disabled).toBe(true)
  act(() => create.click())
  expect(mocks.put).not.toHaveBeenCalled()
})
it('allows revoking a restricted existing link while hiding copy and open actions', async () => {
  mocks.get.mockResolvedValue({ share, unavailableReason: 'folder_restricted' })
  mocks.stop.mockResolvedValue({ share: null, unavailableReason: 'folder_restricted' })
  render()
  await waitForDom(() => document.body.textContent?.includes('Stop sharing') === true)
  expect(document.querySelector('a')).toBeNull()
  expect(document.body.textContent).not.toContain('Folder link')
  act(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop sharing')!.click())
  await waitForDom(() => mocks.stop.mock.calls.length === 1)
  expect(mocks.stop).toHaveBeenCalledWith('library', 'folder', expect.anything())
})
