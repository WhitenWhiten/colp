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
async function screen(versions: SyncConflictSummary[], staleResponses: number, rejectResolution = false) {
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
      if (rejectResolution) return jsonResponse(productErrorBody({ code: 'invalid_document',
        message: 'Folder title cannot be empty.', recovery: 'user_action' }), { status: 400 })
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

it('missing resolution context keeps the existing item values without implying the bookmark is gone', async () => {
  // A live target can lack retained historical context needed for resolution.
  // resource_not_found describes that missing context as well as missing nodes.
  const f = await screen([conflict(1, { allowedResolutions: [], resolutionBlockedReason: 'resource_not_found' })], 0)
  expect(document.body.textContent).toContain('Information needed to resolve this conflict is unavailable.')
  expect(document.body.textContent).not.toContain('This item is currently unavailable.')
  expect(document.body.textContent).toContain('Server title 1')
  expect(document.body.textContent).toContain('Browser title')
  expect(document.querySelector('input[type=radio]:checked')).toBeNull()
  expect(button('Resolve conflict').disabled).toBe(true)
  expect(button('Refresh conflict').disabled).toBe(false)
  act(() => button('Resolve conflict').click())
  await act(async () => { await Promise.resolve() })
  expect(f.posts).toHaveLength(0)
})

function enterCustomTitle(value: string) {
  choose('custom')
  const input = document.querySelector<HTMLInputElement>('[aria-label="Custom title"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('independent frozen review: the actual custom-title handler submits an exact empty bookmark title', async () => {
  const f = await screen([conflict(1)], 0)
  enterCustomTitle('')
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(1)
  expect(JSON.parse(String(f.posts[0]!.init?.body))).toEqual({ resolution: 'custom', value: '' })
  expect(requestHeaders(f.posts[0]!).get('if-match')).toBe(conflict(1).etag)
})

it('an empty folder title rejected by the server retains its conflict and does not claim resolution', async () => {
  // The summary intentionally has no kind. The actual server evaluator's
  // bookmark/folder distinction is separately exercised by its unit controls.
  const f = await screen([conflict(1, { targetId: 'folder' })], 0, true)
  enterCustomTitle('')
  expect(document.body.textContent).toContain('Bookmarks may have an empty title. Folders must have a title.')
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  await waitForDom(() => document.querySelector('[role="alert"]')?.textContent === 'Folder title cannot be empty.')
  expect(f.posts).toHaveLength(1)
  expect(JSON.parse(String(f.posts[0]!.init?.body))).toEqual({ resolution: 'custom', value: '' })
  expect(document.querySelector('[data-conflict-receipt="conflict"]')).toBeNull()
  expect(document.querySelector('[data-conflict-id="conflict"]')).not.toBeNull()
  expect(document.querySelector<HTMLInputElement>('[aria-label="Custom title"]')?.value).toBe('')
})

it('the actual custom-title handler still refuses whitespace-only text', async () => {
  const f = await screen([conflict(1)], 0)
  enterCustomTitle(' \t ')
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(0)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('whitespace')
})

it('independent frozen review: the actual custom-title handler refuses a title beyond the shared UTF-8 cap', async () => {
  const f = await screen([conflict(1)], 0)
  const title = '界'.repeat(342)
  expect(title.length).toBe(342)
  expect(new TextEncoder().encode(title).byteLength).toBe(1026)
  enterCustomTitle(title)
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(0)
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('1024')
})

it('independent frozen review: the actual custom-title handler preserves the exact UTF-8 boundary', async () => {
  const f = await screen([conflict(1)], 0)
  const title = `${'界'.repeat(341)}a`
  expect(new TextEncoder().encode(title).byteLength).toBe(1024)
  enterCustomTitle(title)
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(1)
  expect(JSON.parse(String(f.posts[0]!.init?.body))).toEqual({ resolution: 'custom', value: title })
})

const textByteCases = [
  { field: 'description', label: 'Custom description', cap: 16384,
    accepted: `${'界'.repeat(5461)}a`, rejected: '界'.repeat(5462) },
  { field: 'url', label: 'Custom URL', cap: 4096,
    accepted: `https://example.test/${'界'.repeat(1358)}a`, rejected: `https://example.test/${'界'.repeat(1359)}` },
  { field: 'canonicalUrl', label: 'Custom canonical URL', cap: 4096,
    accepted: `https://example.test/${'界'.repeat(1358)}a`, rejected: `https://example.test/${'界'.repeat(1359)}` },
] as const

function enterCustomText(label: string, value: string) {
  choose('custom')
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it.each(textByteCases)('R5: the actual custom-$field handler refuses text beyond the authoritative UTF-8 cap', async ({ field, label, cap, rejected }) => {
  const f = await screen([conflict(1, { field: `/${field}` })], 0)
  expect(new TextEncoder().encode(rejected).byteLength).toBeGreaterThan(cap)
  // These are below the existing character limits and can be pasted in the UI.
  expect(rejected.length).toBeLessThan(field === 'description' ? 20000 : 4096)
  enterCustomText(label, rejected)
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(0)
  expect(document.querySelector('[role="alert"]')?.textContent?.replaceAll(',', '')).toContain(String(cap))
  expect(document.querySelector('[data-conflict-id="conflict"]')).not.toBeNull()
})

it.each(textByteCases)('R5: the actual custom-$field handler preserves the exact authoritative UTF-8 boundary', async ({ field, label, cap, accepted }) => {
  const f = await screen([conflict(1, { field: `/${field}` })], 0)
  expect(new TextEncoder().encode(accepted).byteLength).toBe(cap)
  enterCustomText(label, accepted)
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(1)
  expect(JSON.parse(String(f.posts[0]!.init?.body))).toEqual({ resolution: 'custom', value: accepted })
})

it.each(textByteCases)('R5: an oversized $field stays editable and only the explicitly confirmed correction is submitted', async ({ field, label, cap, accepted }) => {
  const f = await screen([conflict(1, { field: `/${field}` })], 0)
  const card = document.querySelector('[data-conflict-id="conflict"]')!
  // One byte above the limit is refused, without truncating the user's draft.
  const oversized = `${accepted}b`
  expect(new TextEncoder().encode(oversized).byteLength).toBe(cap + 1)
  enterCustomText(label, oversized)
  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  expect(input.value).toBe(oversized)
  expect(input.disabled).toBe(false)
  expect(card.querySelector('[role="alert"]')?.textContent).toContain('UTF-8 bytes. Shorten it')
  expect(document.querySelector('[data-conflict-receipt="conflict"]')).toBeNull()
  expect(f.posts).toHaveLength(0)

  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  expect(f.posts).toHaveLength(0)
  expect(input.value).toBe(oversized)
  enterCustomText(label, accepted)
  expect(input.value).toBe(accepted)
  expect(card.querySelector('[role="alert"]')).toBeNull()
  expect(f.posts).toHaveLength(0)

  await act(async () => { button('Resolve conflict').click(); await Promise.resolve() })
  await waitForDom(() => document.querySelector('[data-conflict-receipt="conflict"]') !== null)
  expect(f.posts).toHaveLength(1)
  expect(JSON.parse(String(f.posts[0]!.init?.body))).toEqual({ resolution: 'custom', value: accepted })
  expect(requestHeaders(f.posts[0]!).get('if-match')).toBe(conflict(1).etag)
})
