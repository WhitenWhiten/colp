// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession } from './sessionStore'
import { productClient } from './productClient'
beforeEach(() => {
  sessionStorage.clear(); clearSession()
  applySessionView({ authenticated: true, csrfToken: 'csrf-classification', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
  applyMeView({ account: { id: 'owner', email: null }, profile: { id: 'owner', handle: 'owner', displayName: 'Owner', avatarUrl: null } })
})
afterEach(() => { vi.restoreAllMocks(); clearSession() })
it('uses generated preview with cookie/CSRF and reuses the exact command after transport failure', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('response lost')).mockResolvedValueOnce(Response.json({ folder: null }))
  const input = { source: 'web' as const, nodeId: 'bookmark', requested: { folder: true as const, tags: false } }
  const options = { intentId: 'classification-client-retry', maxRetries: 5 }
  await expect(productClient.previewBookmarkClassification('library', input, options)).rejects.toMatchObject({ code: 'transport_error' })
  expect(fetch).toHaveBeenCalledTimes(1)
  await productClient.previewBookmarkClassification('library', input, options)
  const first = fetch.mock.calls[0]!, second = fetch.mock.calls[1]!
  expect(new URL(String(first[0])).pathname).toBe('/api/v1/collections/library/classification/preview')
  expect(first[1]?.credentials).toBe('include')
  const headers = new Headers(first[1]?.headers)
  expect(headers.get('x-csrf-token')).toBe('csrf-classification')
  expect(headers.get('known-command-id')).toBe(new Headers(second[1]?.headers).get('known-command-id'))
  expect(first[1]?.body).toBe(second[1]?.body)
})
it('confirmation preserves the reviewed ETag and never automatically retries a conflict', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: {
    code: 'precondition_failed', message: 'changed', recovery: 'refresh_and_retry', sameRequestRetrySafe: false, currentEtag: '"new"',
  } }, { status: 412 }))
  await expect(productClient.confirmBookmarkClassification('library', 'bookmark', { folderId: null, addTags: ['AI'] }, '"reviewed"', {
    intentId: 'confirmation-client-conflict', maxRetries: 5,
  })).rejects.toMatchObject({ status: 412 })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('if-match')).toBe('"reviewed"')
})
it('settings reads retain the server ETag and writes use the same owner-private collection', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ autoTagMode: 'off' }, { headers: { etag: '"settings-0"' } }))
    .mockResolvedValueOnce(Response.json({ autoTagMode: 'suggest' }, { headers: { etag: '"settings-1"' } }))
  const current = await productClient.getClassificationSettings('library')
  expect(current.etag).toBe('"settings-0"')
  await productClient.updateClassificationSettings('library', { autoTagMode: 'suggest' }, current.etag!, { intentId: 'settings-client-save' })
  expect(new URL(String(fetch.mock.calls[1]?.[0])).pathname).toBe('/api/v1/collections/library/classification-settings')
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('if-match')).toBe('"settings-0"')
})
it('settings always use the server_managed JSON projection, never the BYOK-gated v2 media type', async () => {
  // With the shipped default KNOWN_FEATURE_CLASSIFICATION_BYOK=false the v2 media
  // type answers 404 by design (plan D4), so a BYOK-capable request here would
  // hide the collection settings panel and block every hosted classification.
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ autoTagMode: 'off' }, { headers: { etag: '"settings-0"' } }))
    .mockResolvedValueOnce(Response.json({ autoTagMode: 'suggest' }, { headers: { etag: '"settings-1"' } }))
  await productClient.getClassificationSettings('library')
  await productClient.updateClassificationSettings('library', { autoTagMode: 'suggest', executionMode: 'server_managed', providerProfileId: null }, '"settings-0"', { intentId: 'settings-client-media' })
  const read = new Headers(fetch.mock.calls[0]?.[1]?.headers)
  expect(read.get('accept') ?? '').not.toContain('classification-settings.v2')
  const write = new Headers(fetch.mock.calls[1]?.[1]?.headers)
  expect(write.get('content-type')).toBe('application/json')
  expect(write.get('accept')).toBeNull()
})
it('batch Apply sends 50 selections once and retains the command and ETag for an explicit retry', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('response lost'))
    .mockResolvedValue(Response.json({ runId: 'run', status: 'applied', appliedNodeIds: [], receipts: [] }))
  const document = { selections: Array.from({ length: 50 }, (_, index) => ({ actionId: `action-${index}`, folderId: 'folder', addTags: ['AI'] })) }
  const options = { intentId: 'batch-client-apply', maxRetries: 5 }
  await expect(productClient.applyClassificationRun('library', 'run', document, '"reviewed"', options)).rejects.toMatchObject({ code: 'transport_error' })
  expect(fetch).toHaveBeenCalledTimes(1)
  await productClient.applyClassificationRun('library', 'run', document, '"reviewed"', options)
  expect(fetch).toHaveBeenCalledTimes(2)
  const first = fetch.mock.calls[0]!, second = fetch.mock.calls[1]!
  expect(JSON.parse(String(first[1]?.body)).selections).toHaveLength(50)
  expect(first[1]?.body).toBe(second[1]?.body)
  expect(new Headers(first[1]?.headers).get('known-command-id')).toBe(new Headers(second[1]?.headers).get('known-command-id'))
  expect(new Headers(second[1]?.headers).get('if-match')).toBe('"reviewed"')
  productClient.forgetClassificationRunIntent(options.intentId)
})
