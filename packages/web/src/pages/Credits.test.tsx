// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CreditLedgerEntry, CreditLedgerPage } from '../api'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../test/render'
import { Credits } from './Credits'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  origin: '', epoch: 0,
  user: { accountId: 'account-1' } as { accountId: string } | null,
}))

vi.mock('../api/config', () => ({ getApiBaseUrl: () => mocks.origin, apiUrl: (path: string) => mocks.origin + path }))
vi.mock('../api/sessionStore', async original => ({
  ...await original<typeof import('../api/sessionStore')>(),
  getSessionSnapshot: () => ({ sessionEpoch: mocks.epoch }),
}))
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, bootstrapping: false }),
}))
vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      listMyCreditLedger: mocks.list,
      getMyCreditLedgerEntry: mocks.detail,
      subscribeSession: mocks.subscribe,
    },
  }
})

const entry: CreditLedgerEntry = {
  entryId: '10000000-0000-4000-8000-000000000003', sequence: '3', kind: 'spend',
  postedAt: '2026-09-19T00:59:59.000Z', effectiveAt: '2026-09-19T00:59:59.000Z',
  pointsDelta: -1, availableDelta: 0, reservedDelta: -1, expiredPoints: 0,
  balanceAfter: { available: 99, reserved: 0 }, operationType: 'bookmark.classify', source: 'web',
  reasonCode: 'classification_completed', grantId: null,
  chargeId: '20000000-0000-4000-8000-000000000001',
  relatedEntryId: '10000000-0000-4000-8000-000000000002', expiresAt: null,
  task: { kind: 'classification_preview', collectionId: 'collection-1', nodeId: null, runId: null, actionId: null },
}

const page: CreditLedgerPage = {
  contractVersion: '1.0.0', accountId: 'account-1',
  snapshot: {
    asOf: '2026-09-19T01:00:00.000Z', ledgerSequence: '3',
    balance: { available: 99, reserved: 0, nextExpiryAt: '2026-09-19T16:00:00.000Z', expiringPoints: 99 },
  }, items: [entry], nextCursor: 'cursor-1',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.origin = ''; mocks.epoch = 0
  mocks.user = { accountId: 'account-1' }
  mocks.list.mockResolvedValue(page)
  mocks.detail.mockResolvedValue({ contractVersion: '1.0.0', entry })
})
afterEach(() => cleanup())

describe('Credits page', () => {
  it('loads one snapshot, opens deep-linked entry details, and does not issue a separate balance read', async () => {
    mountTree(<Credits />, { route: `/credits?entryId=${entry.entryId}` })
    await waitForDom(() => document.querySelector('[data-testid="credits-page"]')?.textContent?.includes('Ledger entry') === true)
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }), expect.objectContaining({ maxRetries: 0 }))
    expect(mocks.detail).toHaveBeenCalledWith(entry.entryId, expect.objectContaining({ maxRetries: 0 }))
    expect(document.body.textContent).toContain('Classification completed')
    expect(document.body.textContent).toContain('99')
  })

  it('keeps snapshot filters and uses the signed cursor for older entries', async () => {
    mocks.list.mockImplementation((params?: { readonly cursor?: string }) =>
      Promise.resolve(params?.cursor ? { ...page, items: [], nextCursor: null } : page))
    mountTree(<Credits />, { route: '/credits?kind=spend' })
    await waitForDom(() => document.querySelector('[data-testid="credits-page"]')?.textContent?.includes('Classification completed') === true)
    expect(mocks.list.mock.calls[0]?.[0]).toMatchObject({ kind: 'spend' })
    await act(async () => findButtonByName('Load more').click())
    expect(mocks.list.mock.calls.at(-1)?.[0]).toEqual({ cursor: 'cursor-1' })
  })
  it('opens detail without replacing an already extended snapshot', async () => {
    mocks.list.mockImplementation((query?: { cursor?: string }) => Promise.resolve(query?.cursor
      ? { ...page, items: [{ ...entry, entryId: '10000000-0000-4000-8000-000000000004', sequence: '2' }], nextCursor: null }
      : page))
    mountTree(<Credits />, { route: '/credits' })
    await waitForDom(() => document.querySelectorAll('[aria-label="Credit ledger entries"] [role="cell"] time').length === 1)
    await act(async () => findButtonByName('Load more').click())
    await waitForDom(() => document.querySelectorAll('[aria-label="Credit ledger entries"] [role="cell"] time').length === 2)
    const beforeDetail = mocks.list.mock.calls.length
    await act(async () => (document.querySelector('[aria-label="Credit ledger entries"] [role="cell"] time') as HTMLElement).click())
    await waitForDom(() => document.querySelector('[aria-label="Ledger entry details"]') !== null)
    expect(mocks.list).toHaveBeenCalledTimes(beforeDetail)
    expect(document.querySelectorAll('[aria-label="Credit ledger entries"] [role="cell"] time')).toHaveLength(2)
  })

  it.each(['account', 'server', 'generation'])('clears old data and rejects late failures after %s changes', async change => {
    let rejectOld!: (error: Error) => void
    mocks.list.mockImplementation((query?: { cursor?: string }) => query?.cursor
      ? new Promise((_resolve, reject) => { rejectOld = reject }) : Promise.resolve(page))
    const tree = mountTree(<Credits />, { route: '/credits' })
    await waitForDom(() => document.querySelector('[aria-label="Credit ledger entries"] [role="cell"] time') !== null)
    await act(async () => findButtonByName('Load more').click())
    if (change === 'account') mocks.user = { accountId: 'account-2' }
    if (change === 'server') mocks.origin = 'https://second.known.example'
    if (change === 'generation') mocks.epoch++
    mocks.list.mockResolvedValue({ ...page, accountId: mocks.user!.accountId, items: [], nextCursor: null,
      snapshot: { ...page.snapshot, balance: { available: 7, reserved: 0, nextExpiryAt: null, expiringPoints: 0 } } })
    tree.rerender(<Credits />)
    expect(document.querySelectorAll('[aria-label="Credit ledger entries"] [role="cell"] time')).toHaveLength(0)
    await waitForDom(() => document.body.textContent?.includes('No credit activity yet') === true)
    await act(async () => rejectOld(new Error('old authority failed')))
    expect(document.body.textContent).not.toContain('Classification completed')
    expect(document.body.textContent).not.toContain("Couldn't load more history")
    expect(document.querySelector('[aria-label="Credit balance"] strong')?.textContent).toBe('7')
  })

})
