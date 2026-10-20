// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../components/AppToast'
import type { SyncConflictSummary } from '../../api'
import { installFetchMock, jsonResponse, productErrorBody, requestHeaders, requestMethod,
  requestPathAndSearch, resetProductSession, seedAuthenticatedSession, type FetchCall } from '../../api/test-helpers'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { Sync } from '../Sync'

// Only HTTP is replaced. StrictMode, Product client, error/retry mapping,
// command allocation, state hooks and actual buttons remain production code.
let restoreFetch: (() => void) | undefined
beforeEach(() => {
  vi.stubEnv('VITE_MOCK_SESSION', 'false')
  sessionStorage.clear(); resetProductSession(); seedAuthenticatedSession('conflict-csrf')
})
afterEach(() => { cleanup(); restoreFetch?.(); resetProductSession(); vi.unstubAllEnvs(); document.body.replaceChildren() })

function conflict(revision: number, overrides: Partial<SyncConflictSummary> = {}): SyncConflictSummary {
  const tag = `conflict-decision-${String(revision).padStart(40, '0')}`
  return { id: 'conflict', collectionId: 'library', targetId: 'bookmark', status: 'open',
    type: 'concurrent_field_update', field: '/title', revision: tag, etag: `"${tag}"`,
    allowedResolutions: ['server', 'incoming', 'custom', 'both'], createdAt: '2026-10-20T00:00:00.000Z',
    summary: { current: `Server title ${revision}`, incoming: 'Browser title' }, ...overrides }
}
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent?.trim() === label)
  if (!found) throw new Error(`Button missing: ${label}`)
  return found
}
function choose(choice: string) {
  const input = document.querySelector<HTMLInputElement>(`input[type=radio][value="${choice}"]`)!
  act(() => input.click())
}
async function screen(versions: SyncConflictSummary[], staleResponses: number) {
  let current = versions[0]!, writes = 0
  const posts: FetchCall[] = [], reads: string[] = []
  const mock = installFetchMock((input, init) => {
    const call = { input, init }, method = requestMethod(call), { pathname } = requestPathAndSearch(call)
    if (method === 'GET' && pathname === '/api/v1/sync/status') return jsonResponse({ devices: [], replicas: [] })
    if (method === 'GET' && pathname === '/api/v1/me/library') return jsonResponse({ id: 'library', title: 'Bookmarks', library: true,
      rootNodeId: 'root', bookmarksBarId: 'bar', otherBookmarksId: 'other' })
    if (method === 'GET' && pathname === '/api/v1/sync/trash') return jsonResponse({ items: [], page: { nextCursor: null } })
    if (method === 'GET' && pathname === '/api/v1/sync/conflicts') {
      reads.push(current.revision); return jsonResponse({ items: [current], page: { nextCursor: null } })
    }
    if (method === 'POST' && pathname === '/api/v1/sync/conflicts/conflict/resolution') {
      posts.push(call); writes += 1
      if (writes <= staleResponses) {
        current = versions[writes]!
        return jsonResponse(productErrorBody({ code: 'precondition_failed', recovery: 'refresh_and_retry',
          precondition: 'resource', currentEtag: current.etag }), { status: 412 })
      }
      return jsonResponse({ conflictId: 'conflict', status: 'resolved', revision: 'resolved-1', etag: '"resolved-1"',
        resolvedAt: '2026-10-20T01:00:00.000Z' })
    }
    throw new Error(`Undeclared HTTP request: ${method} ${pathname}`)
  })
  restoreFetch = mock.restore
  mountTree(<ToastProvider><Sync /></ToastProvider>, { route: '/sync' })
  await waitForDom(() => document.querySelector('[data-conflict-id="conflict"]') !== null)
  return { posts, reads, setCurrent: (next: SyncConflictSummary) => { current = next } }
}

it('two 412 responses require two fresh GETs and two explicit confirmations with three distinct commands', async () => {
  const versions = [conflict(1), conflict(2), conflict(3)]
  const f = await screen(versions, 2)
  const initialReads = f.reads.length
  choose('incoming'); act(() => button('Resolve conflict').click())
  await waitForDom(() => document.body.textContent?.includes('Server title 2') === true)
  expect(f.posts).toHaveLength(1); expect(f.reads.slice(initialReads)).toEqual([versions[1]!.revision])
  expect(button('Confirm with latest version').disabled).toBe(false)
  act(() => button('Confirm with latest version').click())
  await waitForDom(() => document.body.textContent?.includes('Server title 3') === true)
  expect(f.posts).toHaveLength(2); expect(f.reads.slice(initialReads)).toEqual(versions.slice(1).map(row => row.revision))
  act(() => button('Confirm with latest version').click())
  await waitForDom(() => document.querySelector('[data-conflict-receipt="conflict"]') !== null)
  expect(f.posts).toHaveLength(3)
  expect(f.posts.map(call => requestHeaders(call).get('if-match'))).toEqual(versions.map(row => row.etag))
  expect(new Set(f.posts.map(call => requestHeaders(call).get('known-command-id'))).size).toBe(3)
  expect(f.posts.every(call => requestHeaders(call).get('x-csrf-token') === 'conflict-csrf')).toBe(true)
  expect(f.posts.map(call => JSON.parse(String(call.init?.body)))).toEqual(Array.from({ length: 3 }, () => ({ resolution: 'incoming' })))
  expect(document.querySelector('[data-conflict-id="conflict"]')).toBeNull()
})

