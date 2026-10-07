// @vitest-environment happy-dom
/* eslint-disable no-restricted-syntax -- consent control is intentionally located by its scoped class in this page test. */
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProductApiError, type ClassificationRun } from '../api'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { ClassificationBatch } from './ClassificationBatch'
import { useClassificationBatch } from './classification/useClassificationBatch'
const mocks = vi.hoisted(() => ({ enabled: true, owned: vi.fn(), snapshot: vi.fn(), settings: vi.fn(), credits: vi.fn(), create: vi.fn(), get: vi.fn(), apply: vi.fn(), cancel: vi.fn(), forget: vi.fn() }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { accountId: 'owner' } }) }))
vi.mock('../api', async original => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, isClassificationBatchExposureEnabled: () => mocks.enabled, productClient: { ...actual.productClient,
    getOwnedCollectionsPage: mocks.owned, loadEditorSnapshot: mocks.snapshot, getClassificationSettings: mocks.settings, getMyCredits: mocks.credits,
    createClassificationRun: mocks.create, getClassificationRun: mocks.get, applyClassificationRun: mocks.apply,
    cancelClassificationRun: mocks.cancel, forgetClassificationRunIntent: mocks.forget } }
})
function run(status: ClassificationRun['status'] = 'open', count = 2, partial = false): ClassificationRun {
  const provider = { providerId: 'fixture', model: 'fixture', policyVersion: 'v1', promptVersion: 'v1' }
  return { runId: 'run-1', etag: '"run-1"', status, taxonomyRevision: 'c1', failureCode: null,
    createdAt: '2026-09-19T00:00:00Z', deadlineAt: '2099-01-01T00:04:00Z', expiresAt: '2099-01-01T00:30:00Z', provider,
    actions: Array.from({ length: count }, (_, index) => {
      const base = { actionId: `action-${index}`, nodeId: `node-${index}`, nodeEtag: '"node-r1"', sourceParentId: 'root' }
      return index === 1 && partial ? { ...base, status: 'failed' as const, decision: null, failureCode: 'provider_unavailable' as const }
        : { ...base, status: 'succeeded' as const, failureCode: null, decision: {
          contractVersion: '1.0.0', collectionId: 'library', source: { kind: 'node' as const, nodeId: base.nodeId }, taxonomyRevision: 'c1', provider,
          candidateCoverage: { policyVersion: 'v1', l1Total: 1, l1Included: 1, descendantTotal: 0, descendantIncluded: 0, tagTotal: 1, tagIncluded: 1 },
          folder: { decision: 'l1_root' as const, folderId: 'folder', l1FolderId: 'folder', parentFolderId: null, depth: 1,
            confidence: 1, l1Confidence: 1, l2Specificity: null, probabilities: [{ folderId: 'folder', probability: 1 }] },
          tags: { mode: 'suggest' as const, maxAutoTags: 3, candidates: [{ tag: 'AI', noul: 0.9, selected: true }] },
        } }
    }) }
}
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find(element => element.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function confirmModal() {
  await waitForDom(() => document.querySelector('.empty-state-actions .btn-danger') !== null)
  const btn = document.querySelector<HTMLButtonElement>('.empty-state-actions .btn-danger')
  if (btn) await act(async () => btn.click())
}
async function acceptBilling() {
  await waitForDom(() => document.querySelector<HTMLInputElement>('.classification-credit-consent input') !== null)
  const checkbox = document.querySelector<HTMLInputElement>('.classification-credit-consent input')
  if (!checkbox) throw new Error('Missing billing consent')
  await act(async () => checkbox.click())
}
function mount(runId = '') { return mountTree(<ClassificationBatch />, { route: `/classify/batch?collectionId=library${runId ? `&runId=${runId}` : ''}` }) }
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); mocks.enabled = true
  mocks.owned.mockResolvedValue({ items: [{ collection: { id: 'library', title: 'Library' } }], page: { nextCursor: null } })
  mocks.snapshot.mockResolvedValue({ collection: { id: 'library', rootNodeId: 'root', contentRevision: 'c1' }, root: { id: 'root' },
    nodes: [{ id: 'folder', parentId: 'root', kind: 'folder', title: 'Technology' }, ...Array.from({ length: 50 }, (_, i) => ({ id: `node-${i}`, parentId: 'root', kind: 'bookmark', title: `Bookmark ${i}` }))] })
  mocks.settings.mockResolvedValue({ settings: { autoTagMode: 'suggest', executionMode: 'server_managed' } })
  mocks.credits.mockResolvedValue({ accountId: 'owner', contractVersion: '1.0.0', asOf: '2026-09-19T00:00:00.000Z', ledgerSequence: '1',
    balance: { available: 100, reserved: 0, nextExpiryAt: null, expiringPoints: 0 },
    prices: [{ operationType: 'bookmark.classify', priceVersion: 'bookmark-classify.v2', unit: 'bookmark', unitPoints: 1 }] })
  mocks.create.mockResolvedValue(run('queued')); mocks.get.mockResolvedValue(run())
  mocks.apply.mockResolvedValue({ runId: 'run-1', status: 'applied', appliedNodeIds: ['node-0'], receipts: [] })
  mocks.cancel.mockResolvedValue(run('cancelled'))
})
afterEach(() => cleanup())
it('keeps exposure closed without loading or creating a batch', () => {
  mocks.enabled = false; mount()
  expect(document.body.textContent).toContain('not available yet')
  expect(mocks.owned).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
})
it('creates only after explicit action and applies only successful reviewed selections', async () => {
  mocks.get.mockResolvedValue(run('open', 2, true)); mount()
  await waitForDom(() => document.querySelector('.classification-credit-consent input') !== null)
  await acceptBilling()
  await waitForDom(() => !button('Start batch classification').disabled)
  expect(mocks.create).not.toHaveBeenCalled()
  await act(async () => button('Start batch classification').click())
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 1 selected changes')))
  expect(document.body.textContent).toContain('Suggestions unavailable')
  expect(mocks.create).toHaveBeenCalledWith('library', { sourceFolderIds: ['root'], requested: { folder: true, tags: true }, maxItems: 50, billing: { priceVersion: 'bookmark-classify.v2', maxPoints: 50 } }, expect.objectContaining({ maxRetries: 0 }))
  mocks.get.mockResolvedValue(run('applied', 2, true))
  await act(async () => button('Apply 1 selected changes').click())
  await confirmModal()
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  expect(mocks.apply.mock.calls[0]?.[2]).toEqual({ selections: [{ actionId: 'action-0', folderId: 'folder', addTags: ['AI'] }] })
  await waitForDom(() => document.body.textContent?.includes('Selected changes applied.') === true)
})
it('restores by runId and sends all 50 selections in one Apply call', async () => {
  mocks.get.mockResolvedValue(run('open', 50)); mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 50 selected changes' && !(node as HTMLButtonElement).disabled)))
  expect(document.body.textContent).toContain('50 of 50 suggestions ready.')
  expect(document.body.textContent).not.toContain('failed.')
  expect(mocks.create).not.toHaveBeenCalled()
  mocks.get.mockResolvedValue(run('applied', 50))
  await act(async () => button('Apply 50 selected changes').click())
  await confirmModal()
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  expect(mocks.apply.mock.calls[0]?.[2].selections).toHaveLength(50)
})
it('preserves the original Apply intent, body and ETag across response loss and page remount', async () => {
  mocks.apply.mockRejectedValueOnce(new TypeError('response lost'))
  const page = mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 2 selected changes' && !(node as HTMLButtonElement).disabled)))
  await act(async () => button('Apply 2 selected changes').click())
  await confirmModal()
  const first = mocks.apply.mock.calls[0]!
  await act(async () => page.unmount())
  mocks.get.mockResolvedValue({ ...run(), etag: '"later"' }); mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Check result')))
  await act(async () => button('Check result').click())
  expect(mocks.apply).toHaveBeenCalledTimes(2)
  const second = mocks.apply.mock.calls[1]!
  expect(second.slice(0, 4)).toEqual(first.slice(0, 4)); expect(second[4].intentId).toBe(first[4].intentId)
})
it('stale Apply requires a new review and never rewrites the original ETag automatically', async () => {
  mocks.apply.mockRejectedValue(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry' }))
  mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 2 selected changes' && !(node as HTMLButtonElement).disabled)))
  await act(async () => button('Apply 2 selected changes').click())
  await confirmModal()
  expect(button('Apply 2 selected changes').disabled).toBe(true)
  await act(async () => button('Refresh progress').click())
  expect(button('Apply 2 selected changes').disabled).toBe(true); expect(mocks.apply).toHaveBeenCalledTimes(1)
})
it('resumes an uncertain Create with the same request after remount', async () => {
  mocks.create.mockRejectedValueOnce(new TypeError('response lost'))
  const page = mount(); await waitForDom(() => document.querySelector('.classification-credit-consent input') !== null)
  await acceptBilling()
  await waitForDom(() => !button('Start batch classification').disabled)
  await act(async () => button('Start batch classification').click())
  const first = mocks.create.mock.calls[0]!
  await act(async () => page.unmount()); mount()
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Check result')))
  expect(mocks.create).toHaveBeenCalledTimes(1)
  await act(async () => button('Check result').click())
  const second = mocks.create.mock.calls[1]!
  expect(second[1]).toEqual(first[1]); expect(second[2].intentId).toBe(first[2].intentId)
})
it('cancels with the currently displayed run ETag', async () => {
  mocks.get.mockResolvedValue(run('running')); mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Cancel batch')))
  await act(async () => button('Cancel batch').click())
  await confirmModal()
  expect(mocks.cancel).toHaveBeenCalledWith('library', 'run-1', '"run-1"', expect.objectContaining({ maxRetries: 0 }))
  expect(document.body.textContent).toContain('Batch cancelled.')
})

it('allows manual selection outside model candidates and displays the execution deadline', async () => {
  const snapshot = await mocks.snapshot()
  mocks.snapshot.mockResolvedValue({ ...snapshot, nodes: [...snapshot.nodes, { id: 'manual-folder', parentId: 'root', kind: 'folder', title: 'Manual destination' }] })
  mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 2 selected changes' && !(node as HTMLButtonElement).disabled)))
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Batch review"] select')!
  expect([...select.options].map(option => option.value)).toEqual(['', 'folder', 'manual-folder'])
  expect(document.body.textContent).toContain('Suggestions due by')
  await act(async () => { select.value = 'manual-folder'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => button('Apply 2 selected changes').click())
  await confirmModal()
  expect(mocks.apply.mock.calls[0]?.[2].selections[0].folderId).toBe('manual-folder')
})

it('quotes the actual selected bookmark count when the limit is greater than the selection', async () => {
  mocks.snapshot.mockResolvedValue({ collection: { id: 'library', rootNodeId: 'root', contentRevision: 'c1' }, root: { id: 'root' },
    nodes: [{ id: 'only', parentId: 'root', kind: 'bookmark', title: 'One bookmark' }] })
  mocks.credits.mockResolvedValue({ accountId: 'owner', contractVersion: '1.0.0', asOf: '2026-09-19T00:00:00.000Z', ledgerSequence: '1',
    balance: { available: 1, reserved: 0, nextExpiryAt: null, expiringPoints: 0 },
    prices: [{ operationType: 'bookmark.classify', priceVersion: 'bookmark-classify.v2', unit: 'bookmark', unitPoints: 1 }] })
  mount()
  await waitForDom(() => document.body.textContent?.includes('Up to 1 credits') === true)
  await acceptBilling()
  await act(async () => button('Start batch classification').click())
  expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({ maxItems: 50, billing: { maxPoints: 1, priceVersion: 'bookmark-classify.v2' } })
})

it.each([
  ['managed', 0], ['managed', 100], ['legacy_free', 0], ['legacy_free', 100],
] as const)('uses server billing mode %s for a batch with balance %s', async (mode, available) => {
  mocks.credits.mockResolvedValue({ accountId: 'owner', managedClassificationBillingMode: mode,
    balance: { available }, prices: [{ operationType: 'bookmark.classify', priceVersion: 'v1', unitPoints: 1 }] })
  mount()
  await waitForDom(() => document.body.textContent?.includes('Checking the current credit price') === false
    && document.body.textContent?.includes('No bookmarks match this selection') === false)
  const start = button('Start batch classification')
  if (mode === 'managed') {
    expect(start.disabled).toBe(true)
    if (available === 0) {
      expect(document.body.textContent).toContain('Not enough credits for this batch.')
      expect(mocks.create).not.toHaveBeenCalled()
      return
    }
    await acceptBilling()
  } else {
    expect(document.querySelector('.classification-credit-consent')).toBeNull()
    expect(document.body.textContent).toContain('Platform credits are not charged for this batch.')
  }
  await waitForDom(() => !start.disabled)
  await act(async () => start.click())
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.create.mock.calls[0]?.[1].billing).toEqual(mode === 'managed' ? { priceVersion: 'v1', maxPoints: 50 } : undefined)
})

it('shows loading snapshot message while snapshot is pending', async () => {
  let resolveSnapshot!: (value: unknown) => void
  mocks.snapshot.mockReturnValue(new Promise(res => { resolveSnapshot = res }))
  mount()
  await waitForDom(() => document.body.textContent?.includes('Loading collection…') === true)
  expect(button('Start batch classification').disabled).toBe(true)
  await act(async () => {
    resolveSnapshot({ collection: { id: 'library', rootNodeId: 'root', contentRevision: 'c1' }, root: { id: 'root' },
      nodes: [{ id: 'folder', parentId: 'root', kind: 'folder', title: 'Technology' }, { id: 'node-1', parentId: 'root', kind: 'bookmark', title: 'Bookmark 1' }] })
  })
  await waitForDom(() => document.body.textContent?.includes('Loading collection…') === false)
})

it('does not cancel batch if confirmation is dismissed', async () => {
  mocks.get.mockResolvedValue(run('running')); mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Cancel batch')))
  await act(async () => button('Cancel batch').click())
  await waitForDom(() => document.querySelector('.empty-state-actions .btn-secondary') !== null)
  const cancelDismissBtn = document.querySelector<HTMLButtonElement>('.empty-state-actions .btn-secondary')!
  await act(async () => cancelDismissBtn.click())
  expect(mocks.cancel).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('Batch cancelled.')
})

function ApplyStateProbe() {
  const batch = useClassificationBatch('library', 'probe-session', 'run-1', () => {})
  const [ticks, setTicks] = useState(0)
  const usage = batch.run && 'creditUsage' in batch.run && batch.run.creditUsage.mode === 'managed' ? batch.run.creditUsage : null
  return <>
    <p>status:{batch.run?.status ?? 'none'}</p>
    <p>etag:{batch.run?.etag ?? ''}</p>
    <p>charged:{usage ? usage.chargedPoints : 'none'}</p>
    <p>quoted:{usage ? usage.quotedPoints : 'none'}</p>
    <p>error:{batch.error ?? ''}</p>
    <p>pending:{batch.pending ? 'yes' : 'no'}</p>
    <p>ticks:{ticks}</p>
    <button type="button" disabled={!batch.run || batch.run.status !== 'open' || batch.busy || Boolean(batch.pending) || batch.blocked}
      onClick={() => { if (batch.run) void batch.apply({ selections: [{ actionId: 'action-0', folderId: 'folder', addTags: ['AI'] }] }) }}>Apply probe</button>
    <button type="button" disabled={batch.busy} onClick={() => { void batch.refresh().finally(() => setTicks(value => value + 1)) }}>Refresh probe</button>
  </>
}

it('keeps a confirmed apply visible when the detail refresh fails', async () => {
  const usage = { mode: 'managed' as const, priceVersion: 'bookmark-classify.v2', quotedPoints: 2, reservedPoints: 0, chargedPoints: 2, releasedPoints: 0 }
  const open = { ...run('open'), creditUsage: usage }
  let applied = false
  mocks.get.mockImplementation(() => applied ? Promise.reject(new TypeError('detail refresh failed')) : Promise.resolve(open))
  mocks.apply.mockImplementation(async () => {
    applied = true
    return { runId: 'run-1', status: 'applied', appliedNodeIds: ['node-0'], receipts: [] }
  })
  mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 2 selected changes' && !(node as HTMLButtonElement).disabled)))
  expect(document.body.textContent).toContain('Charged 2 of up to 2 credits.')
  await act(async () => button('Apply 2 selected changes').click())
  await confirmModal()
  await waitForDom(() => {
    const text = document.body.textContent ?? ''
    return text.includes('Selected changes applied.') && text.includes('The detail refresh failed, so the details may be stale.')
  })
  const text = document.body.textContent ?? ''
  expect(text).toContain('Charged 2 of up to 2 credits.')
  expect(text).not.toContain('The result is not confirmed yet')
  expect(text).not.toContain('Could not check batch progress')
  expect(text).not.toContain('This batch expired')
  expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Apply 2 selected changes')).toBe(false)
  expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Check result')).toBe(false)
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  expect(mocks.forget).toHaveBeenCalledTimes(1)
  await act(async () => button('Refresh progress').click())
  await waitForDom(() => document.body.textContent?.includes('Selected changes applied.') === true)
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain('Charged 2 of up to 2 credits.')
  expect(document.body.textContent).toContain('The detail refresh failed, so the details may be stale.')
})

it('does not invent an ETag or credit balance from the apply confirmation', async () => {
  const usage = { mode: 'managed' as const, priceVersion: 'bookmark-classify.v2', quotedPoints: 2, reservedPoints: 0, chargedPoints: 2, releasedPoints: 0 }
  const open = { ...run('open'), creditUsage: usage }
  let stage: 'load' | 'fail' | 'reopen' | 'detail' = 'load'
  mocks.get.mockImplementation(() => {
    if (stage === 'fail') return Promise.reject(new TypeError('detail refresh failed'))
    if (stage === 'reopen') return Promise.resolve({ ...open, status: 'open' as const, etag: '"invented"', creditUsage: { ...usage, chargedPoints: 9, quotedPoints: 9 } })
    if (stage === 'detail') return Promise.resolve({ ...open, status: 'applied' as const, etag: '"run-applied"', creditUsage: usage })
    return Promise.resolve(open)
  })
  mocks.apply.mockImplementation(async () => {
    stage = 'fail'
    return { runId: 'run-1', status: 'applied' as const, appliedNodeIds: ['node-0'], receipts: [] }
  })
  mountTree(<ApplyStateProbe />)
  await waitForDom(() => document.body.textContent?.includes('status:open') === true && document.body.textContent?.includes('charged:2') === true)
  await act(async () => button('Apply probe').click())
  await waitForDom(() => document.body.textContent?.includes('status:applied') === true && document.body.textContent?.includes('detail refresh failed') === true)
  let text = document.body.textContent ?? ''
  expect(text).toContain('etag:"run-1"')
  expect(text).not.toContain('"invented"')
  expect(text).toContain('charged:2')
  expect(text).toContain('quoted:2')
  expect(text).toContain('pending:no')
  expect(button('Apply probe').disabled).toBe(true)
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  stage = 'reopen'
  await act(async () => button('Refresh probe').click())
  await waitForDom(() => document.body.textContent?.includes('ticks:1') === true)
  text = document.body.textContent ?? ''
  expect(text).toContain('status:applied')
  expect(text).toContain('etag:"run-1"')
  expect(text).not.toContain('"invented"')
  expect(text).not.toContain('charged:9')
  expect(text).toContain('charged:2')
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  stage = 'detail'
  await act(async () => button('Refresh probe').click())
  await waitForDom(() => document.body.textContent?.includes('etag:"run-applied"') === true)
  text = document.body.textContent ?? ''
  expect(text).toContain('status:applied')
  expect(text).toContain('ticks:2')
  expect(text).toContain('charged:2')
  expect(text).toContain('quoted:2')
  expect(text).not.toContain('detail refresh failed')
  expect(button('Apply probe').disabled).toBe(true)
  expect(mocks.apply).toHaveBeenCalledTimes(1)
})

it('keeps the same apply command when the confirmation body is not applied', async () => {
  mocks.apply.mockResolvedValueOnce({ runId: 'run-1', status: 'open', appliedNodeIds: [], receipts: [] })
  mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 2 selected changes' && !(node as HTMLButtonElement).disabled)))
  await act(async () => button('Apply 2 selected changes').click())
  await confirmModal()
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Check result')))
  expect(document.body.textContent).toContain('The result is not confirmed yet')
  expect(document.body.textContent).not.toContain('Selected changes applied.')
  expect(mocks.forget).not.toHaveBeenCalled()
  const first = mocks.apply.mock.calls[0]!
  mocks.get.mockResolvedValue(run('applied'))
  await act(async () => button('Check result').click())
  await waitForDom(() => document.body.textContent?.includes('Selected changes applied.') === true)
  const second = mocks.apply.mock.calls[1]!
  expect(mocks.apply).toHaveBeenCalledTimes(2)
  expect(second.slice(0, 4)).toEqual(first.slice(0, 4))
  expect(second[4].intentId).toBe(first[4].intentId)
  expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Check result')).toBe(false)
})

it('retries a timed-out apply with the same command and does not apply again once it is confirmed', async () => {
  mocks.apply.mockRejectedValueOnce(new ProductApiError({
    status: 0, code: 'transport_error', message: 'The request timed out.', recovery: 'same_request', sameRequestRetrySafe: false,
  }))
  mount('run-1')
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 2 selected changes' && !(node as HTMLButtonElement).disabled)))
  await act(async () => button('Apply 2 selected changes').click())
  await confirmModal()
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Check result')))
  expect(document.body.textContent).toContain('The result is not confirmed yet')
  expect(document.body.textContent).not.toContain('Selected changes applied.')
  expect(mocks.forget).not.toHaveBeenCalled()
  expect(mocks.apply).toHaveBeenCalledTimes(1)
  const first = mocks.apply.mock.calls[0]!
  mocks.get.mockResolvedValue(run('applied'))
  await act(async () => button('Check result').click())
  await waitForDom(() => document.body.textContent?.includes('Selected changes applied.') === true)
  expect(mocks.apply).toHaveBeenCalledTimes(2)
  const second = mocks.apply.mock.calls[1]!
  expect(second.slice(0, 4)).toEqual(first.slice(0, 4))
  expect(second[4].intentId).toBe(first[4].intentId)
  expect(mocks.forget).toHaveBeenCalledTimes(1)
  expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Apply 2 selected changes')).toBe(false)
  expect([...document.querySelectorAll('button')].some(node => node.textContent === 'Check result')).toBe(false)
  await act(async () => button('Refresh progress').click())
  expect(mocks.apply).toHaveBeenCalledTimes(2)
})

it('does not apply changes if confirmation is dismissed', async () => {
  mocks.get.mockResolvedValue(run('open', 2, true)); mount()
  await waitForDom(() => document.querySelector('.classification-credit-consent input') !== null)
  await acceptBilling()
  await waitForDom(() => !button('Start batch classification').disabled)
  await act(async () => button('Start batch classification').click())
  await waitForDom(() => Boolean([...document.querySelectorAll('button')].find(node => node.textContent === 'Apply 1 selected changes')))
  mocks.get.mockResolvedValue(run('applied', 2, true))
  await act(async () => button('Apply 1 selected changes').click())
  await waitForDom(() => document.querySelector('.empty-state-actions .btn-secondary') !== null)
  const applyDismissBtn = document.querySelector<HTMLButtonElement>('.empty-state-actions .btn-secondary')!
  await act(async () => applyDismissBtn.click())
  expect(mocks.apply).not.toHaveBeenCalled()
})
