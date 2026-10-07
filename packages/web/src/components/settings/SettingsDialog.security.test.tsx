// @vitest-environment happy-dom

import { act } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsRedirect } from '../../App'
import { SettingsDialog } from './SettingsDialog'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    user: {
      name: 'Phase 1 Real Stack', handle: 'original_handle', email: 'user@example.test',
      initials: 'P1', accountId: 'account-1', profileId: 'account-1',
    } as { name: string; handle: string; email: string; initials: string; accountId: string; profileId: string; avatarUrl?: string | null; about?: string } | null,
    bootstrapping: false,
    sessionState: 'ready' as string,
    runAuthMutation: vi.fn(),
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  notifications: {
    preference: {
      channel: 'in_app' as const,
      enabled: true,
      revision: '2',
      updatedAt: '2026-07-29T00:00:00.000Z',
      email: null,
    },
    pending: null as string | null,
    setPreference: vi.fn(),
    resetPreference: vi.fn(),
  },
  updateMe: vi.fn(),
  uploadAvatar: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  isLive: vi.fn((flag: string) => flag !== 'mfa'),
  authClient: {
    getAuthSession: vi.fn(),
    sendVerificationEmail: vi.fn(),
    requestEmailChange: vi.fn(),
    changeEmail: vi.fn(),
    changePassword: vi.fn(),
    linkOAuth: vi.fn(),
    unlinkOAuth: vi.fn(),
    listLinkedAccounts: vi.fn(),
    requestForgetPasswordOtp: vi.fn(),
    resetPasswordWithOtp: vi.fn(),
    sendOtp: vi.fn(),
    enableTwoFactor: vi.fn(),
    generateBackupCodes: vi.fn(),
    disableTwoFactor: vi.fn(),
    revokeSession: vi.fn(),
    listSessions: vi.fn(),
    revokeSessionById: vi.fn(),
    deleteAccount: vi.fn(),
  },
}))

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../../lib/useNotificationCenter', () => ({
  useNotificationCenter: () => mocks.notifications,
}))
vi.mock('../AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: mocks.success, error: mocks.error }),
}))
vi.mock('../../api/authClient', () => ({ authClient: mocks.authClient }))
vi.mock('../../api', () => ({
  isProductApiError: (error: unknown) => !!error && typeof error === 'object' && 'fieldErrors' in error,
  isNotificationExposureEnabled: () => true,
  isCommunityExposureEnabled: () => false,
  isLive: mocks.isLive,
  productClient: {
    updateMe: mocks.updateMe,
    uploadAvatar: mocks.uploadAvatar,
    newCommandId: () => 'command-1',
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  },
}))

