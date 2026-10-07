// @vitest-environment happy-dom
/* eslint-disable no-restricted-syntax -- consent control is intentionally located by its scoped class in this page test. */
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ProductApiError, type ClassifyInboxItem } from '../../api'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { ClassificationPreview } from './ClassificationPreview'
import { applySessionView } from '../../api/sessionStore'
const mocks = vi.hoisted(() => ({ accountId: 'owner', preview: vi.fn(), folders: vi.fn(), credits: vi.fn(), settings: vi.fn() }))
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ user: { accountId: mocks.accountId } }) }))
vi.mock('../../api', async original => {
  const actual = await original<typeof import('../../api')>()
  return { ...actual, productClient: { ...actual.productClient, previewBookmarkClassification: mocks.preview, loadEditorSnapshot: mocks.folders,
    getMyCredits: mocks.credits, getClassificationSettings: mocks.settings } }
})
const item: ClassifyInboxItem = { nodeId: 'bookmark', collectionId: 'library', collectionTitle: 'Library', title: 'Bookmark',
  url: 'https://example.org', host: 'example.org', etag: '"r1"', createdAt: '2026-09-19T00:00:00Z', suggestions: [] }
const result = { tags: { mode: 'off', candidates: [], maxAutoTags: 3 }, folder: { folderId: 'deep', decision: 'l2', confidence: 0.83 }, candidateCoverage: {
  l1Included: 32, l1Total: 40, descendantIncluded: 64, descendantTotal: 80,
} }
function button(label: string) {
  const node = [...document.querySelectorAll('button')].find(element => element.textContent === label)
  if (!node) throw new Error(`Missing ${label}`)
  return node
}
async function acceptBilling() {
  await waitForDom(() => document.querySelector<HTMLInputElement>('.classification-credit-consent input') !== null)
  const checkbox = document.querySelector<HTMLInputElement>('.classification-credit-consent input')
  if (!checkbox) throw new Error('Missing billing consent')
  await act(async () => checkbox.click())
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.accountId = 'owner'
  mocks.folders.mockResolvedValue({ nodes: [{ id: 'folder', kind: 'folder', title: 'Technology', parentId: 'root' },
    { id: 'deep', kind: 'folder', title: 'React', parentId: 'folder' }] })
  mocks.settings.mockResolvedValue({ settings: { executionMode: 'server_managed' } })
  mocks.credits.mockResolvedValue({ accountId: 'owner', contractVersion: '1.0.0', asOf: '2026-09-19T00:00:00.000Z', ledgerSequence: '1',
    balance: { available: 20, reserved: 0, nextExpiryAt: null, expiringPoints: 0 },
    prices: [{ operationType: 'bookmark.classify', priceVersion: 'bookmark-classify.v2', unit: 'bookmark', unitPoints: 1 }] })
  mocks.preview.mockResolvedValue(result)
})

