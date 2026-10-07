// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession, privateSessionIdentity } from '../api/sessionStore'
import { useBookmarkAnnotations, resetBookmarkAnnotationsCacheForTests } from './useBookmarkAnnotations'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { productClient } from '../api'
import { createProductTransport } from '../api/product-transport'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); clearSession(); resetBookmarkAnnotationsCacheForTests() })
it('keeps private notes retired if the old server cookie outlives local clearSession', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  resetBookmarkAnnotationsCacheForTests()
  applySessionView({ authenticated: true, csrfToken: 'csrf-a', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
  applyMeView({ account: { id: 'a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
  const requests: Array<{ identity: string; credentials: RequestCredentials | undefined }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    if (init.method === 'DELETE') throw new Error('logout never reached the server')
    requests.push({ identity: privateSessionIdentity(), credentials: init.credentials })
    // DELETE/session did not reach the server: its HttpOnly A cookie remains valid.
    // Exercise the actual productClient + transport, replacing only HTTP.
    return new Response(JSON.stringify({ annotations: init.credentials === 'include' ? [{ id: 'note-a', collectionId: 'shared', subject: { type: 'node', id: 'node-1' }, type: 'note', format: 'plain', value: 'A private note', visibility: 'private', creator: null, provenance: { kind: 'human' }, revision: 'r1', createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', extensions: {} }] : [], page: { hasMore: false, nextCursor: null } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  function Probe() { const marks = useBookmarkAnnotations('shared', ['node-1'], true); return <output>{marks.get('node-1')?.note?.text ?? ''}</output> }
  mountTree(<Probe />, { strict: false })
  await waitForDom(() => document.querySelector('output')?.textContent === 'A private note')
  await act(async () => { await productClient.deleteSession({ maxRetries: 0 }).catch(() => undefined); await Promise.resolve(); await Promise.resolve() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(requests.at(-1)).toMatchObject({ identity: expect.stringMatching(/^anonymous:/), credentials: 'omit' })
  expect(document.querySelector('output')?.textContent).toBe('')
})

it('uses the current actor for anonymous and authenticated reads through both transports', async () => {
  clearSession()
  const calls: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    calls.push(init)
    return new Response(JSON.stringify({ annotations: [], page: { hasMore: false, nextCursor: null }, items: [], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const transport = createProductTransport()
  const read = async () => {
    await productClient.loadAnnotations('shared', { resourceType: 'node', resourceId: 'node-1' }, { maxRetries: 0 })
    await productClient.searchResources({ q: 'title' }, { maxRetries: 0 })
    await transport.getPublicCollectionPage('shared')
    await productClient.getFeedPage({}, { maxRetries: 0 })
    await productClient.getNotificationPage({}, { maxRetries: 0 })
    await productClient.getNotificationPreference({ maxRetries: 0 })
  }
  await read()
  expect(calls).toHaveLength(6)
  expect(calls.every(call => call.credentials === 'omit')).toBe(true)
  calls.length = 0
  applySessionView({ authenticated: true, csrfToken: 'csrf-b', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
  await read()
  expect(calls).toHaveLength(6)
  expect(calls.every(call => call.credentials === 'include')).toBe(true)
})

it('still sends cookies for session bootstrap and logout before an actor is known', async () => {
  clearSession()
  const calls: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    calls.push(init)
    return init.method === 'DELETE' ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ authenticated: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  const transport = createProductTransport()
  await productClient.getSession({ maxRetries: 0 })
  await transport.deleteSession({ csrfToken: 'csrf-a' })
  expect(calls.map(call => call.credentials)).toEqual(['include', 'include'])
})
