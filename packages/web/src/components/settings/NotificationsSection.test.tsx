// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommunityEntityResult,
  CommunityNotificationInbox,
  CommunityNotificationPreference,
} from '@known/product-v1-client'
import type { useNotificationCenter } from '../../lib/useNotificationCenter'
import { clearRouteCache } from '../../lib/routeCache'
import { NotificationsSection } from './NotificationsSection'
import { cleanup, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  getCommunityNotificationsPage: vi.fn(),
  getCommunityNotificationPreference: vi.fn(),
  updateCommunityNotificationPreference: vi.fn(),
  communityEnabled: true,
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    isCommunityExposureEnabled: () => mocks.communityEnabled,
    productClient: {
      ...actual.productClient,
      getCommunityNotificationsPage: (...args: unknown[]) => mocks.getCommunityNotificationsPage(...args),
      getCommunityNotificationPreference: (...args: unknown[]) => mocks.getCommunityNotificationPreference(...args),
      updateCommunityNotificationPreference: (...args: unknown[]) => mocks.updateCommunityNotificationPreference(...args),
    },
  }
})

const preferenceData: CommunityNotificationPreference = {
  enabled: true,
  revision: '2',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

function preferenceResult(
  data: CommunityNotificationPreference = preferenceData,
  etag: string | null = 'pref-etag-2',
): CommunityEntityResult<CommunityNotificationPreference> {
  return { data, etag }
}

function inbox(): CommunityNotificationInbox {
  return { items: [], nextCursor: null, unreadCount: 0 }
}

const inApp = {
  preference: {
    channel: 'in_app' as const,
    enabled: true,
    revision: '1',
    updatedAt: '2026-07-29T00:00:00.000Z',
    email: null,
  },
  pending: null,
  setPreference: vi.fn(),
  resetPreference: vi.fn(),
} as unknown as ReturnType<typeof useNotificationCenter>

describe('NotificationsSection community preference', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.communityEnabled = true
    mocks.getCommunityNotificationsPage.mockResolvedValue(inbox())
    mocks.getCommunityNotificationPreference.mockResolvedValue(preferenceResult())
    mocks.updateCommunityNotificationPreference.mockResolvedValue(
      preferenceResult({ ...preferenceData, enabled: false, revision: '3' }, 'pref-etag-3'),
    )
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  function render() {
    mountTree(
      <MemoryRouter>
        <NotificationsSection notifications={inApp} />
      </MemoryRouter>,
    )
  }

  it('toggles the community preference through a fresh-read If-Match CAS', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-preference"]') !== null)

    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="community-preference"] [role="switch"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-label')).toBe('Community reply notifications')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.getCommunityNotificationsPage).toHaveBeenCalledWith(
      { read: 'all', limit: 1 },
      expect.objectContaining({ maxRetries: 0 }),
    )

    /* The write chains a fresh preference read (the If-Match source); once the
       PUT commits, every authority read serves the disabled preference so the
       post-write refresh cannot silently restore the old state. */
    mocks.getCommunityNotificationPreference.mockResolvedValue(
      preferenceResult({ ...preferenceData, enabled: false, revision: '3' }, 'pref-etag-3'))
    const baselineReads = mocks.getCommunityNotificationPreference.mock.calls.length
    await act(async () => { toggle?.click() })
    await waitForDom(() => mocks.updateCommunityNotificationPreference.mock.calls.length === 1)

    expect(mocks.getCommunityNotificationPreference.mock.calls.length).toBeGreaterThan(baselineReads)
    const [body, ifMatch, options] = mocks.updateCommunityNotificationPreference.mock.calls[0]!
    expect(body).toEqual({ enabled: false })
    expect(ifMatch).toBe('pref-etag-3')
    expect(options).toEqual(expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }))

    await waitForDom(() => document.querySelector('[data-testid="community-preference"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
  })

  it('refuses the preference write when the fresh read carries no ETag', async () => {
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-preference"]') !== null)
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="community-preference"] [role="switch"]')
    expect(toggle).not.toBeNull()

    mocks.getCommunityNotificationPreference.mockResolvedValue(preferenceResult(preferenceData, null))
    await act(async () => { toggle?.click() })
    await waitForDom(() => document.body.textContent?.includes("Couldn't save your change. Try again.") === true)

    expect(mocks.updateCommunityNotificationPreference).not.toHaveBeenCalled()
    expect(mocks.getCommunityNotificationsPage.mock.calls.length).toBeGreaterThan(1)
  })

  it('hides the community switch while the community surface is unexposed', async () => {
    mocks.communityEnabled = false
    render()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="community-preference"]')).toBeNull()
    expect(mocks.getCommunityNotificationPreference).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="in-app-preference"]')).not.toBeNull()
  })
})