function change(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Settings security and account surfaces', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = {
      name: 'Phase 1 Real Stack', handle: 'original_handle', email: 'user@example.test',
      initials: 'P1', accountId: 'account-1', profileId: 'account-1',
    }
    mocks.auth.bootstrapping = false
    mocks.auth.sessionState = 'ready'
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.auth.logout.mockReset().mockResolvedValue('signed-out')
    mocks.updateMe.mockReset()
    mocks.uploadAvatar.mockReset()
    mocks.success.mockReset()
    mocks.error.mockReset()
    mocks.authClient.getAuthSession.mockReset()
    mocks.authClient.sendVerificationEmail.mockReset()
    mocks.authClient.requestEmailChange.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.changeEmail.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.changePassword.mockReset()
    mocks.authClient.linkOAuth.mockReset()
    mocks.authClient.unlinkOAuth.mockReset()
    mocks.authClient.listLinkedAccounts.mockReset().mockResolvedValue({ accounts: [], hasPassword: true })
    mocks.authClient.requestForgetPasswordOtp.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.resetPasswordWithOtp.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.sendOtp.mockReset().mockResolvedValue({ success: true })
    mocks.authClient.enableTwoFactor.mockReset()
    mocks.authClient.generateBackupCodes.mockReset()
    mocks.authClient.disableTwoFactor.mockReset()
    mocks.authClient.revokeSession.mockReset()
    mocks.authClient.listSessions.mockReset().mockResolvedValue({ sessions: [] })
    mocks.authClient.revokeSessionById.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.deleteAccount.mockReset().mockResolvedValue({ status: true })
    mocks.isLive.mockReset().mockImplementation((flag: string) => flag !== 'mfa')
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<MemoryRouter initialEntries={['/library?settings=profile']}><SettingsDialog /></MemoryRouter>)
  }

  function renderAt(path: string) {
    mountTree(<MemoryRouter initialEntries={[path]}><SettingsDialog /></MemoryRouter>)
  }

  it('renders the security section with verified-email status and accessible auth feedback', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue({
      session: {
        id: 'session-1', userId: 'u-1',
        expiresAt: '2026-07-26T00:00:00Z', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
      user: { id: 'u-1', email: 'user@example.test', emailVerified: true, name: 'Phase 1 Real Stack', image: null },
    })
    renderAt('/library?settings=security')
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })

    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Security')
    expect(document.querySelector('[data-testid="settings-security"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="email-verified"]')?.textContent).toContain('verified')
    expect(document.querySelector('[data-testid="change-email"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="change-email-current"]')?.textContent).toBe('user@example.test')
    expect(document.querySelector('[data-testid="change-email-send"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="delete-account"]')).not.toBeNull()
    // Ready state: the auth status region renders no loading/offline/expired feedback.
    expect(document.body.textContent).not.toContain('Loading your session')
    expect(document.body.textContent).not.toContain("You're offline")
    expect(document.querySelector('a[href="/auth/recovery?auth=restart"]')).toBeNull()
  })

  it('hides the two-factor controls while the backend MFA surface is unmounted', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(null)
    renderAt('/library?settings=security')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="mfa-enable"]')).toBeNull()
    expect(document.querySelector('#mfa-password')).toBeNull()
    expect(document.querySelector('[data-testid="settings-security"]')?.textContent)
      .not.toContain('two-factor authentication')
  })

  it('keeps every security action inside an action row so no button spans the card', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(null)
    mocks.isLive.mockImplementation(() => true)
    mocks.authClient.listSessions.mockResolvedValue({
      sessions: [
        { id: 's-1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-02T00:00:00Z', current: true },
        { id: 's-2', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-03T00:00:00Z', current: false },
      ],
    })
    renderAt('/library?settings=security')
    await waitForDom(domFinishedLoading)

    const security = document.querySelector('[data-testid="settings-security"]')!
    // Each concern is its own card, so a section's fields, actions and
    // feedback read as one unit.
    expect(security.querySelectorAll('[data-testid="security-sections"] > section')).toHaveLength(7)
    expect(security.querySelector('hr.divider + .security-sections')).not.toBeNull()

    // A `.btn` is inline-flex: dropped straight into a column-flex parent it
    // stretches to the full card width. Every action must sit in a row.
    const buttons = [...security.querySelectorAll<HTMLElement>('button')]
      .filter((button) => button.classList.contains('btn'))
    expect(buttons.length).toBeGreaterThan(6)
    const stray = buttons.filter((button) => {
      const parent = button.parentElement
      return !parent?.classList.contains('auth-action-row')
        && !parent?.classList.contains('toggle-row')
        && !parent?.classList.contains('auth-otp-row')
    })
    expect(stray.map((b) => b.textContent)).toEqual([])
  })

  it('shows the two-factor controls once the MFA exposure flag is on', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(null)
    mocks.isLive.mockImplementation(() => true)
    renderAt('/library?settings=security')
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="mfa-enable"]')).not.toBeNull()
    expect(document.querySelector('#mfa-password')).not.toBeNull()
  })

  it('announces an expired session inside Settings with an auth-restart action', () => {
    mocks.auth.sessionState = 'expired'
    render()
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Your session has expired')
    expect(document.querySelector('a[href="/auth/recovery?auth=restart"]')?.textContent).toContain('Restart your session')
  })

  it('shows Change password on Security when the account has a credential', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue({
      session: {
        id: 'session-1', userId: 'u-1',
        expiresAt: '2026-07-26T00:00:00Z', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
      user: { id: 'u-1', email: 'user@example.test', emailVerified: true, name: 'Phase 1 Real Stack', image: null },
    })
    mocks.authClient.listLinkedAccounts.mockResolvedValue({ accounts: [], hasPassword: true })
    renderAt('/library?settings=security')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="settings-security"]')?.textContent).toContain('Change password')
    expect(document.querySelector('#pw-current')).not.toBeNull()
    expect(document.querySelector('[data-testid="set-password"]')).toBeNull()
  })

  it('shows Set a password on Security when there is no credential and never sends currentPassword', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue({
      session: {
        id: 'session-1', userId: 'u-1',
        expiresAt: '2026-07-26T00:00:00Z', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
      },
      user: { id: 'u-1', email: 'user@example.test', emailVerified: true, name: 'Phase 1 Real Stack', image: null },
    })
    mocks.authClient.listLinkedAccounts.mockResolvedValue({
      accounts: [{ providerId: 'google', accountId: 'g-sub-1' }],
      hasPassword: false,
    })
    renderAt('/library?settings=security')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="settings-security"]')?.textContent).toContain('Set a password')
    expect(document.querySelector('#pw-current')).toBeNull()
    expect(document.querySelector('[data-testid="set-password-form"] input[type="email"]')).toBeNull()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="set-password-send-otp"]')!.click()
    })
    expect(mocks.authClient.requestForgetPasswordOtp).toHaveBeenCalledWith({ email: 'user@example.test' })
    expect(mocks.authClient.changePassword).not.toHaveBeenCalled()

    change(document.querySelector<HTMLInputElement>('#set-pw-otp')!, '123456')
    change(document.querySelector<HTMLInputElement>('#set-pw-new')!, 'new-pass')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="set-password-form"]')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.resetPasswordWithOtp).toHaveBeenCalledWith({
      email: 'user@example.test',
      otp: '123456',
      password: 'new-pass',
    })
    expect(mocks.authClient.changePassword).not.toHaveBeenCalled()
  })

  it('describes privacy limits instead of offering fake save controls', () => {
    renderAt('/library?settings=privacy')
    expect(document.body.textContent).toContain('New collections start private')
    // R15-10: the profile shows Activity, Following and Followers tabs, not
    // collections only; the old sentence understated what is public.
    expect(document.body.textContent).toContain('recent changes to them (Activity), who you follow and who follows you')
    expect(document.body.textContent).not.toContain('lists collections only')
    const facts = [...document.querySelectorAll('dd')].find((dd) => dd.textContent?.includes('who follows you'))
    expect(facts?.querySelector('a[href="/privacy"]')).not.toBeNull()
    expect(document.querySelectorAll('[role="switch"]').length).toBe(0)
    expect(document.body.textContent).not.toContain('Save privacy')
  })

  it('sends notification preferences to the live notification center', () => {
    renderAt('/library?settings=notifications')
    const link = document.querySelector<HTMLAnchorElement>('a[href="/notifications"]')
    expect(link?.textContent).toContain('Open notification center')
    expect(document.body.textContent).not.toContain('Save notifications')
    expect(document.body.textContent).not.toContain('Product tips')
    const inAppSection = document.querySelector('[data-testid="in-app-preference"]')!
    const toggle = inAppSection.querySelector<HTMLButtonElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    act(() => toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    act(() => toggle.click())
    expect(mocks.notifications.setPreference).toHaveBeenCalledWith(false)
    const reset = [...inAppSection.querySelectorAll<HTMLButtonElement>('button')]
      .find((value) => value.textContent?.trim() === 'Use default')!
    reset.focus()
    expect(document.activeElement).toBe(reset)
    act(() => reset.click())
    expect(mocks.notifications.resetPreference).toHaveBeenCalled()
  })

  it('presents Export library as an account setting', () => {
    render()
    const link = document.querySelector<HTMLAnchorElement>('a[href="/export"]')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe('/export')
    expect(link?.textContent).toContain('Export library')
    // Page links sit in a separate "Go to" group, each with an outward arrow.
    const group = link?.closest('[role="group"]')
    expect(document.getElementById(group?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Go to')
    expect(link?.querySelector('svg')).not.toBeNull()
    expect([...(group?.querySelectorAll('a') ?? [])].map((anchor) => anchor.getAttribute('href')))
      .toEqual(['/creator', '/credits', '/extension', '/export'])
  })

  it('keeps in-flight /settings#security mail links on the Security panel', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(null)
    const router = createMemoryRouter([
      { path: '/settings', element: <SettingsRedirect /> },
      { path: '/library', element: <SettingsDialog /> },
    ], { initialEntries: ['/settings#security'] })
    mountTree(<RouterProvider router={router} />)
    await waitForDom(() => document.querySelector('[data-testid="settings-security"]') !== null)
    expect(router.state.location.pathname).toBe('/library')
    expect(router.state.location.search).toBe('?settings=security')
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Security')
  })
})
