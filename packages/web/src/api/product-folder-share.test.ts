// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { productClient } from './productClient'
import { applyMeView, applySessionView, clearSession } from './sessionStore'

afterEach(() => { vi.unstubAllGlobals(); clearSession() })
test('folder share writes include cookies, CSRF and the same command id when a lost response is retried', async () => {
  applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z' })
  applyMeView({ account: { id: 'owner', email: 'owner@test' }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } })
  let lost = true
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (lost) { lost = false; throw new TypeError('response lost') }
    return Response.json({ share: null })
  })
  const options = { intentId: 'share-response-replay', maxRetries: 0 }
  await expect(productClient.putFolderShare('library', 'folder', options)).rejects.toThrow()
  await productClient.putFolderShare('library', 'folder', options)
  expect(calls.map(call => call.url)).toEqual(['/api/v1/collections/library/nodes/folder/share', '/api/v1/collections/library/nodes/folder/share'])
  const first = new Headers(calls[0]!.init?.headers), second = new Headers(calls[1]!.init?.headers)
  expect(first.get('known-command-id')).toMatch(/^[\da-f-]{36}$/)
  expect(second.get('known-command-id')).toBe(first.get('known-command-id'))
  expect(second.get('x-csrf-token')).toBe('csrf')
  expect(calls[1]!.init).toMatchObject({ credentials: 'include', method: 'PUT', body: '{}' })
  await productClient.deleteFolderShare('library', 'folder', { intentId: 'stop-share', maxRetries: 0 })
  expect(calls[2]!.init?.method).toBe('DELETE')
  expect(new Headers(calls[2]!.init?.headers).get('x-csrf-token')).toBe('csrf')
})
