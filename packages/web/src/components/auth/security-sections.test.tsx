// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { EmailChangeSection } from './EmailChangeSection'
import { EmailVerificationSection } from './EmailVerificationSection'
import { PasswordChangeSection } from './PasswordChangeSection'
import { ProviderLinkSection } from './ProviderLinkSection'
import { MfaSection } from './MfaSection'
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

function authSession(emailVerified: boolean) {
  return {
    session: {
      id: 'session-1', userId: 'u-1',
      expiresAt: '2026-07-26T00:00:00Z', createdAt: '2026-07-22T00:00:00Z', updatedAt: '2026-07-22T00:00:00Z',
    },
    user: { id: 'u-1', email: 'a@test', emailVerified, name: 'Account A', image: null },
  }
}

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

describe('EmailVerificationSection', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.auth.verificationRequired = false
    mocks.auth.user = {
      name: 'Account A', handle: 'a', email: 'a@test', initials: 'AA',
      accountId: 'account-a', profileId: 'profile-a',
    }
    mocks.authClient.getAuthSession.mockReset()
    mocks.authClient.sendVerificationEmail.mockReset()
  })

  afterEach(() => {
    mocks.auth.user = {
      name: 'Account A', handle: 'a', email: 'a@test', initials: 'AA',
      accountId: 'account-a', profileId: 'profile-a',
    }
    mocks.auth.verificationRequired = false
    cleanup()
  })

  function render() {
    mountTree(<EmailVerificationSection />)
  }

  it('shows the verified state read from the compat auth session', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(authSession(true))
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.authClient.getAuthSession).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="email-verified"]')?.textContent).toContain('verified')
    expect(document.querySelector('[data-testid="verify-email"]')).toBeNull()
  })

  it('sends a verification email through the typed auth client with the settings callback', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(authSession(false))
    mocks.authClient.sendVerificationEmail.mockResolvedValue({ status: true })
    render()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="verify-email"]')!.click()
    })
    expect(mocks.authClient.sendVerificationEmail).toHaveBeenCalledWith({
      email: 'a@test',
      callbackURL: '/library?settings=security',
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('A verification email was sent')
  })

  it('surfaces email delivery unavailability as accessible feedback', async () => {
    mocks.authClient.getAuthSession.mockResolvedValue(authSession(false))
    mocks.authClient.sendVerificationEmail.mockRejectedValue(
      new ProductApiError({ status: 503, code: 'email_delivery_unavailable', message: 'delivery down' }),
    )
    render()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="verify-email"]')!.click()
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Email delivery is temporarily unavailable')
  })

  it('renders occupancy verification without a product user', async () => {
    mocks.auth.user = null
    mocks.auth.verificationRequired = true
    mocks.authClient.getAuthSession.mockResolvedValue(authSession(false))
    mocks.authClient.sendVerificationEmail.mockResolvedValue({ status: true })
    render()
    await waitForDom(domFinishedLoading)
    expect(mocks.authClient.getAuthSession).toHaveBeenCalled()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="verify-email"]')!.click()
    })
    expect(mocks.authClient.sendVerificationEmail).toHaveBeenCalledWith({
      email: 'a@test',
      callbackURL: '/library?settings=security',
    })
  })
})

