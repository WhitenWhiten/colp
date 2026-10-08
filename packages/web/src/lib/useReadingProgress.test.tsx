// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { useReadingProgress, useReadingProgressList } from './useReadingProgress'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), reset: vi.fn(), abandon: vi.fn(), list: vi.fn(), sequence: 0 }))
vi.mock('../api', async (importOriginal) => { const actual = await importOriginal<typeof import('../api')>(); return { ...actual, productClient: { ...actual.productClient,
  getReadingProgress: mocks.get, putReadingProgress: mocks.put, resetReadingProgress: mocks.reset,
  loadReadingProgress: mocks.list,
  abandonReadingProgressIntent: mocks.abandon, newCommandId: () => `command-${++mocks.sequence}`,
  mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
} } })

function Harness({ id = 'node-1' }: { id?: string }) {
  const progress = useReadingProgress({ resourceType: 'node', resourceId: id, debounceMs: 400, maxWaitMs: 1200 })
  return <div data-testid="state" data-progress={progress.progress} data-status={progress.status} data-save-state={progress.saveState}>
    <button onClick={() => progress.setProgress(0.1)}>10</button><button onClick={() => progress.setProgress(0.4)}>40</button><button onClick={() => progress.setProgress(0.8)}>80</button><button onClick={() => progress.setProgress(0.9)}>90</button><button onClick={() => progress.setProgress(0.95)}>95</button>
    <button onClick={progress.toggleComplete}>{progress.status === 'completed' ? 'Uncomplete' : 'Complete'}</button>
    <button onClick={progress.retry}>Retry</button><button onClick={progress.flush}>Flush</button><button onClick={progress.reload}>Reload</button>
  </div>
}
const remote = (progress = 0, status: 'not_started' | 'in_progress' | 'completed' = 'not_started', etag = '"r1"') => ({
  resourceType: 'node' as const, resourceId: 'node-1', status, progress, completedAt: status === 'completed' ? '2026-07-25T00:00:00Z' : null,
  updatedAt: '2026-07-25T00:00:00Z', etag, target: { availability: 'available' as const, collectionId: 'c1', title: 'Node', url: null },
})

