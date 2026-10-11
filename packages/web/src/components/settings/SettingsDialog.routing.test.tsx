// @vitest-environment happy-dom
import { act } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsRedirect } from '../../App'
import { cleanup, findButtonByName, mountTree, waitForDom } from '../../test/render'
import { SettingsDialog } from './SettingsDialog'

const mocks = vi.hoisted(() => ({
  auth: {
    user: {
      name: 'Phase 1 Real Stack', handle: 'original_handle', email: 'user@example.test',
      initials: 'P1', accountId: 'account-1', profileId: 'account-1',
    } as { name: string; handle: string; email: string; initials: string; accountId: string; profileId: string } | null,
    bootstrapping: false,
    sessionState: 'ready' as string,
    runAuthMutation: vi.fn(),
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  isLive: vi.fn((flag: string) => flag !== 'mfa'),
  authClient: {
    getAuthSession: vi.fn(),
    sendVerificationEmail: vi.fn(),
    requestEmailChange: vi.fn().mockResolvedValue({ status: true }),
    changeEmail: vi.fn(),
    changePassword: vi.fn(),
    linkOAuth: vi.fn(),
    unlinkOAuth: vi.fn(),
    listLinkedAccounts: vi.fn().mockResolvedValue({ accounts: [], hasPassword: true }),
    requestForgetPasswordOtp: vi.fn(),
    resetPasswordWithOtp: vi.fn(),
    sendOtp: vi.fn(),
    enableTwoFactor: vi.fn(),
    generateBackupCodes: vi.fn(),
    disableTwoFactor: vi.fn(),
    revokeSession: vi.fn(),
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    revokeSessionById: vi.fn(),
    deleteAccount: vi.fn(),
  },
}))

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }),
}))
vi.mock('../../api/authClient', () => ({ authClient: mocks.authClient }))
vi.mock('../../api', () => ({
  isProductApiError: (error: unknown) => !!error && typeof error === 'object' && 'fieldErrors' in error,
  isLive: mocks.isLive,
  productClient: {
    updateMe: vi.fn(),
    newCommandId: () => 'command-1',
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  },
}))

describe('Settings dialog routing', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.sessionState = 'ready'
    mocks.authClient.getAuthSession.mockReset().mockResolvedValue(null)
    mocks.authClient.listLinkedAccounts.mockReset().mockResolvedValue({ accounts: [], hasPassword: true })
    mocks.authClient.listSessions.mockReset().mockResolvedValue({ sessions: [] })
  })

  afterEach(() => cleanup())

  function renderAt(path: string) {
    const router = createMemoryRouter([
      { path: '/settings', element: <SettingsRedirect /> },
      { path: '/library', element: <SettingsDialog /> },
    ], { initialEntries: [path] })
    mountTree(<RouterProvider router={router} />)
    return router
  }

  it('clears the settings param on Escape', () => {
    const router = renderAt('/library?settings=profile')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(router.state.location.search).toBe('')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('clears the settings param on overlay click', () => {
    const router = renderAt('/library?settings=bookmarks')
    const overlay = document.querySelector('[role="dialog"]')
    expect(overlay).not.toBeNull()
    act(() => overlay!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(router.state.location.search).toBe('')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('clears the settings param on the close button', () => {
    const router = renderAt('/library?settings=security')
    act(() => findButtonByName('Close settings').click())
    expect(router.state.location.search).toBe('')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('opens profile when the settings param is illegal', () => {
    const router = renderAt('/library?settings=nope')
    expect(router.state.location.search).toBe('?settings=nope')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Profile')
    expect(document.querySelector('#set-handle')).not.toBeNull()
  })

  it('switches sections with replace and does not grow history', () => {
    const router = renderAt('/library?settings=profile')
    act(() => findButtonByName('Security').click())
    expect(router.state.historyAction).toBe('REPLACE')
    expect(router.state.location.pathname).toBe('/library')
    expect(router.state.location.search).toBe('?settings=security')
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Security')
  })

  it('maps /settings#security onto the library security panel', async () => {
    const router = renderAt('/settings#security')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(router.state.location.pathname).toBe('/library')
    expect(router.state.location.search).toBe('?settings=security')
    expect(document.querySelector('[data-testid="settings-security"]')).not.toBeNull()
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Security')
  })

  it('asks before closing with unsaved profile edits and stays until Discard', async () => {
    renderAt('/library?settings=profile')
    const name = document.querySelector<HTMLInputElement>('#set-name')!
    const proto = HTMLInputElement.prototype
    act(() => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(name, 'Half-typed name')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const dialog = () => document.querySelector('[role="dialog"][aria-label="Discard changes?"]')
    const nav = () => document.querySelector('[data-settings-nav]')

    act(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click()
    })
    await waitForDom(() => dialog() != null)
    expect(nav()).not.toBeNull()

    await act(async () => {
      [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Discard')!.click()
    })
    await waitForDom(() => nav() == null)
    expect(dialog()).toBeNull()
  })

  it('closes without asking when the profile is clean', async () => {
    renderAt('/library?settings=profile')
    act(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click()
    })
    expect(document.querySelector('[aria-label="Discard changes?"]')).toBeNull()
    await waitForDom(() => document.querySelector('[data-settings-nav]') == null)
  })
})
