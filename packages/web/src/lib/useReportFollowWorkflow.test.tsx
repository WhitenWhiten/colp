// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { useReportFollowWorkflow } from './useReportFollowWorkflow'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getReportFollowState: vi.fn(),
  followReport: vi.fn(),
  unfollowReport: vi.fn(),
  abandonReportFollowIntent: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const REPORT = 'seed-rpt-series-ai-weekly'
type ReportFollowAuthority = { following: boolean; followedAt: string | null; followerCount?: number | null }
let latest: ReturnType<typeof useReportFollowWorkflow> | undefined

function Probe() {
  latest = useReportFollowWorkflow({ reportId: REPORT, enabled: true })
  return <button type="button" onClick={() => void latest?.toggle()}>{latest.status}:{String(latest.following)}</button>
}

/** Same hook, but the series is a prop so a test can change the scope. */
function ScopeProbe({ reportId }: { reportId: string }) {
  latest = useReportFollowWorkflow({ reportId, enabled: true })
  return (
    <span data-testid="follow-scope">
      {latest.status}:{String(latest.following)}:{String(latest.followerCount)}
    </span>
  )
}

/* StrictMode mounts every effect twice (setup -> cleanup -> setup), so a cold
   mount issues TWO authority reads; the first is discarded by the hook's
   operation fence. Fixtures below therefore describe the endpoint's state
   rather than a call sequence, and counts are asserted relative to what the
   mount already made. */
describe('useReportFollowWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks(); latest = undefined; document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function render() { mountTree(<Probe />) }

  it('hides on GET 404 — the owner has no followable surface', async () => {
    mocks.getReportFollowState.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not exposed' }),
    )
    render(); await waitForDom(() => latest != null && latest.status === 'unavailable')
    await act(async () => { await Promise.resolve() })
    /* Two reads is the StrictMode mount itself; a retry after the concealed 404
       would add a third. */
    expect(mocks.getReportFollowState).toHaveBeenCalledTimes(2)
    expect(mocks.followReport).not.toHaveBeenCalled()
  })

  it('drops a self-follow rejection to an authority re-read, then hides on the concealed 404', async () => {
    const visible = { following: false, followedAt: null, followerCount: 12 }
    /* Endpoint state: the series is visible and unfollowed until the owner's
       own follow attempt demotes the surface to concealed. */
    let concealed = false
    mocks.getReportFollowState.mockImplementation(async () => {
      if (concealed) throw new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not exposed' })
      return visible
    })
    /* A self-follow can never succeed, so the endpoint rejects it every time. */
    mocks.followReport.mockRejectedValue(new ProductApiError({
      status: 400, code: 'invalid_request',
      message: 'Owners cannot follow their own report.',
      recovery: 'user_action',
    }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    await act(async () => { await latest?.toggle() })
    expect(latest?.status).toBe('error')
    expect(latest?.retryKind).toBe('authority')
    expect(latest?.message).toMatch(/cannot follow their own report/i)
    const readsAfterMount = mocks.getReportFollowState.mock.calls.length
    concealed = true
    await act(async () => { await latest?.retry() })
    await waitForDom(() => latest != null && latest.status === 'unavailable')
    /* Retry means "retry status": one authority re-read, and the intent that can
       never succeed is not re-issued. */
    expect(mocks.followReport).toHaveBeenCalledTimes(1)
    expect(mocks.getReportFollowState.mock.calls.length - readsAfterMount).toBe(1)
  })

  it('keeps unknown outcome retry on the exact intent and resolves from server authority', async () => {
    const notFollowing = { following: false, followedAt: null, followerCount: 0 }
    const followed = { following: true, followedAt: '2026-09-14T01:00:00.000Z', followerCount: 1 }
    let following = false
    mocks.getReportFollowState.mockImplementation(async () => (following ? followed : notFollowing))
    /* The first attempt dies in transport; the exact-intent retry is the one
       that lands, and only then does authority report the new state. */
    mocks.followReport
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }))
      .mockImplementation(async () => { following = true; return followed })
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    await act(async () => { await latest?.toggle() }); expect(latest?.status).toBe('unknown')
    await act(async () => { await latest?.retryExact() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(mocks.followReport.mock.calls[1]?.[1]?.intentId).toBe(mocks.followReport.mock.calls[0]?.[1]?.intentId)
    expect(latest?.following).toBe(true)
  })

  it('cancels the in-flight authority read on unmount and drops its late answer', async () => {
    /* The read is held open, so unmount lands while the request is genuinely in
       flight — the exact window an uncancellable request keeps running in. */
    const resolvers: ((value: ReportFollowAuthority) => void)[] = []
    const signals: (AbortSignal | undefined)[] = []
    mocks.getReportFollowState.mockImplementation((
      _reportId: string,
      options?: { signal?: AbortSignal },
    ) => {
      signals.push(options?.signal)
      return new Promise<ReportFollowAuthority>((resolve) => { resolvers.push(resolve) })
    })
    render()
    await waitForDom(() => signals.length > 0)
    const inFlight = signals.at(-1)
    /* The authority read must carry a caller-owned cancellation signal. */
    expect(inFlight).toBeInstanceOf(AbortSignal)
    cleanup()
    /* Unmount aborts it instead of letting it run to completion. */
    expect(inFlight?.aborted).toBe(true)
    await act(async () => {
      for (const resolve of resolvers) resolve({ following: true, followedAt: null, followerCount: 9 })
      await Promise.resolve()
    })
    /* And its late answer paints nothing. */
    expect(latest?.following).toBe(false)
    expect(latest?.followerCount).toBeNull()
    expect(latest?.status).toBe('loading')
  })

  it('cancels the previous series authority read when the scope changes', async () => {
    const other = 'seed-rpt-series-other'
    const resolvers = new Map<string, (value: ReportFollowAuthority) => void>()
    mocks.getReportFollowState.mockImplementation((reportId: string) => (
      new Promise<ReportFollowAuthority>((resolve) => { resolvers.set(reportId, resolve) })
    ))
    mountTree(<ScopeProbe reportId={REPORT} />)
    await waitForDom(() => resolvers.has(REPORT))
    const previousCall = mocks.getReportFollowState.mock.calls
      .filter((call) => call[0] === REPORT).at(-1)
    const previousSignal = previousCall?.[1]?.signal as AbortSignal | undefined
    expect(previousSignal).toBeInstanceOf(AbortSignal)
    expect(previousSignal?.aborted).toBe(false)

    mountTree(<ScopeProbe reportId={other} />)
    await waitForDom(() => resolvers.has(other))
    /* The scope change aborts the abandoned series' read. */
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => {
      resolvers.get(REPORT)?.({ following: true, followedAt: null, followerCount: 7 })
      await Promise.resolve()
    })
    /* The abandoned series' late answer never paints over the new scope. */
    expect(latest?.following).toBe(false)
    expect(latest?.followerCount).toBeNull()
  })
})
