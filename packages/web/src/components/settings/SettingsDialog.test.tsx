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
    } as { name: string; handle: string; email: string; initials: string; accountId: string; profileId: string; avatarUrl?: string | null; about?: string; username?: string } | null,
    bootstrapping: false,
    sessionState: 'ready' as string,
    runAuthMutation: vi.fn(),
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  updateMe: vi.fn(),
  uploadAvatar: vi.fn(),
  faviconActivity: vi.fn(),
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
    getMyFaviconJobActivity: mocks.faviconActivity,
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
    mocks.uploadAvatar.mockReset()
    mocks.faviconActivity.mockReset().mockResolvedValue({ activeJobs: 0, job: null })
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

  it('shows favicon progress in other settings sections and keeps it when switching sections', async () => {
    mocks.faviconActivity.mockResolvedValue({ activeJobs: 1, job: {
      id: 'job-other-tab', operation: 'fill_missing', status: 'running', total: 10,
      succeeded: 3, failed: 1, skipped: 0, errors: [],
    } })
    render()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const strip = document.querySelector('[data-testid="favicon-job-progress"]')!
    expect(strip.textContent).toContain('4/10 processed')
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Profile')
    const bookmarks = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-nav] button')].find(button => button.textContent === 'Bookmarks')!
    await act(async () => { bookmarks.click() })
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Bookmarks')
    expect(document.querySelector('[data-testid="favicon-job-progress"]')).toBe(strip)
  })

  it.each(['credentials', 'grants'])('old %s deep links cannot open bot management', (section) => {
    mocks.isLive.mockReturnValue(true)
    mountTree(<MemoryRouter initialEntries={[`/library?settings=${section}`]}><SettingsDialog /></MemoryRouter>)
    expect(document.querySelector('[data-settings-nav] [aria-current="true"]')?.textContent).toBe('Profile')
    expect([...document.querySelectorAll('[data-settings-nav] button')].map((button) => button.textContent))
      .not.toEqual(expect.arrayContaining(['Credentials', 'Grants']))
  })

  function pickAvatar(file: File) {
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    return act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  const PNG_FILE = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
  const UPLOADED = {
    account: { id: 'account-1', email: 'user@example.test' },
    profile: { id: 'account-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: 'https://app.example.test/api/v1/avatar/a' },
  }

  it('uploads a picked image and shows the account avatar in the preview', async () => {
    mocks.uploadAvatar.mockResolvedValue(UPLOADED)
    render()
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')).toBeNull()
    expect(document.querySelector('[data-testid="settings-avatar-preview"]')?.textContent).toBe('P1')
    const file = PNG_FILE()
    await pickAvatar(file)
    expect(mocks.uploadAvatar).toHaveBeenCalledWith(file, { intentId: 'upload-avatar:command-1' })
    expect(mocks.success).toHaveBeenCalledWith('Avatar updated')

    // The session store hands the new profile to useAuth.
    mocks.auth.user = { ...mocks.auth.user!, avatarUrl: UPLOADED.profile.avatarUrl }
    render()
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')?.getAttribute('src'))
      .toBe(UPLOADED.profile.avatarUrl)
    expect(document.querySelector('[for="set-avatar-file"] strong')?.textContent).toBe('Change avatar')
  })

  it('blocks another pick and the profile save while an avatar uploads', async () => {
    let finish!: (value: typeof UPLOADED) => void
    mocks.uploadAvatar.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    render()
    await pickAvatar(PNG_FILE())
    expect(document.querySelector<HTMLInputElement>('#set-avatar-file')!.disabled).toBe(true)
    expect(document.querySelector('[data-testid="avatar-upload-status"]')?.textContent).toBe('Uploading…')
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(true)

    await act(async () => { finish(UPLOADED) })
    expect(document.querySelector<HTMLInputElement>('#set-avatar-file')!.disabled).toBe(false)
    expect(document.querySelector('[data-testid="avatar-upload-status"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('form button[type="submit"]')!.disabled).toBe(false)
  })

  it('refuses other image types and large files before uploading', async () => {
    render()
    await pickAvatar(new File(['gif'], 'avatar.gif', { type: 'image/gif' }))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Choose a PNG, JPEG or WebP image.')
    await pickAvatar(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Choose an image of 2 MB or less.')
    expect(mocks.uploadAvatar).not.toHaveBeenCalled()
  })

  it('says why this server cannot take avatars instead of suggesting a retry', async () => {
    mocks.uploadAvatar.mockRejectedValue({
      code: 'feature_temporarily_unavailable', message: 'Avatar upload needs the server to run on HTTPS.',
      fieldErrors: [], retryAfterSeconds: null, recoveryHint: 'Temporarily unavailable. Retry shortly.',
    })
    render()
    await pickAvatar(PNG_FILE())
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Avatar upload needs the server to run on HTTPS.')
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('does not overwrite dirty fields when the same account refreshes asynchronously', () => {
    render()
    const name = document.querySelector<HTMLInputElement>('#set-name')!
    expect(name.value).toBe('Phase 1 Real Stack')
    change(name, 'Draft name')

    mocks.auth.user = { ...mocks.auth.user!, name: 'Refreshed Name' }
    render()
    expect(name.value).toBe('Draft name')
  })

  it('submits the real profile mutation with the handle unchanged and exposes a conflict as an alert', async () => {
    mocks.updateMe.mockRejectedValue({
      code: 'mutation_conflict', message: 'conflict', fieldErrors: [], recoveryHint: 'Reload and try again.',
    })
    render()
    change(document.querySelector<HTMLInputElement>('#set-name')!, 'Renamed')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.updateMe).toHaveBeenCalledWith(
      { handle: 'original_handle', displayName: 'Renamed', about: '' },
      { intentId: 'update-me:command-1' },
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Reload and try again.')
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
    expect(mocks.success).toHaveBeenCalledWith('Profile saved')
  })

  it('renders a field validation failure once, inline under the display name', async () => {
    const message = 'displayName must be 1..80 characters'
    mocks.updateMe.mockRejectedValue({
      code: 'invalid_display_name', message, fieldErrors: [{ path: '/displayName', code: 'invalid_display_name', message }],
    })
    render()
    change(document.querySelector<HTMLInputElement>('#set-name')!, ' ')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('#set-name ~ .field-error')?.textContent).toBe(message)
    expect(document.querySelectorAll('[data-testid="field-error"]')).toHaveLength(1)
    expect([...document.querySelectorAll('[role="alert"]')].map((node) => node.id)).toEqual(['set-name-error'])
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('shows the sign-in username for reference and no generated handle', () => {
    mocks.auth.user = { ...mocks.auth.user!, username: 'ada' }
    render()
    expect(document.querySelector('#set-handle')).toBeNull()
    const input = document.querySelector<HTMLInputElement>('#set-username')!
    expect(input.value).toBe('ada')
    expect(input.readOnly).toBe(true)
    expect(input.getAttribute('aria-describedby')).toBe('set-username-hint')
    expect(document.querySelector('#set-username-hint')?.textContent).toContain('You sign in with it')
  })

  it('leaves the username out for an account without one', () => {
    render()
    expect(document.querySelector('#set-username')).toBeNull()
    expect(document.querySelector('#set-name')).not.toBeNull()
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
