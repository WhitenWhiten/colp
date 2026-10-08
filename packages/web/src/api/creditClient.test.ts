import { seedAuthenticatedSession, resetProductSession } from './test-helpers'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const goldenText = readFileSync(resolve(import.meta.dirname, '../../upstream-fixtures/classification-credits-golden.json'), 'utf8')
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProductTransport } from './product-transport'

describe('credit ledger transport', () => {
  beforeEach(() => seedAuthenticatedSession('csrf-credit-read'))
  afterEach(() => resetProductSession())
  it('reads the shared frozen overview, page and detail fixtures without converting bigint sequences', async () => {
    const fixtures = JSON.parse(goldenText) as { name: string; value: unknown }[]
    const value = (name: string) => fixtures.find(fixture => fixture.name === name)!.value
    const transport = createProductTransport({ baseUrl: 'https://known.example', fetchImpl: vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(value('overview')))
      .mockResolvedValueOnce(Response.json(value('ledger')))
      .mockResolvedValueOnce(Response.json(value('entry'))) })
    expect(await transport.getMyCredits()).toEqual(value('overview'))
    const page = await transport.listMyCreditLedger()
    expect(page).toEqual(value('ledger'))
    expect(page.snapshot.ledgerSequence).toBe('3')
    expect(await transport.getMyCreditLedgerEntry(page.items[0]!.entryId)).toEqual(value('entry'))
  })

  it('sends first-page filters together and continuation cursors alone', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const transport = createProductTransport({ baseUrl: 'https://known.example', fetchImpl })
    await transport.listMyCreditLedger({
      limit: 20,
      kind: 'spend',
      from: '2026-09-19T00:00:00.000Z',
      to: '2026-09-20T00:00:00.000Z',
      chargeId: '20000000-0000-4000-8000-000000000001',
      runId: 'run-1',
    })
    const first = new URL(String(fetchImpl.mock.calls[0]?.[0]))
    expect(first.pathname).toBe('/api/v1/me/credits/ledger')
    expect(first.searchParams.get('kind')).toBe('spend')
    expect(first.searchParams.get('limit')).toBe('20')
    expect(first.searchParams.get('cursor')).toBeNull()

    await transport.listMyCreditLedger({ cursor: 'signed-cursor' })
    const continuation = new URL(String(fetchImpl.mock.calls[1]?.[0]))
    expect([...continuation.searchParams.keys()]).toEqual(['cursor'])
    expect(continuation.searchParams.get('cursor')).toBe('signed-cursor')
  })

  it('routes overview and entry reads through private no-store GET requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const transport = createProductTransport({ baseUrl: 'https://known.example', fetchImpl })
    await transport.getMyCredits()
    await transport.getMyCreditLedgerEntry('10000000-0000-4000-8000-000000000003')
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe('/api/v1/me/credits')
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get('includeBillingMode')).toBe('true')
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).pathname).toBe('/api/v1/me/credits/ledger/10000000-0000-4000-8000-000000000003')
    expect(fetchImpl.mock.calls.every(([, init]) => init?.credentials === 'include')).toBe(true)
  })
})
