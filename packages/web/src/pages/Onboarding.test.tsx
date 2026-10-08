// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExploreCollection, ExplorePage } from '../api'
import { Onboarding } from './Onboarding'
import onboardingSource from './Onboarding.tsx?raw'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const ACTOR_ID = 'aaaaaaaaaaaaaaaaaaaaaA'
const DESIGN_ID = 'col-design-aaaaaaaaaaA'
const MLOPS_ID = 'col-mlops-bbbbbbbbbbbA'
const CULTURE_ID = 'col-culture-cccccccccA'
const LOGIN_HREF = '/login?returnTo=%2Fonboarding'

const mocks = vi.hoisted(() => ({
  getExploreCollections: vi.fn(),
  followCollection: vi.fn(),
  auth: {
    user: null as { profileId: string; handle: string } | null,
    isLoggedIn: false,
    bootstrapping: false,
  },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
    productClient: {
      ...actual.productClient,
      followCollection: mocks.followCollection,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

function exploreItem(
  overrides: Partial<ExploreCollection> & Pick<ExploreCollection, 'id' | 'title'>,
): ExploreCollection {
  return {
    summary: 'Curated links',
    kind: 'topic',
    tags: ['design'],
    nodeCount: 12,
    updatedAt: '2026-08-20T00:00:00.000Z',
    publicationSlug: 'design-systems',
    visibility: 'public',
    creators: [{ id: 'creator-1', name: 'Noa Vandermeer', handle: 'noa', avatar: null }],
    viewCount: 128,
    ...overrides,
  }
}

function explorePage(items: ExploreCollection[]): ExplorePage {
  return { items, nextCursor: null }
}

const defaultItems = [
  exploreItem({ id: DESIGN_ID, title: 'Design systems field guide' }),
  exploreItem({ id: MLOPS_ID, title: 'ML ops in production' }),
  exploreItem({ id: CULTURE_ID, title: 'Product culture notes' }),
]

function signIn(profileId = ACTOR_ID) {
  mocks.auth.user = { profileId, handle: 'actor' }
  mocks.auth.isLoggedIn = true
  mocks.auth.bootstrapping = false
}

function clickNamed(label: string) {
  const match = [...document.querySelectorAll('button, a')].find((el) => el.textContent?.trim() === label)
  act(() => {
    if (match instanceof HTMLButtonElement || match instanceof HTMLAnchorElement) match.click()
  })
}

async function goToFollowStep() {
  clickNamed('Continue')
  await waitForDom(() => Boolean(document.body.textContent?.includes('Step 2 of 2')))
  await waitForDom(domFinishedLoading)
}

function pickByName(name: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((el) =>
    el.textContent?.includes(name),
  )
  act(() => match?.click())
}

async function finishAndSettle() {
  clickNamed('Finish')
  await waitForDom(domFinishedLoading)
  await waitForDom(domFinishedLoading)
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the wizard asks Explore for the popular list, follows exactly
 *    the picked collections by OpaqueId with the account-scoped intent, links
 *    the extension page instead of claiming installation, and always lets the
 *    reader leave the wizard. Driven through the real page with the client and
 *    the auth context mocked.
 *
 * 2. Architecture — the *absence* of the seeded curator roster, of a legacy
 *    `folderOptions` step, of a profile-follow call, and of the removed
 *    "I have installed it" affordance. An unused seed array or an unreachable
 *    step renders nothing, so no probe can falsify it — and a seeded roster
 *    that is only consulted when the API returns nothing would look like a
 *    feature, not a failure. The names reachable through the API path are
 *    proven absent behaviourally below.
 */
describe('Onboarding behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.getExploreCollections.mockReset()
    mocks.getExploreCollections.mockResolvedValue(explorePage(defaultItems))
    mocks.followCollection.mockReset()
    // R15-36: picks now persist until a signed-in finish; isolate each test.
    sessionStorage.clear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function renderOnboarding() {
    mountTree(
        <MemoryRouter initialEntries={['/onboarding']}>
          <Routes>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/library" element={<div>Library home</div>} />
            <Route path="/login" element={<div>Login page</div>} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('links to the extension page on step 1 and advances without claiming installation', async () => {
    renderOnboarding()
    expect(document.body.textContent).toContain('Step 1 of 2')
    expect(document.querySelector('a[href="/extension"]')?.textContent).toContain('Get the extension')
    expect(document.body.textContent).not.toContain('I have installed it')
    await goToFollowStep()
    expect(mocks.followCollection).not.toHaveBeenCalled()
  })

  it('lists popular collections from the Explore API on step 2', async () => {
    renderOnboarding()
    await goToFollowStep()
    expect(mocks.getExploreCollections).toHaveBeenCalledWith(
      { sort: 'popular', limit: 5 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(document.body.textContent).toContain('Design systems field guide')
    expect(document.body.textContent).toContain('ML ops in production')
    expect(document.body.textContent).toContain('Product culture notes')
    expect(document.body.textContent).toContain('Noa Vandermeer')
    expect(document.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0)
    /* The rendered roster is exactly what the API returned: a seeded curator
       list would show up here as a name the API never sent. */
    expect(document.body.textContent).not.toContain('Mira Okada')
    expect(document.body.textContent).not.toContain('Kai Nakamura')
    expect(document.body.textContent).not.toContain('林一晨')
  })

  it('follows selected collections by OpaqueId and navigates on success', async () => {
    signIn()
    mocks.followCollection.mockResolvedValue({ following: true, followerCount: 1, followedAt: null })
    renderOnboarding()
    await goToFollowStep()
    pickByName('Design systems field guide')
    pickByName('ML ops in production')
    await finishAndSettle()

    expect(mocks.followCollection).toHaveBeenCalledTimes(2)
    expect(mocks.followCollection).toHaveBeenCalledWith(
      DESIGN_ID,
      expect.objectContaining({
        intentId: `collection-follow:${ACTOR_ID}:${DESIGN_ID}:follow`,
        maxRetries: 0,
      }),
    )
    expect(mocks.followCollection).toHaveBeenCalledWith(
      MLOPS_ID,
      expect.objectContaining({
        intentId: `collection-follow:${ACTOR_ID}:${MLOPS_ID}:follow`,
        maxRetries: 0,
      }),
    )
    expect(mocks.followCollection).not.toHaveBeenCalledWith(CULTURE_ID, expect.anything())
    expect(document.body.textContent).toContain('Library home')
  })

  it('finishes to the library without follows when nothing is selected (R7-02)', async () => {
    signIn()
    renderOnboarding()
    await goToFollowStep()
    await finishAndSettle()

    expect(mocks.followCollection).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Library home')
  })

  it('stays on step 2 with a visible error when some follows fail', async () => {
    signIn()
    mocks.followCollection
      .mockResolvedValueOnce({ following: true, followerCount: 1, followedAt: null })
      .mockRejectedValueOnce(new Error('network'))
    renderOnboarding()
    await goToFollowStep()
    pickByName('Design systems field guide')
    pickByName('ML ops in production')
    await finishAndSettle()

    expect(document.body.textContent).toContain('Step 2 of 2')
    expect(document.body.textContent).not.toContain('Library home')
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/could not follow/i)
  })

  it('shows a login href and makes zero follow calls when logged out', async () => {
    renderOnboarding()
    await goToFollowStep()
    expect(document.querySelector(`a[href="${LOGIN_HREF}"]`)).toBeTruthy()
    pickByName('Design systems field guide')
    clickNamed('Sign in to finish')
    expect(mocks.followCollection).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('onboarding:follow-selection')).toBe(JSON.stringify([DESIGN_ID]))
  })

  it('restores the signed-out selection on step 2 and keeps it until a signed-in finish (R15-36)', async () => {
    sessionStorage.setItem('onboarding:follow-selection', JSON.stringify([DESIGN_ID]))
    renderOnboarding()
    // Restored picks resume on the step that shows them, without Continue.
    await waitForDom(() => Boolean(document.body.textContent?.includes('Step 2 of 2')))
    await waitForDom(domFinishedLoading)
    const pick = [...document.querySelectorAll('button[aria-pressed]')].find((el) =>
      el.textContent?.includes('Design systems field guide'),
    )
    expect(pick?.getAttribute('aria-pressed')).toBe('true')
    // A remount before sign-in must not lose the picks.
    expect(sessionStorage.getItem('onboarding:follow-selection')).toBe(JSON.stringify([DESIGN_ID]))
    // Resuming is not a step change: focus stays where it was.
    expect(document.activeElement?.tagName).not.toBe('H2')
  })

  it('clears the stashed picks once a signed-in finish succeeds (R15-36)', async () => {
    sessionStorage.setItem('onboarding:follow-selection', JSON.stringify([DESIGN_ID]))
    signIn()
    mocks.followCollection.mockResolvedValue({ following: true, followerCount: 1, followedAt: null })
    renderOnboarding()
    await waitForDom(() => Boolean(document.body.textContent?.includes('Step 2 of 2')))
    await waitForDom(domFinishedLoading)
    await finishAndSettle()
    expect(document.body.textContent).toContain('Library home')
    expect(sessionStorage.getItem('onboarding:follow-selection')).toBeNull()
  })

  it('moves focus to the new step heading on Continue (R15-36)', async () => {
    renderOnboarding()
    await goToFollowStep()
    expect(document.activeElement?.textContent).toBe('Follow popular collections')
  })

  it('offers retry when the catalog fails to load', async () => {
    signIn()
    /* Endpoint state, not a call queue: the catalog is unreachable while the
       wizard first loads and answers again once the reader retries. */
    let catalogOffline = true
    mocks.getExploreCollections.mockImplementation(() => (
      catalogOffline ? Promise.reject(new Error('network')) : Promise.resolve(explorePage(defaultItems))
    ))
    renderOnboarding()
    await goToFollowStep()

    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/couldn't load collections/i)
    catalogOffline = false
    const loadsBeforeRetry = mocks.getExploreCollections.mock.calls.length
    clickNamed('Try again')
    await waitForDom(domFinishedLoading)
    // One retry issues exactly one more catalog request.
    expect(mocks.getExploreCollections.mock.calls.length).toBe(loadsBeforeRetry + 1)
    expect(document.body.textContent).toContain('Design systems field guide')
  })

  it('lets a signed-in user finish even when the catalog cannot load', async () => {
    signIn()
    mocks.getExploreCollections.mockRejectedValue(new Error('network'))
    renderOnboarding()
    await goToFollowStep()

    // A broken catalog must not trap the user in the wizard.
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/couldn't load collections/i)
    await finishAndSettle()
    expect(mocks.followCollection).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Library home')
  })

  it('finishes without follows when the catalog is empty', async () => {
    signIn()
    mocks.getExploreCollections.mockResolvedValue(explorePage([]))
    renderOnboarding()
    await goToFollowStep()

    expect(document.body.textContent).toContain('No public collections to suggest yet')
    await finishAndSettle()
    expect(mocks.followCollection).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Library home')
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('ships no seeded curators, folders, or profile-follow calls in the source', () => {
    /* The reachable half is proven behaviourally above: the request really
       carries `sort: 'popular'`, the follow really uses the
       `collection-follow:` intent, the rendered roster carries no seeded name,
       and the extension step offers a link rather than an "installed"
       checkbox. What remains unreachable is dead seed data and a legacy step:
       `folderOptions` (the removed folder picker), `getPublicProfilePage` /
       `followProfile` (a second follow path this wizard must not take) and the
       "I have installed it" affordance only matter if their branch is taken,
       and taking it would render as normal UI rather than as a failure.
       Anchor: the module is non-empty and really is the wizard. */
    const source = onboardingSource
    expect(source.length).toBeGreaterThan(6_000)
    expect(source).not.toContain('Mira Okada')
    expect(source).not.toContain('Kai Nakamura')
    expect(source).not.toContain('林一晨')
    expect(source).not.toContain('folderOptions')
    expect(source).not.toContain('I have installed it')
    expect(source).not.toContain('getPublicProfilePage')
    expect(source).not.toContain('followProfile')
  })
})
