// @vitest-environment happy-dom

import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from './SettingsDialog'
import { cleanup, mountTree } from '../../test/render'

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
  updateMe: vi.fn(),
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
vi.mock('../AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: mocks.success, error: mocks.error }),
}))
vi.mock('../../api/authClient', () => ({ authClient: mocks.authClient }))
vi.mock('../../api', () => ({
  isProductApiError: (error: unknown) => !!error && typeof error === 'object' && 'fieldErrors' in error,
  isLive: mocks.isLive,
  productClient: {
    updateMe: mocks.updateMe,
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

describe('Settings profile persistence', () => {
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

  it.each(['credentials', 'grants'])('old %s deep links cannot open bot management', (section) => {
    mocks.isLive.mockReturnValue(true)
    mountTree(<MemoryRouter initialEntries={[`/library?settings=${section}`]}><SettingsDialog /></MemoryRouter>)
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Profile')
    expect([...document.querySelectorAll('[data-settings-nav] button')].map((button) => button.textContent))
      .not.toEqual(expect.arrayContaining(['Credentials', 'Grants']))
  })

  it('does not overwrite dirty fields when the same account refreshes asynchronously', () => {
    render()
    const handle = document.querySelector<HTMLInputElement>('#set-handle')!
    expect(handle.value).toBe('original_handle')
    change(handle, 'draft_handle')

    mocks.auth.user = { ...mocks.auth.user!, name: 'Refreshed Name', handle: 'original_handle' }
    render()
    expect(handle.value).toBe('draft_handle')
  })

  it('submits the real profile mutation and exposes a conflict as an alert', async () => {
    mocks.updateMe.mockRejectedValue({
      code: 'handle_taken', message: 'conflict', fieldErrors: [],
    })
    render()
    change(document.querySelector<HTMLInputElement>('#set-handle')!, 'taken_handle')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.updateMe).toHaveBeenCalledWith(
      { handle: 'taken_handle', displayName: 'Phase 1 Real Stack', about: '' },
      { intentId: 'update-me:command-1' },
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('That handle is already taken.')
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('disables the form controls and save button while the profile save is in flight and restores them after', async () => {
    let resolveSave!: (value: {
      account: { id: string; email: string }
      profile: { id: string; handle: string; displayName: string; avatarUrl: string | null }
    }) => void
    mocks.updateMe.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))
    render()
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    // Save in flight: the whole form is read-only and the button shows progress.
    const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Saving…')
    expect((document.querySelector<HTMLInputElement>('#set-name')!).disabled).toBe(true)
    expect((document.querySelector<HTMLInputElement>('#set-handle')!).disabled).toBe(true)

    await act(async () => {
      resolveSave({
        account: { id: 'account-1', email: 'user@example.test' },
        profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: null },
      })
    })

    // Save finished: the form and button are back to normal.
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')!.textContent).toBe('Save profile')
    expect((document.querySelector<HTMLInputElement>('#set-name')!).disabled).toBe(false)
    expect((document.querySelector<HTMLInputElement>('#set-handle')!).disabled).toBe(false)
    expect(mocks.success).toHaveBeenCalledWith('Profile saved')
  })

  it('renders a field validation failure once, inline under the handle input', async () => {
    const message = 'handle must be 1..64 characters of [A-Za-z0-9._~-]'
    mocks.updateMe.mockRejectedValue({
      code: 'invalid_handle', message, fieldErrors: [{ path: '/handle', code: 'invalid_handle', message }],
    })
    render()
    change(document.querySelector<HTMLInputElement>('#set-handle')!, 'bad handle!')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    // Sibling rather than adjacent: the standing handle hint sits between the
    // input and its validation message.
    expect(document.querySelector('#set-handle ~ .field-error')?.textContent).toBe(message)
    expect(document.querySelectorAll('[data-testid="field-error"]')).toHaveLength(1)
    expect([...document.querySelectorAll('[role="alert"]')].map((node) => node.id)).toEqual(['set-handle-error'])
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('describes the handle and bounds the input at the claim length', () => {
    render()
    const input = document.querySelector<HTMLInputElement>('#set-handle')!
    expect(input.maxLength).toBe(30)
    expect(input.getAttribute('aria-describedby')).toBe('set-handle-hint')
    expect(document.querySelector('#set-handle-hint')?.textContent).toContain('Change it whenever you like')
  })

  it('retries a stale CSRF token once when saving the profile', async () => {
    mocks.updateMe
      .mockRejectedValueOnce({
        code: 'csrf_failed',
        message: 'The request failed CSRF or Origin validation.',
        fieldErrors: [],
      })
      .mockResolvedValueOnce({
        account: { id: 'account-1', email: 'user@example.test' },
        profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: null, about: 'I collect bookmarks.' },
      })
    mocks.auth.runAuthMutation.mockImplementation(async (action: () => Promise<unknown>) => {
      try {
        return await action()
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'csrf_failed') {
          return await action()
        }
        throw err
      }
    })
    render()
    change(document.querySelector<HTMLInputElement>('#set-name')!, 'Renamed')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.updateMe).toHaveBeenCalledTimes(2)
    expect(mocks.success).toHaveBeenCalledWith('Profile saved')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('surfaces a retried CSRF failure without the raw origin-validation copy', async () => {
    mocks.updateMe.mockRejectedValue({
      code: 'csrf_failed',
      message: 'The request failed CSRF or Origin validation.',
      fieldErrors: [],
    })
    render()
    change(document.querySelector<HTMLInputElement>('#set-name')!, 'Renamed')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Session security token expired. Try again.',
    )
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
