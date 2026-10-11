// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasswordChangeSection } from './PasswordChangeSection'
import { SessionSection } from './SessionSection'
import { AccountDeleteSection } from './AccountDeleteSection'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    user: {
      name: 'Account A', handle: 'a', email: 'a@test', initials: 'AA',
      accountId: 'account-a', profileId: 'profile-a',
    } as {
      name: string; handle: string; email: string; initials: string
      accountId: string; profileId: string; avatarUrl?: string | null
    } | null,
    verificationRequired: false,
    runAuthMutation: vi.fn(),
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
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
vi.mock('../../api/authClient', () => ({ authClient: mocks.authClient }))

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function showPasswordFor(id: string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`)!
  expect(input.type).toBe('password')
  const toggle = input.parentElement!.querySelector<HTMLButtonElement>(
    'button[aria-label="Show password"]',
  )!
  act(() => toggle.click())
  expect(input.type).toBe('text')
}

describe('PasswordChangeSection', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.authClient.changePassword.mockReset()
    mocks.authClient.listLinkedAccounts.mockReset().mockResolvedValue({ accounts: [], hasPassword: true })
    mocks.authClient.requestForgetPasswordOtp.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.resetPasswordWithOtp.mockReset().mockResolvedValue({ status: true })
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<PasswordChangeSection />)
  }

  async function renderReady() {
    render()
    await waitForDom(domFinishedLoading)
  }

  it('toggles visibility on current and new password fields', async () => {
    await renderReady()
    showPasswordFor('pw-current')
    showPasswordFor('pw-new')
  })

  it('toggles visibility on the set-password field', async () => {
    mocks.authClient.listLinkedAccounts.mockResolvedValue({
      accounts: [{ providerId: 'google', accountId: 'g-sub-1' }],
      hasPassword: false,
    })
    render()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="set-password-send-otp"]')!.click()
    })
    showPasswordFor('set-pw-new')
  })

  it('changes the password with other-session revoke and confirms after the mutation', async () => {
    mocks.authClient.changePassword.mockResolvedValue({ status: true })
    await renderReady()
    change(document.querySelector<HTMLInputElement>('#pw-current')!, 'old-pass')
    change(document.querySelector<HTMLInputElement>('#pw-new')!, 'new-pass')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    // Password change revokes other sessions by default (D3 contract).
    expect(mocks.authClient.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old-pass',
      newPassword: 'new-pass',
      revokeOtherSessions: true,
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Password changed')
    expect(document.querySelector<HTMLInputElement>('#pw-current')!.value).toBe('')
    expect(document.querySelector<HTMLInputElement>('#pw-new')!.value).toBe('')
  })

  it('shows a re-auth pending label while the change is in flight', async () => {
    let resolveChange!: (value: { status: boolean }) => void
    mocks.authClient.changePassword.mockReturnValue(new Promise((resolve) => { resolveChange = resolve }))
    await renderReady()
    change(document.querySelector<HTMLInputElement>('#pw-current')!, 'old-pass')
    change(document.querySelector<HTMLInputElement>('#pw-new')!, 'new-pass')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Changing your password')
    await act(async () => { resolveChange({ status: true }) })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Password changed')
  })

  it('does not submit without both password fields', async () => {
    await renderReady()
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.changePassword).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Enter your current and new password')
  })

  it('shows Change password when a credential exists', async () => {
    await renderReady()
    expect(document.body.textContent).toContain('Change password')
    expect(document.querySelector('#pw-current')).not.toBeNull()
    expect(document.querySelector('[data-testid="set-password"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Set a password')
  })

  it('shows Set a password when there is no credential and never calls changePassword', async () => {
    mocks.authClient.listLinkedAccounts.mockResolvedValue({
      accounts: [{ providerId: 'google', accountId: 'g-sub-1' }],
      hasPassword: false,
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Set a password')
    expect(document.querySelector('#pw-current')).toBeNull()
    expect(document.querySelector('input[type="email"]')).toBeNull()

    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="set-password-send-otp"]')!.click()
    })
    expect(mocks.authClient.requestForgetPasswordOtp).toHaveBeenCalledWith({ email: 'a@test' })
    expect(mocks.authClient.changePassword).not.toHaveBeenCalled()

    change(document.querySelector<HTMLInputElement>('#set-pw-otp')!, '123456')
    change(document.querySelector<HTMLInputElement>('#set-pw-new')!, 'new-pass')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.resetPasswordWithOtp).toHaveBeenCalledWith({
      email: 'a@test',
      otp: '123456',
      password: 'new-pass',
    })
    expect(mocks.authClient.changePassword).not.toHaveBeenCalled()
    expect(document.querySelector('#pw-current')).not.toBeNull()
    expect(document.body.textContent).toContain('Change password')
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Password set')
  })
})

describe('SessionSection', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.auth.logout.mockReset().mockResolvedValue('signed-out')
    mocks.authClient.listSessions.mockReset().mockResolvedValue({ sessions: [] })
    mocks.authClient.revokeSessionById.mockReset().mockResolvedValue({ status: true })
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<SessionSection />)
  }

  it('signs out this device through product logout', async () => {
    render()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="revoke-session"]')!.click()
    })
    expect(mocks.auth.logout).toHaveBeenCalled()
    expect(document.querySelector('[role="status"]')?.textContent).toContain('This session was signed out')
  })

  it('shows the revoke pending state while logout is in flight', async () => {
    let resolveLogout!: (outcome: 'signed-out') => void
    mocks.auth.logout.mockReturnValue(new Promise((resolve) => { resolveLogout = resolve }))
    render()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="revoke-session"]')!.click()
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Signing out this session')
    await act(async () => { resolveLogout('signed-out') })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('This session was signed out')
  })

  it('does not claim the session ended when logout failed (R15-21)', async () => {
    mocks.auth.logout.mockResolvedValue('failed')
    render()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="revoke-session"]')!.click()
    })
    const status = document.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toContain("Couldn't sign out. You may still be signed in on this device.")
    expect(status).not.toContain('This session was signed out')
  })

  it('renders another device and revoke calls revokeSessionById with the id', async () => {
    mocks.authClient.listSessions.mockResolvedValue({
      sessions: [
        {
          id: 'ba-session-current',
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
          current: true,
        },
        {
          id: 'ba-session-other',
          createdAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T08:00:00.000Z',
          current: false,
        },
      ],
    })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="other-session"]')).not.toBeNull()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="revoke-other-session"]')!.click()
    })
    expect(mocks.authClient.revokeSessionById).toHaveBeenCalledWith({ sessionId: 'ba-session-other' })
    expect(mocks.authClient.revokeSession).not.toHaveBeenCalled()
    expect(mocks.auth.logout).not.toHaveBeenCalled()
  })
})

describe('AccountDeleteSection', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.auth.logout.mockReset().mockResolvedValue('signed-out')
    mocks.authClient.sendOtp.mockReset().mockResolvedValue({ success: true })
    mocks.authClient.deleteAccount.mockReset().mockResolvedValue({ status: true })
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<AccountDeleteSection />)
  }

  it('toggles visibility on the current-password field', () => {
    render()
    showPasswordFor('delete-account-password')
  })

  it('keeps submit disabled until DELETE is typed', () => {
    render()
    const submit = document.querySelector<HTMLButtonElement>('[data-testid="delete-account-submit"]')!
    expect(submit.disabled).toBe(true)
    change(document.querySelector<HTMLInputElement>('[data-testid="delete-account-confirm"]')!, 'delete')
    expect(submit.disabled).toBe(true)
    change(document.querySelector<HTMLInputElement>('[data-testid="delete-account-confirm"]')!, 'DELETE')
    expect(submit.disabled).toBe(false)
  })

  it('shows an error and does not delete when reauth is missing', async () => {
    render()
    change(document.querySelector<HTMLInputElement>('[data-testid="delete-account-confirm"]')!, 'DELETE')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="delete-account-form"]')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.deleteAccount).not.toHaveBeenCalled()
    expect(mocks.auth.logout).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Enter your password to confirm.')
  })

  it('calls deleteAccount then logout on success', async () => {
    render()
    change(document.querySelector<HTMLInputElement>('[data-testid="delete-account-confirm"]')!, 'DELETE')
    change(document.querySelector<HTMLInputElement>('[data-testid="delete-account-password"]')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="delete-account-form"]')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.deleteAccount).toHaveBeenCalledWith({
      confirmation: 'DELETE',
      reauth: { kind: 'password', password: 'pass' },
    })
    expect(mocks.auth.logout).toHaveBeenCalled()
  })
})
