// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { CollectionFollowButton } from './CollectionFollowButton'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getCollectionFollowState: vi.fn(),
  followCollection: vi.fn(),
  unfollowCollection: vi.fn(),
  abandonCollectionFollowIntent: vi.fn(),
}))

const auth = vi.hoisted(() => ({
  user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' } as
    | { profileId: string; handle: string }
    | null,
  isLoggedIn: true,
  bootstrapping: false,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    isLoggedIn: auth.isLoggedIn,
    bootstrapping: auth.bootstrapping,
  }),
}))

const COLLECTION = 'cccccccccccccccccccccA'

describe('CollectionFollowButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.user = { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' }
    auth.isLoggedIn = true
    auth.bootstrapping = false
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getCollectionFollowState.mockResolvedValue({ following: false, followerCount: 2, followedAt: null })
    mocks.followCollection.mockResolvedValue({
      following: true, followerCount: 3, followedAt: '2026-08-26T01:00:00.000Z',
    })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  function render(props: {
    collectionId?: string | null
    ownerHandle?: string | null
    onState?: (state: { following: boolean; followerCount: number } | null) => void
  } = {}) {
    mountTree(
      <CollectionFollowButton
        collectionId={props.collectionId === undefined ? COLLECTION : props.collectionId}
        ownerHandle={props.ownerHandle}
        onState={props.onState}
      />,
    )
  }

  function label(): string | undefined {
    return document.querySelector('[data-testid="collection-follow-label"]')?.textContent ?? undefined
  }

  it('does not render or query when collection-follow exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: false }
    render()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="collection-follow"]')).toBeNull()
    expect(mocks.getCollectionFollowState).not.toHaveBeenCalled()
  })

  it('renders a sign-in CTA for anonymous visitors without querying follow state', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    auth.user = null
    auth.isLoggedIn = false
    mountTree(
      <MemoryRouter initialEntries={['/']}>
        <CollectionFollowButton collectionId={COLLECTION} />
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="collection-follow"]')).toBeNull()
    const cta = document.querySelector<HTMLAnchorElement>('[data-testid="collection-follow-signin"]')
    expect(cta).not.toBeNull()
    expect(cta?.textContent).toBe('Sign in to follow')
    expect(cta?.className).toMatch(/\bbtn\b/)
    expect(cta?.className).toMatch(/\bbtn-secondary\b/)
    // Same chrome height as the Follow button it stands in for.
    expect(cta?.className).not.toMatch(/\bbtn-sm\b/)
    expect(cta?.getAttribute('href')).toMatch(/^\/login\?returnTo=%2F/)
    expect(mocks.getCollectionFollowState).not.toHaveBeenCalled()
  })

  it('does not render a sign-in CTA when exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: false }
    auth.user = null
    auth.isLoggedIn = false
    mountTree(
      <MemoryRouter initialEntries={['/']}>
        <CollectionFollowButton collectionId={COLLECTION} />
      </MemoryRouter>,
    )
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="collection-follow-signin"]')).toBeNull()
    expect(mocks.getCollectionFollowState).not.toHaveBeenCalled()
  })

  it('reads authority for the collection owner without rendering a button', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    const onState = vi.fn()
    render({ ownerHandle: 'actor', onState })
    await waitForDom(() => onState.mock.calls.length > 0)
    // The owner's control still reads authority, once per collection.
    expect(mocks.getCollectionFollowState).toHaveBeenCalledWith(COLLECTION, expect.objectContaining({ maxRetries: 0 }))
    expect(new Set(mocks.getCollectionFollowState.mock.calls.map((call) => JSON.stringify(call[0]))).size).toBe(1)
    expect(document.querySelector('[data-testid="collection-follow"]')).toBeNull()
    expect(onState).toHaveBeenCalledWith({ following: false, followerCount: 2 })
  })

  it('still renders when owner handle cannot be compared', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    render({ ownerHandle: null })
    await waitForDom(() => label() === 'Follow')
    // One authority read for this collection — React's double mount repeats the
    // same request rather than asking a different question.
    expect(new Set(mocks.getCollectionFollowState.mock.calls.map((call) => JSON.stringify(call[0]))).size).toBe(1)
    expect(mocks.getCollectionFollowState).toHaveBeenCalledWith(COLLECTION, expect.objectContaining({ maxRetries: 0 }))
    expect(document.querySelector('[data-testid="collection-follow"]')).not.toBeNull()
  })

  it('measures Follow labels and toggles Follow to Unfollow from authority', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    /* The collection is not followed until the follow mutation commits. */
    let following = false
    mocks.getCollectionFollowState.mockImplementation(() => Promise.resolve({
      following, followerCount: following ? 3 : 2,
      followedAt: following ? '2026-08-26T01:00:00.000Z' : null,
    }))
    mocks.followCollection.mockImplementation(() => {
      following = true
      return Promise.resolve({ following: true, followerCount: 3, followedAt: '2026-08-26T01:00:00.000Z' })
    })
    render({ ownerHandle: 'curator' })
    await waitForDom(() => label() === 'Follow')

    const button = document.querySelector<HTMLButtonElement>('[data-testid="collection-follow"]')
    expect(button?.className).toMatch(/\bbtn\b/)
    expect(button?.className).toMatch(/\bbtn-primary\b/)
    expect(button?.className).not.toMatch(/follow-btn--unfollow/)
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelectorAll('[data-testid="collection-follow-measure"]')).toHaveLength(5)
    expect([...document.querySelectorAll('[data-testid="collection-follow-measure"]')].map((node) => node.textContent)).toEqual([
      'Follow', 'Unfollow', 'Checking…', 'Following…', 'Unfollowing…',
    ])

    await act(async () => { button?.click() })
    await waitForDom(() => label() === 'Unfollow')
    expect(document.querySelector('[data-testid="collection-follow"]')?.className).toMatch(/follow-btn--unfollow/)
    expect(document.querySelector('[data-testid="collection-follow"]')?.className).toMatch(/\bbtn-secondary\b/)
    expect(document.querySelector('[data-testid="collection-follow"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(mocks.followCollection).toHaveBeenCalledTimes(1)
  })

  it('hides after a 404 authority read and does not retry', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    mocks.getCollectionFollowState.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not exposed' }),
    )
    render({ ownerHandle: 'curator' })
    await waitForDom(() => document.querySelector('[data-testid="collection-follow"]') === null)
    // Concealment asks one question, not a retry loop: every attempt carries
    // the same collection and no further attempt appears.
    expect(new Set(mocks.getCollectionFollowState.mock.calls.map((call) => JSON.stringify(call[0]))).size).toBe(1)
    const attempts = mocks.getCollectionFollowState.mock.calls.length
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(mocks.getCollectionFollowState.mock.calls.length).toBe(attempts)
    expect(document.querySelector('[data-testid="collection-follow-label"]')).toBeNull()
  })

  it('shows Retry status after a non-404 authority failure', async () => {
    window.__KNOWN_FLAGS__ = { collectionFollow: true }
    /* The endpoint is offline on every read, not just the first. */
    mocks.getCollectionFollowState.mockRejectedValue(
      new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }),
    )
    render({ ownerHandle: 'curator' })
    await waitForDom(() => label() === 'Retry status')
    expect(document.querySelector('[data-testid="collection-follow"]')).not.toBeNull()
  })
})
