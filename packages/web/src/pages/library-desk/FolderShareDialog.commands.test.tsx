// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FolderShareDialog } from './FolderShareDialog'
import { applyMeView, applySessionView, clearSession } from '../../api/sessionStore'
import { cleanup, mountTree, waitForDom } from '../../test/render'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('../../components/AppToast', () => ({ useToast: () => toast }))
const close = vi.fn(), changed = vi.fn(async () => {})
const render = () => mountTree(<FolderShareDialog collectionId="library" nodeId="folder" title="Folder" onClose={close} onChanged={changed} />)
const click = (label: string) => act(() => [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click())
const visible = (label: string) => waitForDom(() => document.body.textContent?.includes(label) === true)

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
  applyMeView({ account: { id: 'owner', email: 'owner@test' }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearSession() })

function shareServer() {
  let active: { id: string; collectionId: string; nodeId: string; slug: string; createdAt: string } | null = null
  let lost = true, sequence = 0
  const commands = new Map<string, unknown>()
  const writes: Array<{ method: string; command: string }> = []
  vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return Response.json({ share: active, unavailableReason: null })
    const method = init.method, command = new Headers(init.headers).get('known-command-id')!
    writes.push({ method, command })
    if (!commands.has(command)) {
      active = method === 'DELETE' ? null : { id: `share-${++sequence}`, collectionId: 'library', nodeId: 'folder',
        slug: `link-${sequence}`, createdAt: '2026-10-01T00:00:00Z' }
      commands.set(command, { share: active, unavailableReason: null })
    }
    if (lost) { lost = false; throw new TypeError('response lost after commit') }
    return Response.json(commands.get(command))
  })
  return writes
}
it('retains the real wire command id when retrying a lost response', async () => {
  const writes = shareServer()
  render(); await visible('Create link'); click('Create link')
  await waitForDom(() => toast.error.mock.calls.length === 1)
  click('Create link'); await visible('Stop sharing')
  expect(writes).toHaveLength(2)
  expect(writes[0]!.command).toMatch(/^[\da-f-]{36}$/)
  expect(writes[1]!.command).toBe(writes[0]!.command)
})
it('reopening, observing and revoking a lost create starts a new command and displays the new link', async () => {
  const writes = shareServer()
  render(); await visible('Create link'); click('Create link')
  await waitForDom(() => toast.error.mock.calls.length === 1)
  cleanup()
  render(); await visible('Stop sharing'); click('Stop sharing')
  await visible('Create link'); click('Create link'); await visible('Stop sharing')
  expect(writes.map(write => write.method)).toEqual(['PUT', 'DELETE', 'PUT'])
  expect(writes[2]!.command).not.toBe(writes[0]!.command)
  expect(document.querySelector('a')?.href).toContain('/c/link-2')
  expect(toast.success).toHaveBeenLastCalledWith('Folder shared by link')
})