describe('authoritative Reading Progress workflow', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); mocks.sequence = 0; document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
    applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
    mocks.get.mockResolvedValue(remote()); mocks.put.mockImplementation((_t, _id, body) => Promise.resolve({ ...body, completedAt: body.status === 'completed' ? '2026-07-25T00:00:00Z' : null, updatedAt: '2026-07-25T00:00:01Z', etag: '"r2"' })); mocks.reset.mockResolvedValue(undefined)
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = ''; vi.useRealTimers() })
  function render(id?: string) { mountTree(<Harness id={id} />) }

  it('coalesces rapid unsent progress, flushes microtasks, and enforces bounded max wait with real call counts', async () => {
    render(); await waitForDom(domFinishedLoading); const buttons = document.querySelectorAll('button')
    act(() => { (buttons[0] as HTMLButtonElement).click(); vi.advanceTimersByTime(300); (buttons[1] as HTMLButtonElement).click(); vi.advanceTimersByTime(300); (buttons[2] as HTMLButtonElement).click() })
    expect(mocks.put).toHaveBeenCalledTimes(0)
    await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.put).toHaveBeenCalledTimes(1); expect(mocks.put.mock.calls[0]![2]).toEqual({ status: 'in_progress', progress: 0.8 })
    act(() => { (buttons[3] as HTMLButtonElement).click(); vi.advanceTimersByTime(350); (buttons[4] as HTMLButtonElement).click(); vi.advanceTimersByTime(350); (buttons[4] as HTMLButtonElement).click(); vi.advanceTimersByTime(350); (buttons[4] as HTMLButtonElement).click() })
    await act(async () => { vi.advanceTimersByTime(150); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.put).toHaveBeenCalledTimes(2)
  })

  it('flushes pending progress on pagehide and completion is immediate and reversible', async () => {
    render(); await waitForDom(domFinishedLoading); const buttons = document.querySelectorAll('button')
    act(() => (buttons[1] as HTMLButtonElement).click()); act(() => window.dispatchEvent(new Event('pagehide'))); await waitForDom(domFinishedLoading)
    expect(mocks.put).toHaveBeenCalledTimes(1)
    act(() => (buttons[5] as HTMLButtonElement).click()); await waitForDom(domFinishedLoading); expect(mocks.put.mock.calls.at(-1)?.[2]).toEqual({ status: 'completed', progress: 1 })
    act(() => (buttons[5] as HTMLButtonElement).click()); await waitForDom(domFinishedLoading); expect(mocks.put.mock.calls.at(-1)?.[2]).toEqual({ status: 'in_progress', progress: 0.4 })
  })

  it('resolves toggleComplete as saved only after PUT succeeds, and as error after PUT fails', async () => {
    let finishPut: ((value: unknown) => void) | undefined
    mocks.put.mockImplementationOnce(() => new Promise((resolve) => { finishPut = resolve }))
    let outcome: string | undefined
    function Capture() {
      const progress = useReadingProgress({ resourceType: 'node', resourceId: 'node-1', debounceMs: 400, maxWaitMs: 1200 })
      return <button type="button" onClick={() => { void progress.toggleComplete().then((value) => { outcome = value }) }}>Go</button>
    }
    mountTree(<Capture />); await waitForDom(domFinishedLoading)
    act(() => document.querySelector('button')!.click())
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(finishPut).toBeDefined()
    expect(outcome).toBeUndefined()
    await act(async () => {
      finishPut?.({ status: 'completed', progress: 1, completedAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:01Z', etag: '"r2"' })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(outcome).toBe('saved')

    outcome = undefined
    mocks.put.mockRejectedValueOnce(new ProductApiError({ status: 500, code: 'internal_error', message: 'boom', recovery: 'refresh_and_retry', sameRequestRetrySafe: false }))
    act(() => document.querySelector('button')!.click())
    await waitForDom(domFinishedLoading)
    expect(outcome).toBe('error')
  })

  it('retains the exact intent after unknown outcome and replays it only on explicit retry', async () => {
    mocks.put.mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'lost', recovery: 'same_request', sameRequestRetrySafe: true })).mockResolvedValueOnce({ status: 'in_progress', progress: 0.4, completedAt: null, updatedAt: '2026-07-25T00:00:01Z', etag: '"r2"' })
    render(); await waitForDom(domFinishedLoading); const buttons = document.querySelectorAll('button'); act(() => (buttons[1] as HTMLButtonElement).click())
    await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('[data-testid="state"]')?.getAttribute('data-save-state')).toBe('unknown')
    act(() => (buttons[6] as HTMLButtonElement).click()); await waitForDom(domFinishedLoading)
    expect(mocks.put.mock.calls[1]![4].intentId).toBe(mocks.put.mock.calls[0]![4].intentId)
  })

  it('refreshes on 412 and replaces the optimistic proposal with server authority', async () => {
    /* Endpoint state, not a call sequence: the stored value is still the old
       one until a write is rejected for a stale fence, after which every read
       reports the newer 0.9. Any number of initial mounts therefore see the
       same pre-write state. */
    let writeRejectedAsStale = false
    mocks.get.mockImplementation(() => Promise.resolve(writeRejectedAsStale ? remote(0.9, 'in_progress', '"r3"') : remote()))
    mocks.put.mockImplementation(() => {
      writeRejectedAsStale = true
      return Promise.reject(new ProductApiError({ status: 412, code: 'precondition_failed', message: 'stale', recovery: 'refresh_and_retry', sameRequestRetrySafe: false, currentEtag: '"r3"' }))
    })
    render(); await waitForDom(domFinishedLoading); const buttons = document.querySelectorAll('button')
    const readsBeforeWrite = mocks.get.mock.calls.length
    act(() => (buttons[1] as HTMLButtonElement).click()); await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.put).toHaveBeenCalledTimes(1)
    // The 412 triggers exactly one authoritative refresh (no retry loop), and
    // its value replaces the optimistic 0.4.
    expect(mocks.get.mock.calls.length).toBe(readsBeforeWrite + 1)
    expect(document.querySelector('[data-testid="state"]')?.getAttribute('data-progress')).toBe('0.9')
  })

  it('generation-fences a late read after a newer focus refresh', async () => {
    let finishLate: ((value: unknown) => void) | undefined
    /* The endpoint's current value is the server's newer 0.9; only the first
       read is held open so a stale in-flight result can be released later. */
    mocks.get.mockImplementationOnce(() => new Promise((resolve) => { finishLate = resolve })).mockResolvedValue(remote(0.9, 'in_progress', '"r3"'))
    render(); await waitForDom(domFinishedLoading); act(() => window.dispatchEvent(new Event('focus'))); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="state"]')?.getAttribute('data-progress')).toBe('0.9')
    await act(async () => { finishLate?.(remote(0.4, 'in_progress', '"r2"')); await Promise.resolve() })
    expect(document.querySelector('[data-testid="state"]')?.getAttribute('data-progress')).toBe('0.9')
  })

  it('does not let a refresh strand a pending write or its queued completion', async () => {
    /* The endpoint as a state machine: the in-progress write is held open and
       the completion write succeeds. Keyed on the request, so the fixture does
       not depend on how many mount-time calls React makes. */
    let finishProgress: ((value: ReturnType<typeof remote>) => void) | undefined
    mocks.put.mockImplementation((_t, _id, body) => (
      body.status === 'completed'
        ? Promise.resolve({ ...body, completedAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:02Z', etag: '"r3"' })
        : new Promise((resolve) => { finishProgress = resolve })
    ))
    render(); await waitForDom(domFinishedLoading); const buttons = document.querySelectorAll('button')
    act(() => (buttons[1] as HTMLButtonElement).click())
    await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve() })
    expect(mocks.put).toHaveBeenCalledTimes(1)
    const readsBeforeReload = mocks.get.mock.calls.length
    act(() => { (buttons[8] as HTMLButtonElement).click(); (buttons[5] as HTMLButtonElement).click() })
    await waitForDom(domFinishedLoading)
    // A reload while a write is in flight neither re-reads the resource (that
    // would strand the optimistic write) nor re-issues the put.
    expect(mocks.get.mock.calls.length).toBe(readsBeforeReload)
    expect(mocks.put).toHaveBeenCalledTimes(1)
    await act(async () => { finishProgress?.(remote(0.4, 'in_progress', '"r2"')); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.put).toHaveBeenCalledTimes(2); expect(mocks.put.mock.calls[1]![2]).toEqual({ status: 'completed', progress: 1 })
  })

  it('keeps an immediate completion bound to the resource active when it was queued', async () => {
    render('node-1'); await waitForDom(domFinishedLoading); const complete = document.querySelectorAll('button')[5] as HTMLButtonElement
    act(() => { complete.click(); mountTree(<Harness id="node-2" />) })
    await waitForDom(domFinishedLoading)
    expect(mocks.put).toHaveBeenCalledTimes(1)
    expect(mocks.put.mock.calls[0]?.slice(0, 3)).toEqual(['node', 'node-1', { status: 'completed', progress: 1 }])
  })

  it('aborts private work and reloads cleanly across account and Session epochs', async () => {
    const signals: AbortSignal[] = []
    mocks.get.mockImplementation((_t, _id, options) => { signals.push(options.signal); return new Promise(() => {}) })
    render(); await waitForDom(domFinishedLoading)
    const readsBeforeIdentityChange = mocks.get.mock.calls.length
    await act(async () => { applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } }); await Promise.resolve(); await Promise.resolve() })
    // Every read for the previous identity is aborted; the new identity issues exactly one fresh read.
    expect(signals.slice(0, readsBeforeIdentityChange).every((signal) => signal.aborted)).toBe(true)
    expect(mocks.get.mock.calls.length).toBe(readsBeforeIdentityChange + 1)
    expect(signals.at(-1)?.aborted).toBe(false)
    const readsBeforeRotation = mocks.get.mock.calls.length
    await act(async () => { applySessionView({ authenticated: true, csrfToken: 'rotated', idleExpiresAt: '2026-07-25T02:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' }); await Promise.resolve(); await Promise.resolve() })
    expect(mocks.get.mock.calls.length).toBe(readsBeforeRotation + 1)
    expect(signals.at(-1)?.aborted).toBe(false)
    await act(async () => { clearSession(); await Promise.resolve(); await Promise.resolve() }); expect(document.querySelector('[data-testid="state"]')?.getAttribute('data-progress')).toBe('0')
  })
})