describe('EmailChangeSection', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.authClient.getAuthSession.mockReset().mockResolvedValue(authSession(true))
    mocks.authClient.requestEmailChange.mockReset().mockResolvedValue({ status: true })
    mocks.authClient.changeEmail.mockReset().mockResolvedValue({ status: true })
  })

  afterEach(() => {
    if (mocks.auth.user) mocks.auth.user.email = 'a@test'
    cleanup()
  })

  function render() {
    mountTree(<EmailChangeSection />)
  }

  it('renders change-email controls and shows the BA mailbox even when /me email is empty', async () => {
    if (mocks.auth.user) mocks.auth.user.email = ''
    render()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="change-email"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="change-email-current"]')?.textContent).toBe('a@test')
    expect(document.querySelector('[data-testid="change-email-new"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="change-email-send"]')).not.toBeNull()
  })

  it('sends the OTP to the new email, not the session email', async () => {
    render()
    change(document.querySelector<HTMLInputElement>('[data-testid="change-email-new"]')!, 'new@example.test')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="change-email-send"]')!.click()
    })
    expect(mocks.authClient.requestEmailChange).toHaveBeenCalledWith({ newEmail: 'new@example.test' })
    expect(mocks.authClient.requestEmailChange).not.toHaveBeenCalledWith({ newEmail: 'a@test' })
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      'If that address can receive mail, we sent a confirmation code',
    )
  })

  it('confirms with the new email and OTP', async () => {
    render()
    change(document.querySelector<HTMLInputElement>('[data-testid="change-email-new"]')!, 'new@example.test')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="change-email-send"]')!.click()
    })
    change(document.querySelector<HTMLInputElement>('[data-testid="change-email-otp"]')!, '654321')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="change-email-form"]')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.changeEmail).toHaveBeenCalledWith({
      newEmail: 'new@example.test',
      otp: '654321',
    })
    expect(document.querySelector('[data-testid="change-email-done"]')?.textContent).toContain('Email updated')
    expect(document.querySelector('[data-testid="change-email-current"]')?.textContent).toBe('new@example.test')
  })

  it('surfaces an occupied or invalid confirm as an accessible alert', async () => {
    mocks.authClient.changeEmail.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'The request is invalid.',
      }),
    )
    render()
    change(document.querySelector<HTMLInputElement>('[data-testid="change-email-new"]')!, 'taken@example.test')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="change-email-send"]')!.click()
    })
    change(document.querySelector<HTMLInputElement>('[data-testid="change-email-otp"]')!, '000000')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="change-email-form"]')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(mocks.authClient.changeEmail).toHaveBeenCalledWith({
      newEmail: 'taken@example.test',
      otp: '000000',
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The request is invalid.')
  })
})

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

describe('ProviderLinkSection', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.authClient.linkOAuth.mockReset()
    mocks.authClient.unlinkOAuth.mockReset()
    mocks.authClient.listLinkedAccounts.mockReset().mockResolvedValue({ accounts: [] })
    mocks.authClient.sendOtp.mockReset().mockResolvedValue({ success: true })
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<ProviderLinkSection />)
  }

  it('toggles visibility on the reauth password field', async () => {
    render()
    await waitForDom(domFinishedLoading)
    showPasswordFor('link-reauth-password')
  })

  it('requires re-auth before starting a provider link', async () => {
    render()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="link-google"]')!.click()
    })
    expect(mocks.authClient.linkOAuth).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Confirm it is you')
  })

  it('shows the re-auth pending state while a provider link is in flight', async () => {
    let resolveLink!: (value: { url: string; redirect: boolean }) => void
    mocks.authClient.linkOAuth.mockReturnValue(new Promise((resolve) => { resolveLink = resolve }))
    render()
    await waitForDom(domFinishedLoading)
    change(document.querySelector<HTMLInputElement>('#link-reauth-password')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="link-google"]')!.click()
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Waiting for re-authentication')
    await act(async () => { resolveLink({ url: '/__auth__/google', redirect: false }) })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Google is connected')
    expect(mocks.authClient.linkOAuth).toHaveBeenCalledWith({
      providerId: 'google',
      callbackURL: '/library?settings=security',
      errorCallbackURL: `/auth/recovery?returnTo=${encodeURIComponent('/library?settings=security')}`,
      reauth: { kind: 'password', password: 'pass' },
    })
  })

  it('hydrates Connected from the server list and disconnects with accountId', async () => {
    mocks.authClient.listLinkedAccounts.mockResolvedValue({
      accounts: [{ providerId: 'google', accountId: 'g-sub-1' }],
    })
    mocks.authClient.unlinkOAuth.mockResolvedValue({ status: true })
    render()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Connected')
    change(document.querySelector<HTMLInputElement>('#link-reauth-password')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="unlink-google"]')!.click()
    })
    expect(mocks.authClient.unlinkOAuth).toHaveBeenCalledWith({
      providerId: 'google',
      accountId: 'g-sub-1',
      reauth: { kind: 'password', password: 'pass' },
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Google is disconnected')
  })

  it('surfaces the last-recovery-method product message when disconnecting the last sign-in method', async () => {
    mocks.authClient.listLinkedAccounts.mockResolvedValue({
      accounts: [{ providerId: 'google', accountId: 'g-sub-1' }],
    })
    mocks.authClient.unlinkOAuth.mockRejectedValue(
      new ProductApiError({
        status: 400,
        code: 'invalid_request',
        message: 'Keep at least one sign-in method.',
      }),
    )
    render()
    await waitForDom(domFinishedLoading)
    change(document.querySelector<HTMLInputElement>('#link-reauth-password')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="unlink-google"]')!.click()
    })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Keep at least one sign-in method.')
  })
})

