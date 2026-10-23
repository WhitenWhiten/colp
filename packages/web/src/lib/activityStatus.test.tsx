// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivityApi, type ActivityApi } from '../api/activityClient'
import { ProductApiError } from '../api/errors'
import { cleanup, mountTree, settled } from '../test/render'
import { refreshActivitySummary, resetActivityStatus, useActivityStatus } from './activityStatus'

function Harness({ account = 'owner', api }: { account?: string | null; api: ActivityApi }) {
  const status = useActivityStatus(account, api)
  return <output>{JSON.stringify(status)}</output>
}

function fakeApi() {
  return { getActivitySummary: vi.fn(async () => ({ unreadCount: 7, latest: null, revision: '8' })), listActivity: vi.fn(), markActivityRead: vi.fn() }
}

async function advance(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

describe('activity summary status', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    resetActivityStatus()
  })
  afterEach(() => {
    cleanup()
    resetActivityStatus()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('loads and polls every minute, pauses while hidden and refreshes on focus', async () => {
    const api = fakeApi()
    mountTree(<Harness api={api} />)
    await settled()
    expect(document.querySelector('output')?.textContent).toContain('"unreadCount":7')
    const initial = api.getActivitySummary.mock.calls.length
    await advance(60_000)
    expect(api.getActivitySummary).toHaveBeenCalledTimes(initial + 1)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await advance(180_000)
    expect(api.getActivitySummary).toHaveBeenCalledTimes(initial + 1)

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    await settled()
    act(() => window.dispatchEvent(new Event('focus')))
    await settled()
    expect(api.getActivitySummary).toHaveBeenCalledTimes(initial + 3)
    cleanup()
    await advance(60_000)
    expect(api.getActivitySummary).toHaveBeenCalledTimes(initial + 3)
  })

  it('maps an actual endpoint 404 to unavailable and stops polling and focus reads', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 }))
    mountTree(<Harness api={createActivityApi(fetcher)} />)
    await settled()
    expect(document.querySelector('output')?.textContent).toContain('"state":"unavailable"')
    const initial = fetcher.mock.calls.length
    await advance(120_000)
    act(() => window.dispatchEvent(new Event('focus')))
    await settled()
    expect(fetcher).toHaveBeenCalledTimes(initial)
  })

  it('retains a successful answer on transient failure and refreshes after reads', async () => {
    const api = fakeApi()
    mountTree(<Harness api={api} />)
    await settled()
    api.getActivitySummary.mockRejectedValueOnce(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'Busy' }))
    await advance(60_000)
    expect(document.querySelector('output')?.textContent).toContain('"unreadCount":7')
    api.getActivitySummary.mockResolvedValue({ unreadCount: 0, latest: null, revision: '9' })
    await act(async () => refreshActivitySummary())
    expect(document.querySelector('output')?.textContent).toContain('"unreadCount":0')
  })

  it('discards an old account response and clears the count at sign-out', async () => {
    const api = fakeApi()
    let resolveOld: ((value: { unreadCount: number; latest: null; revision: string }) => void) | undefined
    api.getActivitySummary.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const view = mountTree(<Harness api={api} />, { strict: false })
    view.rerender(<Harness api={api} account="other" />)
    await settled()
    await act(async () => resolveOld?.({ unreadCount: 99, latest: null, revision: '99' }))
    expect(document.querySelector('output')?.textContent).toContain('"unreadCount":7')
    view.rerender(<Harness api={api} account={null} />)
    expect(document.querySelector('output')?.textContent).toContain('"state":"unknown"')
    expect(document.querySelector('output')?.textContent).toContain('"unreadCount":0')
  })
})