/**
 * The Path Reader switches the tracked resource on every step click. Each
 * switch reads the new resource; if that read broadcast unconditionally, the
 * progress list reloaded and emptied itself, so the progress bar and every
 * done marker flashed off and back — reading as a full page reload.
 */
describe('Reading Progress fan-out', () => {
  const renders: Array<{ count: number; state: string }> = []

  function Harness({ id }: { id: string }) {
    const item = useReadingProgress({ resourceType: 'node', resourceId: id })
    const list = useReadingProgressList()
    renders.push({ count: list.items.length, state: list.state })
    return <div data-testid="fanout" data-count={list.items.length} data-state={list.state} data-status={item.status} />
  }

  beforeEach(() => {
    vi.clearAllMocks(); renders.length = 0; document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
    applyMeView({ account: { id: 'account-fanout', email: 'f@test' }, profile: { id: 'profile-f', handle: 'f', displayName: 'F', avatarUrl: null } })
    mocks.get.mockResolvedValue(remote())
    mocks.list.mockResolvedValue([remote(1, 'completed'), remote(0.5, 'in_progress')])
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })
  function render(id: string) { mountTree(<Harness id={id} />) }

  it('does not broadcast a read that only confirms the cached value', async () => {
    const seen: Event[] = []
    const listener = (event: Event) => seen.push(event)
    window.addEventListener('known-reading-progress', listener)
    try {
      render('node-1'); await waitForDom(domFinishedLoading)
      const listCalls = mocks.list.mock.calls.length
      seen.length = 0

      act(() => window.dispatchEvent(new Event('focus'))); await waitForDom(domFinishedLoading)

      expect(mocks.get.mock.calls.length).toBeGreaterThan(1)
      expect(seen).toHaveLength(0)
      // The focus refresh reloads the list once; the confirming read adds none.
      expect(mocks.list.mock.calls.length).toBe(listCalls + 1)
    } finally {
      window.removeEventListener('known-reading-progress', listener)
    }
  })

  it('keeps the completed rows on screen while a step change revalidates', async () => {
    render('node-1'); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="fanout"]')?.getAttribute('data-count')).toBe('2')
    const settled = renders.length

    // Hold the refetch open so the window where the list could be empty is
    // actually observable instead of being batched away.
    let releaseList: ((rows: ReturnType<typeof remote>[]) => void) | undefined
    mocks.list.mockImplementationOnce(() => new Promise((resolve) => { releaseList = resolve }))

    mountTree(<Harness id="node-2" />)
    await waitForDom(domFinishedLoading)

    expect(releaseList).toBeDefined()
    expect(renders.slice(settled).every(({ count }) => count === 2)).toBe(true)
    expect(renders.slice(settled).every(({ state }) => state !== 'loading')).toBe(true)

    await act(async () => { releaseList?.([remote(1, 'completed')]); await Promise.resolve() })
    expect(document.querySelector('[data-testid="fanout"]')?.getAttribute('data-count')).toBe('1')
  })
})