describe('MfaSection', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.runAuthMutation.mockReset().mockImplementation((action: () => Promise<unknown>) => action())
    mocks.authClient.enableTwoFactor.mockReset()
    mocks.authClient.generateBackupCodes.mockReset()
    mocks.authClient.disableTwoFactor.mockReset()
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<MfaSection />)
  }

  it('toggles visibility on the confirm-password field', () => {
    render()
    showPasswordFor('mfa-password')
  })

  it('enables two-factor with the re-auth password and shows the one-time recovery codes', async () => {
    mocks.authClient.enableTwoFactor.mockResolvedValue({
      totpURI: 'otpauth://totp/Know-N:a@test?secret=ABC',
      backupCodes: ['code-1', 'code-2'],
    })
    render()
    change(document.querySelector<HTMLInputElement>('#mfa-password')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="mfa-enable"]')!.click()
    })
    expect(mocks.authClient.enableTwoFactor).toHaveBeenCalledWith({ password: 'pass', issuer: 'Know-N' })
    expect(document.querySelector('[data-testid="mfa-totp-uri"] code')?.textContent).toContain('otpauth://')
    expect(document.querySelector('[data-testid="mfa-recovery-codes"] [role="alert"]')?.textContent).toContain('shown only once')
    expect(document.querySelectorAll('[data-testid="mfa-recovery-codes"] li')).toHaveLength(2)
  })

  it('shows the MFA pending label while enrollment is in flight', async () => {
    let resolveEnable!: (value: { totpURI: string; backupCodes: string[] }) => void
    mocks.authClient.enableTwoFactor.mockReturnValue(new Promise((resolve) => { resolveEnable = resolve }))
    render()
    change(document.querySelector<HTMLInputElement>('#mfa-password')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="mfa-enable"]')!.click()
    })
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Enabling two-factor authentication')
    await act(async () => { resolveEnable({ totpURI: 'otpauth://x', backupCodes: ['c1'] }) })
  })

  it('regenerates recovery codes only after password proof and shows them once', async () => {
    mocks.authClient.generateBackupCodes.mockResolvedValue({ backupCodes: ['r-1', 'r-2'] })
    render()
    change(document.querySelector<HTMLInputElement>('#mfa-password')!, 'pass')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="mfa-codes"]')!.click()
    })
    expect(mocks.authClient.generateBackupCodes).toHaveBeenCalledWith({ password: 'pass' })
    expect(document.querySelector('[data-testid="mfa-recovery-codes"]')?.textContent).toContain('r-1')
  })

  it('requires the re-auth password before any MFA action', async () => {
    render()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="mfa-enable"]')!.click()
    })
    expect(mocks.authClient.enableTwoFactor).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Enter your password')
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
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Confirm it is you')
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
