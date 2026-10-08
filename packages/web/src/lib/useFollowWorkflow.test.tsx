// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { useFollowWorkflow } from './useFollowWorkflow'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  isFollowingProfile: vi.fn(), followProfile: vi.fn(), unfollowProfile: vi.fn(),
  abandonFollowIntent: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaA'
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbA'
let latest: ReturnType<typeof useFollowWorkflow> | undefined

function Probe() {
  latest = useFollowWorkflow({ actorProfileId: ACTOR, targetProfileId: TARGET, enabled: true })
  return <button type="button" onClick={() => void latest?.toggle()}>{latest.status}:{String(latest.following)}</button>
}

describe('useFollowWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks(); latest = undefined; document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function render() { mountTree(<Probe />) }

  it('restores authority, prevents duplicate pending actions, and refreshes after first success', async () => {
    /* Endpoint state: the relation is not followed until the mutation commits,
       so every mount-time authority read sees the same answer. */
    let following = false
    let release!: () => void
    mocks.isFollowingProfile.mockImplementation(() => Promise.resolve(following))
    mocks.followProfile.mockImplementation(() => new Promise((resolve) => {
      release = () => { following = true; resolve({ following: true }) }
    }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    const readsBeforeToggle = mocks.isFollowingProfile.mock.calls.length
    act(() => { void latest?.toggle(); void latest?.toggle() })
    // A second click while the first is pending must not issue a second mutation.
    expect(mocks.followProfile).toHaveBeenCalledTimes(1)
    expect(mocks.unfollowProfile).not.toHaveBeenCalled()
    expect(latest?.status).toBe('pending')
    await act(async () => release()); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    // A committed mutation re-reads server authority.
    expect(mocks.isFollowingProfile.mock.calls.length).toBeGreaterThan(readsBeforeToggle)
    expect(latest?.following).toBe(true)
  })

  it('keeps unknown outcome retry on the exact intent and resolves from server authority', async () => {
    let following = false
    mocks.isFollowingProfile.mockImplementation(() => Promise.resolve(following))
    mocks.followProfile
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }))
      .mockImplementation(() => { following = true; return Promise.resolve({ following: true }) })
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    await act(async () => { await latest?.toggle() }); expect(latest?.status).toBe('unknown')
    await act(async () => { await latest?.retryExact() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(mocks.followProfile.mock.calls[1]?.[1]?.intentId).toBe(mocks.followProfile.mock.calls[0]?.[1]?.intentId)
    expect(latest?.following).toBe(true)
  })

  it('surfaces same-ID conflict and only abandons it after authority refresh', async () => {
    let following = false
    mocks.isFollowingProfile.mockImplementation(() => Promise.resolve(following))
    mocks.followProfile.mockRejectedValueOnce(new ProductApiError({ status: 409, code: 'command_id_reused', message: 'conflict' }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending'); await act(async () => { await latest?.toggle() })
    expect(latest?.status).toBe('conflict')
    await act(async () => { await latest?.refresh() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(mocks.abandonFollowIntent).toHaveBeenCalledWith(expect.stringContaining(TARGET))
    expect(latest?.status).toBe('ready')
  })

  it('re-reads authority when another tab broadcasts a relation change', async () => {
    let following = false
    mocks.isFollowingProfile.mockImplementation(() => Promise.resolve(following))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    const readsBeforeBroadcast = mocks.isFollowingProfile.mock.calls.length
    following = true
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'known.follow.invalidate.v1', newValue: TARGET,
    })))
    await waitForDom(() => latest?.following === true)
    // The broadcast triggers exactly one fresh authority read, and its answer wins.
    expect(mocks.isFollowingProfile.mock.calls.length).toBe(readsBeforeBroadcast + 1)
    expect(latest?.following).toBe(true)
  })

  it('retries a failed authority read without accidentally issuing a mutation', async () => {
    /* The relation endpoint is unreachable until the reader retries. */
    let authorityReachable = false
    mocks.isFollowingProfile.mockImplementation(() => (
      authorityReachable
        ? Promise.resolve(false)
        : Promise.reject(new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }))
    ))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(latest?.status).toBe('error')
    expect(latest?.retryKind).toBe('authority')
    authorityReachable = true
    const readsBeforeRetry = mocks.isFollowingProfile.mock.calls.length
    await act(async () => { await latest?.retry() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(mocks.isFollowingProfile.mock.calls.length).toBe(readsBeforeRetry + 1)
    expect(mocks.followProfile).not.toHaveBeenCalled()
  })

  it('drops a deterministic user_action rejection to an authority re-read instead of intent retry', async () => {
    let following = false
    mocks.isFollowingProfile.mockImplementation(() => Promise.resolve(following))
    mocks.followProfile.mockRejectedValueOnce(new ProductApiError({
      status: 400, code: 'invalid_request',
      message: 'A Profile cannot follow itself.',
      recovery: 'user_action',
    }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    await act(async () => { await latest?.toggle() })
    expect(latest?.status).toBe('error')
    expect(latest?.retryKind).toBe('authority')
    expect(latest?.message).toMatch(/cannot follow itself/i)
    const readsBeforeRetry = mocks.isFollowingProfile.mock.calls.length
    await act(async () => { await latest?.retry() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    // The retry re-reads authority; a user_action rejection must not re-issue the mutation.
    expect(mocks.followProfile).toHaveBeenCalledTimes(1)
    expect(mocks.isFollowingProfile.mock.calls.length).toBe(readsBeforeRetry + 1)
    expect(latest?.status).toBe('ready')
  })

  it('recovers by direct authority refresh when the read after a committed success fails', async () => {
    let following = false
    let authorityFailing = false
    mocks.isFollowingProfile.mockImplementation(() => (
      authorityFailing
        ? Promise.reject(new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }))
        : Promise.resolve(following)
    ))
    mocks.followProfile.mockImplementationOnce(() => {
      following = true
      authorityFailing = true
      return Promise.resolve({ following: true })
    })
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')

    await act(async () => { await latest?.toggle() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(latest?.status).toBe('error')
    expect(latest?.retryKind).toBe('authority')
    authorityFailing = false
    const readsBeforeRetry = mocks.isFollowingProfile.mock.calls.length
    await act(async () => { await latest?.retry() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')

    expect(mocks.followProfile).toHaveBeenCalledTimes(1)
    expect(mocks.isFollowingProfile.mock.calls.length).toBe(readsBeforeRetry + 1)
    expect(latest?.following).toBe(true)
  })
})