it('recovers a pending request after CSRF rotation without a new charge or stale busy updates', async () => {
  let finishOld!: (value: unknown) => void
  let finishRetry!: (value: unknown) => void
  mocks.preview.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve }))
  mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  const original = mocks.preview.mock.calls[0]!
  mocks.credits.mockResolvedValue({ accountId: 'owner', balance: { available: 0 },
    prices: [{ operationType: 'bookmark.classify', priceVersion: 'changed-price', unitPoints: 2 }] })
  await act(async () => applySessionView({ authenticated: true, csrfToken: 'rotated-preview-token',
    idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' }))
  await waitForDom(() => button('Check existing request').disabled === false)
  expect(original[2].signal.aborted).toBe(true)
  expect(document.querySelector('select')?.disabled).toBe(false)
  await act(async () => button('Check existing request').click())
  expect(mocks.preview.mock.calls[1]?.[1]).toEqual(original[1])
  expect(mocks.preview.mock.calls[1]?.[2].intentId).toBe(original[2].intentId)
  await act(async () => finishOld(result))
  expect(button('Classifying…').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('Model score')
  await act(async () => finishRetry(result))
  expect(document.body.textContent).toContain('Model score')
  expect(document.querySelector('select')?.disabled).toBe(false)
})

it('discards a pending request on an account switch and requires consent from the new account', async () => {
  let finishOld!: (value: unknown) => void
  mocks.preview.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
  const rendered = mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  const original = mocks.preview.mock.calls[0]!
  mocks.accountId = 'another-owner'
  mocks.credits.mockResolvedValue({ accountId: mocks.accountId, balance: { available: 20 },
    prices: [{ operationType: 'bookmark.classify', priceVersion: 'new-account-price', unitPoints: 1 }] })
  rendered.rerender(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await waitForDom(() => document.querySelector<HTMLInputElement>('.classification-credit-consent input')?.disabled === false)
  expect(original[2].signal.aborted).toBe(true)
  expect(button('Suggest a folder').disabled).toBe(true)
  await act(async () => finishOld(result))
  expect(document.body.textContent).not.toContain('Model score')
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  expect(mocks.preview.mock.calls[1]?.[2].intentId).not.toBe(original[2].intentId)
})
afterEach(() => cleanup())
it('does not call provider on mount; shows coverage and keeps model choice explicitly manual', async () => {
  const choose = vi.fn()
  mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={choose} />)
  await waitForDom(() => document.querySelectorAll('option').length === 3)
  expect(mocks.preview).not.toHaveBeenCalled()
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  expect(mocks.preview).toHaveBeenCalledTimes(1)
  expect(mocks.preview.mock.calls[0]?.[1]).toEqual({ source: 'web', nodeId: 'bookmark', requested: { folder: true, tags: true }, billing: { priceVersion: 'bookmark-classify.v2', maxPoints: 1 } })
  expect(document.body.textContent).toContain('Technology / React')
  expect(document.body.textContent).toContain('32/40')
  expect(document.body.textContent).toContain('64/80')
  expect(document.body.textContent).toContain('Model score: 83%')
  expect(choose).not.toHaveBeenCalled()
  await act(async () => button('Choose suggested folder').click())
  expect(choose).toHaveBeenCalledWith({ folderId: 'deep', suggestionId: 'deep', folderTitle: 'Technology / React' })
})
it('checks pending commands with the same intent and never automatically starts a replacement', async () => {
  mocks.preview.mockRejectedValueOnce(new ProductApiError({ status: 409, code: 'command_in_progress', message: 'pending', recovery: 'same_request', sameRequestRetrySafe: true }))
  mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  const first = mocks.preview.mock.calls[0]?.[2].intentId
  expect(mocks.preview).toHaveBeenCalledTimes(1)
  await act(async () => button('Check existing request').click())
  expect(mocks.preview.mock.calls[1]?.[2].intentId).toBe(first)
})
it('unknown terminal outcome only retries the same request and manual folder selection remains usable', async () => {
  mocks.preview.mockRejectedValueOnce(new ProductApiError({ status: 503, code: 'feature_temporarily_unavailable', message: 'unknown', recovery: 'user_action', sameRequestRetrySafe: false }))
  const choose = vi.fn()
  mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={choose} />)
  await waitForDom(() => document.querySelectorAll('option').length === 3)
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  const first = mocks.preview.mock.calls[0]?.[2].intentId
  const select = document.querySelector('select')!
  await act(async () => { select.value = 'folder'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(choose).toHaveBeenCalledWith({ folderId: 'folder', suggestionId: 'folder', folderTitle: 'Technology' })
  expect(mocks.preview).toHaveBeenCalledTimes(1)
  await act(async () => button('Check existing request').click())
  expect(mocks.preview.mock.calls[1]?.[2].intentId).toBe(first)
})
it('ignores late preview responses after leaving the bookmark', async () => {
  let resolve!: (value: unknown) => void
  mocks.preview.mockImplementation(() => new Promise(done => { resolve = done }))
  const rendered = mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await acceptBilling()
  await act(async () => button('Suggest a folder').click())
  const signal = mocks.preview.mock.calls[0]?.[2].signal as AbortSignal
  rendered.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => resolve(result))
  expect(document.body.textContent).not.toContain('Model score')
})

it('reports mode unavailable when the collection uses non-managed execution mode', async () => {
  mocks.settings.mockResolvedValue({ settings: { executionMode: 'server_byok' } })
  mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await waitForDom(() => Boolean(document.body.textContent?.includes('This classification mode is unavailable')))
  expect(document.querySelector('.classification-credit-consent')).toBeNull()
  expect(button('Suggest a folder').disabled).toBe(true)
})

it.each([
  ['managed', 0], ['managed', 100], ['legacy_free', 0], ['legacy_free', 100],
] as const)('uses server billing mode %s with available balance %s', async (mode, available) => {
  mocks.credits.mockResolvedValue({ accountId: 'owner', managedClassificationBillingMode: mode,
    balance: { available }, prices: [{ operationType: 'bookmark.classify', priceVersion: 'v1', unitPoints: 1 }] })
  mountTree(<ClassificationPreview item={item} disabled={false} onChooseFolder={vi.fn()} />)
  await waitForDom(() => document.body.textContent?.includes('Checking the current credit price') === false)
  const start = button('Suggest a folder')
  if (mode === 'managed') {
    expect(start.disabled).toBe(true)
    if (available === 0) { expect(mocks.preview).not.toHaveBeenCalled(); return }
    await acceptBilling()
  } else {
    expect(document.querySelector('.classification-credit-consent')).toBeNull()
    expect(document.body.textContent).toContain('Platform credits are not charged for this classification.')
  }
  expect(start.disabled).toBe(false)
  await act(async () => start.click())
  expect(mocks.preview).toHaveBeenCalledTimes(1)
  expect(mocks.preview.mock.calls[0]?.[1].billing).toEqual(mode === 'managed' ? { priceVersion: 'v1', maxPoints: 1 } : undefined)
})