it.each([
  { choice: 'both', latest: { type: 'delete_update' as const, allowedResolutions: ['server', 'incoming'] as SyncConflictSummary['allowedResolutions'] } },
  { choice: 'incoming', latest: { type: 'delete_update' as const, allowedResolutions: ['server'] as SyncConflictSummary['allowedResolutions'] } },
  { choice: 'custom', latest: { field: null, allowedResolutions: ['server', 'incoming', 'custom'] as SyncConflictSummary['allowedResolutions'] } },
])('a refreshed conflict cannot submit an unavailable previous $choice choice', async ({ choice, latest }) => {
  const versions = [conflict(1), conflict(2, latest)]
  const f = await screen(versions, 1)
  choose(choice); act(() => button('Resolve conflict').click())
  await waitForDom(() => document.body.textContent?.includes('This conflict changed.') === true)
  expect(f.posts).toHaveLength(1)
  const unavailable = document.querySelector<HTMLInputElement>(`input[type=radio][value="${choice}"]`)!
  expect(unavailable.checked).toBe(true); expect(unavailable.disabled).toBe(true)
  const confirm = button('Confirm with latest version')
  expect(confirm.disabled).toBe(true)
  act(() => confirm.click())
  await act(async () => { await Promise.resolve() })
  expect(f.posts).toHaveLength(1)
  choose('server'); act(() => button('Resolve conflict').click())
  await waitForDom(() => document.querySelector('[data-conflict-receipt="conflict"]') !== null)
  expect(f.posts).toHaveLength(2)
  expect(requestHeaders(f.posts[1]!).get('if-match')).toBe(versions[1]!.etag)
  expect(JSON.parse(String(f.posts[1]!.init?.body))).toEqual({ resolution: 'server' })
  expect(requestHeaders(f.posts[1]!).get('known-command-id')).not.toBe(requestHeaders(f.posts[0]!).get('known-command-id'))
})

it('a node moved into a managed folder keeps its conflict visible and cannot resolve until refreshed and explicitly confirmed', async () => {
  const versions = [conflict(1), conflict(2, { allowedResolutions: [], resolutionBlockedReason: 'node_read_only' })]
  const f = await screen(versions, 1)
  const initialReads = f.reads.length
  choose('incoming'); act(() => button('Resolve conflict').click())
  await waitForDom(() => document.body.textContent?.includes('Server title 2') === true)
  expect(f.posts).toHaveLength(1)
  expect(f.reads.slice(initialReads)).toEqual([versions[1]!.revision])
  expect(document.body.textContent).toContain('This item is read-only in its current folder.')
  expect(document.body.textContent).toContain('Browser title')
  expect(document.querySelector('[data-conflict-id="conflict"]')).not.toBeNull()
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')]
  expect(radios).toHaveLength(4)
  expect(radios.every(input => input.disabled)).toBe(true)
  expect(button('Resolve conflict').disabled).toBe(true)
  act(() => button('Resolve conflict').click())
  await act(async () => { await Promise.resolve() })
  expect(f.posts).toHaveLength(1)

  // The external server restores writability. Merely changing that fact must
  // neither refresh nor replay a previously denied command from the client.
  const restored = conflict(3)
  f.setCurrent(restored)
  expect(f.posts).toHaveLength(1)
  act(() => button('Refresh conflict').click())
  await waitForDom(() => document.body.textContent?.includes('Server title 3') === true)
  expect(f.reads.slice(initialReads)).toEqual([versions[1]!.revision, restored.revision])
  expect(f.posts).toHaveLength(1)
  expect(button('Confirm with latest version').disabled).toBe(false)
  act(() => button('Confirm with latest version').click())
  await waitForDom(() => document.querySelector('[data-conflict-receipt="conflict"]') !== null)
  expect(f.posts).toHaveLength(2)
  expect(requestHeaders(f.posts[1]!).get('if-match')).toBe(restored.etag)
  expect(requestHeaders(f.posts[1]!).get('known-command-id')).not.toBe(requestHeaders(f.posts[0]!).get('known-command-id'))
  expect(JSON.parse(String(f.posts[1]!.init?.body))).toEqual({ resolution: 'incoming' })
})

it('an initially unavailable node has no implicit server choice and keeps a refresh route', async () => {
  const f = await screen([conflict(1, { allowedResolutions: [], resolutionBlockedReason: 'resource_not_found' })], 0)
  expect(document.body.textContent).toContain('This item is currently unavailable.')
  expect(document.body.textContent).toContain('Server title 1')
  expect(document.body.textContent).toContain('Browser title')
  expect(document.querySelector('input[type=radio]:checked')).toBeNull()
  expect(button('Resolve conflict').disabled).toBe(true)
  expect(button('Refresh conflict').disabled).toBe(false)
  act(() => button('Resolve conflict').click())
  await act(async () => { await Promise.resolve() })
  expect(f.posts).toHaveLength(0)
})
