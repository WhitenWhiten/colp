// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { useSyncCenterData } from './data'

/**
 * The Sync Center load path orders its own refreshes.
 *
 * `view.tsx` calls `load('refresh')` with NO abort signal, so the signal guard
 * alone cannot order two passes: an older read that settles after a newer one
 * would paint its status, its error, or clear the live pass's busy flags. The
 * hook takes a generation per pass and every settle path has to consult it.
 * These tests drive the deferred resolutions by hand, because the defect is
 * about WHICH settle wins, not about what a single request returns.
 */
const mocks = vi.hoisted(() => ({ status: vi.fn(), conflicts: vi.fn(), trash: vi.fn(), collections: vi.fn() }))
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getSyncStatus: mocks.status,
      loadSyncConflicts: mocks.conflicts,
      loadSyncTrash: mocks.trash,
      getOwnedCollectionsPage: mocks.collections,
    },
  }
})

type Deferred = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  settled: boolean
}

const status = (label: string, collectionId: string) => ({
  generatedAt: '2026-09-18T00:00:00.000Z',
  collections: [],
  replicas: [{ collectionId, replicaId: `replica-${label}`, state: 'active' }],
  label,
}) as never

describe('useSyncCenterData load ordering', () => {
  let statusCalls: Deferred[] = []
  let conflictCalls: Deferred[] = []
  let current!: ReturnType<typeof useSyncCenterData>

  function Probe() {
    current = useSyncCenterData()
    return null
  }

  /** A request that only settles when the test says so. */
  function defer(into: Deferred[]): Promise<never> {
    return new Promise<never>((resolve, reject) => {
      into.push({ resolve: resolve as (value: unknown) => void, reject, settled: false })
    })
  }

  async function resolveStatus(entry: Deferred, value: unknown): Promise<void> {
    entry.settled = true
    await act(async () => { entry.resolve(value); await Promise.resolve() })
  }

  async function resolveConflict(entry: Deferred): Promise<void> {
    entry.settled = true
    await act(async () => { entry.resolve([]); await Promise.resolve() })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    statusCalls = []
    conflictCalls = []
    mocks.status.mockImplementation(() => defer(statusCalls))
    mocks.conflicts.mockImplementation(() => defer(conflictCalls))
    mocks.trash.mockResolvedValue([])
    mocks.collections.mockResolvedValue({ items: [], page: { hasMore: false } })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  async function mountLoaded(collectionId: string): Promise<void> {
    mountTree(<Probe />)
    // StrictMode mounts the effect twice; both passes are satisfied with the
    // same endpoint state, and the second one supersedes the first.
    await waitForDom(() => statusCalls.length >= 2 && conflictCalls.length >= 2)
    // A pass awaits BOTH calls, so the surviving pass needs both halves.
    const load = statusCalls.length - 1
    await resolveConflict(conflictCalls[load]!)
    await resolveStatus(statusCalls[load]!, status('initial', collectionId))
    await waitForDom(() => current.status !== null)
  }

  it('an older refresh that resolves late cannot overwrite the newer status', async () => {
    await mountLoaded('collection-a')
    const initial = current.status

    // Pass 1 (older) stays in flight; pass 2 resolves with the newer status.
    await act(async () => { void current.load('refresh'); await Promise.resolve() })
    await act(async () => { void current.load('refresh'); await Promise.resolve() })
    const older = statusCalls.at(-2)!
    const newer = statusCalls.at(-1)!
    for (const call of conflictCalls.slice(-2)) await resolveConflict(call)
    await resolveStatus(newer, status('newer', 'collection-a'))
    await waitForDom(() => (current.status as { label?: string } | null)?.label === 'newer')

    // The older pass now settles successfully. It must not win.
    await resolveStatus(older, status('older', 'collection-b'))
    expect((current.status as { label?: string } | null)?.label).toBe('newer')
    expect(current.status).not.toBe(initial)
  })

  it('an older refresh that rejects late cannot paint its error over the newer status', async () => {
    await mountLoaded('collection-a')
    await act(async () => { void current.load('refresh'); await Promise.resolve() })
    await act(async () => { void current.load('refresh'); await Promise.resolve() })
    const older = statusCalls.at(-2)!
    const newer = statusCalls.at(-1)!
    for (const call of conflictCalls.slice(-2)) await resolveConflict(call)
    await resolveStatus(newer, status('newer', 'collection-a'))
    await waitForDom(() => (current.status as { label?: string } | null)?.label === 'newer')

    await act(async () => {
      older.reject(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'try later' }))
      await Promise.resolve()
    })
    // Pre-fix this painted `loadError`, and the view's `!loading && !loadError`
    // gate then hid the status the live pass had already loaded.
    expect(current.loadError).toBeNull()
    expect((current.status as { label?: string } | null)?.label).toBe('newer')
  })

  it('a superseded pass does not clear the busy flag of the pass still in flight', async () => {
    await mountLoaded('collection-a')
    await act(async () => { void current.load('refresh'); await Promise.resolve() })
    await act(async () => { void current.load('refresh'); await Promise.resolve() })
    const older = statusCalls.at(-2)!
    const newer = statusCalls.at(-1)!
    for (const call of conflictCalls.slice(-2)) await resolveConflict(call)
    expect(current.refreshing).toBe(true)

    // The older pass fails; the newer one is still in flight.
    await act(async () => {
      older.reject(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'try later' }))
      await Promise.resolve()
    })
    expect(current.refreshing).toBe(true)

    await resolveStatus(newer, status('newer', 'collection-a'))
    await waitForDom(() => current.refreshing === false)
  })
})
