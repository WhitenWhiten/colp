// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { ReadableReplicaView } from '../api/types'
import { clearRouteCache } from './routeCache'
import { useReadableReplica } from './useReadableReplica'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  enqueue: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getNodeReadableReplica: mocks.get,
      enqueueNodeReadableExtract: mocks.enqueue,
      mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
    },
  }
})

function view(overrides: Partial<ReadableReplicaView> = {}): ReadableReplicaView {
  return {
    nodeId: 'node-1',
    collectionId: 'col-1',
    status: 'ready',
    sourceUrl: 'https://example.test/article',
    title: 'Title',
    byline: null,
    wordCount: 200,
    extractedAt: '2026-08-25T00:00:00.000Z',
    failureCode: null,
    sections: [{ id: 'sec-1', heading: 'Opening', paragraphs: [{ id: 'p-1', text: 'Hello' }] }],
    etag: '"rr-1"',
    ...overrides,
  }
}

function Harness() {
  const replica = useReadableReplica({ collectionId: 'col-1', nodeId: 'node-1', enabled: true })
  return (
    <div
      data-testid="replica"
      data-status={replica.status}
      data-sections={String(replica.sections.length)}
      data-poll-exhausted={replica.pollExhausted ? 'true' : 'false'}
    >
      <button type="button" onClick={() => replica.retry(true)}>retry</button>
    </div>
  )
}

describe('useReadableReplica transport errors', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.get.mockResolvedValue(view())
    mocks.enqueue.mockResolvedValue(view({ status: 'pending', sections: [], wordCount: 0 }))
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    document.body.innerHTML = ''
  })

  function render(): void {
    mountTree(<Harness />)
  }

  function replicaAttribute(name: string): string | null {
    return document.querySelector('[data-testid="replica"]')?.getAttribute(name) ?? null
  }

  it('keeps the last ready replica when retry is rate-limited', async () => {
    mocks.enqueue.mockRejectedValue(new ProductApiError({
      status: 429, code: 'rate_limited', message: 'wait', recovery: 'same_request',
    }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-status')).toBe('ready')
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-sections')).toBe('1')
    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-status')).toBe('ready')
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-sections')).toBe('1')
  })

  it('clears sections when extract fails with a non-rate-limit error', async () => {
    mocks.enqueue.mockRejectedValue(new ProductApiError({
      status: 409, code: 'command_id_reused', message: 'conflict', recovery: 'user_action',
    }))
    render()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-status')).toBe('failed')
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-sections')).toBe('0')
  })

  it('treats a rate-limited auto extract as pending and polls for the server result', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    /* The GET endpoint, not a call queue: nothing is readable until the
       server-side extraction that caused the 429 finishes, and it finishes by
       the next poll tick. Every read before that returns `none`, so the
       fixture survives any number of initial mounts. */
    const unextracted = view({
      status: 'none', sections: [], wordCount: 0, title: null, byline: null, extractedAt: null, etag: null,
    })
    let extractionFinished = false
    mocks.get.mockImplementation(() => Promise.resolve(extractionFinished ? view() : unextracted))
    mocks.enqueue.mockImplementation(() => {
      extractionFinished = true
      return Promise.reject(new ProductApiError({
        status: 429, code: 'rate_limited', message: 'wait', recovery: 'same_request',
      }))
    })
    render()
    await waitForDom(() => replicaAttribute('data-status') === 'pending')
    // The auto-extract is posted once, not once per mount.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(replicaAttribute('data-sections')).toBe('0')
    expect(replicaAttribute('data-poll-exhausted')).toBe('false')
    const readsBeforePoll = mocks.get.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => replicaAttribute('data-status') === 'ready')
    expect(replicaAttribute('data-sections')).toBe('1')
    // One poll tick issues exactly one read (of the same coordinates).
    expect(mocks.get).toHaveBeenCalledTimes(readsBeforePoll + 1)
    expect(mocks.get).toHaveBeenLastCalledWith('col-1', 'node-1', expect.objectContaining({ maxRetries: 0 }))
  })

  it('moves a failed replica to pending when a forced retry is rate-limited', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.get.mockResolvedValue(view({
      status: 'failed', sections: [], wordCount: 0, title: null, byline: null, failureCode: 'timeout',
    }))
    mocks.enqueue.mockRejectedValue(new ProductApiError({
      status: 429, code: 'rate_limited', message: 'wait', recovery: 'same_request',
    }))
    render()
    await waitForDom(() => replicaAttribute('data-status') === 'failed')
    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => replicaAttribute('data-status') === 'pending')
    expect(mocks.enqueue).toHaveBeenCalledWith(
      'col-1', 'node-1', { force: true },
      expect.objectContaining({ intentId: 'readable-replica-extract:col-1:node-1:force' }),
    )
    // Polling is live again: the next tick asks the server for the result.
    await act(async () => {
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    await waitForDom(() => mocks.get.mock.calls.length >= 2)
  })

  it('marks polling exhausted after 15 pending ticks', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.get.mockResolvedValue(view({
      status: 'pending', sections: [], wordCount: 0, title: null, byline: null, extractedAt: null,
    }))
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-status')).toBe('pending')
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-poll-exhausted')).toBe('false')
    await act(async () => {
      vi.advanceTimersByTime(16 * 2000)
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-status')).toBe('pending')
    expect(document.querySelector('[data-testid="replica"]')?.getAttribute('data-poll-exhausted')).toBe('true')
  })
})
