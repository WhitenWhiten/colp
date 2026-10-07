// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, mountTree } from '../test/render'
import {
  LINK_PREVIEW_REFRESH_DELAY_MS,
  LINK_PREVIEW_MAX_REFRESHES,
  LINK_PREVIEW_REQUEST_DEBOUNCE_MS,
  resetLinkPreviewRequestsForTests,
  useLinkPreviewRequests,
} from './useLinkPreviewRequests'

const mocks = vi.hoisted(() => ({
  requestLinkPreviews: vi.fn(),
  live: true,
}))

vi.mock('../api', () => ({
  isLive: () => mocks.live,
  isProductApiError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
  productClient: {
    requestLinkPreviews: mocks.requestLinkPreviews,
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
    newCommandId: () => 'cmd',
  },
}))

function Probe(props: { collectionId: string | null; enabled: boolean; ids: string[]; onRefresh: () => void }) {
  useLinkPreviewRequests({
    collectionId: props.collectionId, enabled: props.enabled, missingNodeIds: props.ids, onRefresh: props.onRefresh,
  })
  return null
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('useLinkPreviewRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetLinkPreviewRequestsForTests()
    mocks.requestLinkPreviews.mockReset().mockResolvedValue({ enqueued: 3 })
    mocks.live = true
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('batches missing ids by 100 after the debounce and starts refreshing 15 s later', async () => {
    const onRefresh = vi.fn()
    const ids = Array.from({ length: 250 }, (_, i) => `n${i}`)
    mountTree(<Probe collectionId="col" enabled ids={ids} onRefresh={onRefresh} />)
    expect(mocks.requestLinkPreviews).not.toHaveBeenCalled()
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    expect(mocks.requestLinkPreviews.mock.calls.map((call) => (call[1] as string[]).length)).toEqual([100, 100, 50])
    expect(mocks.requestLinkPreviews.mock.calls[0]![0]).toBe('col')
    await advance(LINK_PREVIEW_REFRESH_DELAY_MS - 1)
    expect(onRefresh).not.toHaveBeenCalled()
    await advance(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('never asks twice for the same id in a session, and stays quiet when disabled', async () => {
    const onRefresh = vi.fn()
    const view = mountTree(<Probe collectionId="col" enabled ids={['a', 'b']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    view.rerender(<Probe collectionId="col" enabled ids={['a', 'b', 'c']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    expect(mocks.requestLinkPreviews.mock.calls.map((call) => call[1])).toEqual([['a', 'b'], ['c']])
    cleanup()
    mocks.requestLinkPreviews.mockClear()
    mountTree(<Probe collectionId="other" enabled={false} ids={['x']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    expect(mocks.requestLinkPreviews).not.toHaveBeenCalled()
  })

  it('a 404 (feature off) stops requests for the rest of the session', async () => {
    mocks.requestLinkPreviews.mockRejectedValue({ status: 404 })
    const onRefresh = vi.fn()
    const view = mountTree(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    view.rerender(<Probe collectionId="col" enabled ids={['a', 'z']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS + LINK_PREVIEW_REFRESH_DELAY_MS)
    expect(mocks.requestLinkPreviews).toHaveBeenCalledTimes(1)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('unmounting cancels the pending refresh', async () => {
    const onRefresh = vi.fn()
    mountTree(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    cleanup()
    await advance(LINK_PREVIEW_REFRESH_DELAY_MS)
    expect(onRefresh).not.toHaveBeenCalled()
  })
  it('refreshes slow work with a bounded budget and restarts for later batches', async () => {
    const onRefresh = vi.fn()
    const view = mountTree(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    await advance(600_000)
    expect(onRefresh).toHaveBeenCalledTimes(LINK_PREVIEW_MAX_REFRESHES)
    view.rerender(<Probe collectionId="col" enabled ids={['b']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    await advance(LINK_PREVIEW_REFRESH_DELAY_MS)
    expect(onRefresh).toHaveBeenCalledTimes(LINK_PREVIEW_MAX_REFRESHES + 1)
    view.rerender(<Probe collectionId="col" enabled ids={[]} onRefresh={onRefresh} />)
    await advance(600_000)
    expect(onRefresh).toHaveBeenCalledTimes(LINK_PREVIEW_MAX_REFRESHES + 1)
  })

  it('does not refresh a different collection after switching views', async () => {
    const onRefresh = vi.fn()
    const view = mountTree(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    view.rerender(<Probe collectionId="other" enabled={false} ids={['b']} onRefresh={onRefresh} />)
    await advance(600_000)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('retries failed IDs when Gallery is reopened, without retrying successful IDs', async () => {
    mocks.requestLinkPreviews.mockRejectedValueOnce({ status: 503 })
    const onRefresh = vi.fn()
    const view = mountTree(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    view.rerender(<Probe collectionId="col" enabled={false} ids={['a']} onRefresh={onRefresh} />)
    view.rerender(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    expect(mocks.requestLinkPreviews).toHaveBeenCalledTimes(2)
    view.rerender(<Probe collectionId="col" enabled={false} ids={['a']} onRefresh={onRefresh} />)
    view.rerender(<Probe collectionId="col" enabled ids={['a']} onRefresh={onRefresh} />)
    await advance(LINK_PREVIEW_REQUEST_DEBOUNCE_MS)
    expect(mocks.requestLinkPreviews).toHaveBeenCalledTimes(2)
  })

})
