// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { useCollectionEditorSnapshot } from './data'

/**
 * A hydration failure is not a load failure.
 *
 * Applying a SUCCESSFUL snapshot can still throw (the editor's tree model, the
 * draft store, a page-size guard). That exception has three possible homes, and
 * only one of them is honest:
 *
 *   - inside the load try   → reported as "Couldn't load this collection" with the
 *                             raw internal message, which blames the wrong step;
 *   - swallowed             → the editor shows a PARTIALLY applied snapshot with
 *                             no indication anything went wrong;
 *   - its own catch here    → the snapshot stays on screen and the failure is
 *                             attributed to preparation.
 *
 * The hook must take the third. The tests below pin the attribution, not just
 * the presence of an error state, because both earlier versions produced an
 * error or silence.
 */
const mocks = vi.hoisted(() => ({ loadEditorSnapshot: vi.fn() }))
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    productClient: { ...actual.productClient, loadEditorSnapshot: mocks.loadEditorSnapshot },
  }
})

const snapshot = () => ({
  snapshotId: 'snapshot-1',
  collectionId: 'collection-1',
  etag: '"snapshot-1"',
  nodes: [],
  nextCursor: null,
  generatedAt: '2026-09-18T00:00:00.000Z',
}) as never

describe('useCollectionEditorSnapshot hydration failures', () => {
  let current!: ReturnType<typeof useCollectionEditorSnapshot>
  let navigate = vi.fn()
  /**
   * ONE ref object per test. A fresh `{ current }` on every render changes the
   * hook's `reload` identity, which re-runs the load effect, which re-renders:
   * the first version of this file looped until the heap ran out.
   */
  const onReadyRef: { current: (snap: unknown) => void } = { current: () => undefined }

  function Probe() {
    current = useCollectionEditorSnapshot({
      collectionId: 'collection-1',
      isLoggedIn: true,
      bootstrapping: false,
      navigate: navigate as never,
      onSnapshotReadyRef: onReadyRef as never,
    })
    return null
  }

  beforeEach(() => {
    vi.clearAllMocks()
    navigate = vi.fn()
    onReadyRef.current = () => undefined
    mocks.loadEditorSnapshot.mockResolvedValue(snapshot())
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  it('attributes a hydration failure to preparation and keeps the snapshot', async () => {
    const failure = new Error('tree model rejected the snapshot')
    onReadyRef.current = () => { throw failure }
    mountTree(<Probe />)

    await waitForDom(() => current.load.status !== 'loading')
    expect(current.load.status).toBe('error')
    expect(current.load).toEqual({
      status: 'error',
      error: failure,
      hint: 'This collection loaded, but part of it could not be prepared for editing.',
    })
    // Not a load failure: no navigation, and the snapshot was applied before the
    // failure was raised, so the editor is not sent back to the list.
    expect(navigate).not.toHaveBeenCalled()
  })

  it('keeps a normal load ready and does not call the error path', async () => {
    mountTree(<Probe />)

    await waitForDom(() => current.load.status === 'ready')
    expect(current.snap).not.toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('still reports a load failure as a load failure', async () => {
    mocks.loadEditorSnapshot.mockRejectedValue(new Error('snapshot endpoint unavailable'))
    mountTree(<Probe />)

    await waitForDom(() => current.load.status !== 'loading')
    expect(current.load.status).toBe('error')
    // The hydration hint must not be used for a request that never returned: the
    // two failures are distinguishable by their hint.
    expect((current.load as { hint?: string }).hint)
      .not.toBe('This collection loaded, but part of it could not be prepared for editing.')
  })
})
