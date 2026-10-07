// @vitest-environment happy-dom

import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsDialog } from './SettingsDialog'
import { cleanup, mountTree, waitForDom } from '../../test/render'

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
  communityEnabled: false,
  communityNotifications: {
    preference: {
      data: { enabled: true, revision: '2', updatedAt: '2026-01-02T00:00:00.000Z' },
      etag: 'pref-etag-2',
    },
    pending: null as string | null,
    mutationError: null as unknown,
    setPreference: vi.fn(),
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
vi.mock('../../lib/useCommunityNotificationCenter', () => ({
  useCommunityNotificationCenter: () => mocks.communityNotifications,
}))
vi.mock('../AppToast', () => ({
  useToast: () => ({ toast: vi.fn(), success: mocks.success, error: mocks.error }),
}))
vi.mock('../../api/authClient', () => ({ authClient: mocks.authClient }))
vi.mock('../../api', () => ({
  isProductApiError: (error: unknown) => !!error && typeof error === 'object' && 'fieldErrors' in error,
  isNotificationExposureEnabled: () => true,
  isCommunityExposureEnabled: () => mocks.communityEnabled,
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
    mocks.communityEnabled = false
    mocks.communityNotifications.setPreference.mockReset()
  })

  afterEach(() => cleanup())

  function render() {
    mountTree(<MemoryRouter initialEntries={['/library?settings=profile']}><SettingsDialog /></MemoryRouter>)
  }

  it('hides the Favicon nav item while the faviconPolicy flag is off', () => {
    mocks.isLive.mockImplementation((flag: string) => flag !== 'mfa' && flag !== 'faviconPolicy')
    render()
    const navLabels = [...document.querySelectorAll<HTMLButtonElement>('[data-settings-nav] button')]
      .map((button) => button.textContent)
    expect(navLabels).not.toContain('Favicon')
    expect(navLabels).toEqual(expect.arrayContaining(['Profile', 'Privacy', 'Notifications', 'Security']))
  })

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

  it('does not render a manual avatar URL input, only the image upload control', () => {
    render()
    expect(document.querySelector('#set-avatar')).toBeNull()
    expect(document.querySelector('#set-avatar-file')).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')).toBeNull()
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

  it('uploads a selected image and updates the avatar preview', async () => {
    mocks.uploadAvatar.mockResolvedValue({
      account: { id: 'account-1', email: 'user@example.test' },
      profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: 'https://cdn.example.test/avatar.png' },
    })
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.uploadAvatar).toHaveBeenCalledWith(
      file,
      { intentId: 'upload-avatar:command-1' },
    )
    expect(mocks.success).toHaveBeenCalledWith('Avatar updated')
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')?.getAttribute('src')).toBe('https://cdn.example.test/avatar.png')
  })

  it('disables the file input while an avatar upload is in flight and re-enables it after', async () => {
    let resolveUpload!: (value: {
      account: { id: string; email: string }
      profile: { id: string; handle: string; displayName: string; avatarUrl: string }
    }) => void
    mocks.uploadAvatar.mockReturnValue(new Promise((resolve) => { resolveUpload = resolve }))
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Upload in flight: picking another file is blocked and the UI says so.
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(true)
    expect(document.querySelector('[data-testid="avatar-upload-status"]')?.textContent).toBe('Uploading…')
    expect(mocks.success).not.toHaveBeenCalled()

    await act(async () => {
      resolveUpload({
        account: { id: 'account-1', email: 'user@example.test' },
        profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: 'https://cdn.example.test/avatar.png' },
      })
    })

    // Upload finished: the input is usable again and the progress hint is gone.
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(false)
    expect(document.querySelector('[data-testid="avatar-upload-status"]')).toBeNull()
    expect(mocks.success).toHaveBeenCalledWith('Avatar updated')
  })

  it('disables the save button while an avatar upload is in flight and re-enables it after', async () => {
    let resolveUpload!: (value: {
      account: { id: string; email: string }
      profile: { id: string; handle: string; displayName: string; avatarUrl: string }
    }) => void
    mocks.uploadAvatar.mockReturnValue(new Promise((resolve) => { resolveUpload = resolve }))
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    // Upload in flight: the save button is disabled so a concurrent save
    // cannot submit the stale avatarUrl that the upload is about to replace.
    const button = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('Save profile')
    // A disabled submit button cannot be activated: clicking it must not submit.
    await act(async () => { button.click() })
    expect(mocks.updateMe).not.toHaveBeenCalled()

    await act(async () => {
      resolveUpload({
        account: { id: 'account-1', email: 'user@example.test' },
        profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: 'https://cdn.example.test/avatar.png' },
      })
    })

    // Upload finished: the save button is clickable again. The avatar is
    // already persisted by the upload call, so the profile save does not need
    // to carry avatarUrl.
    expect(button.disabled).toBe(false)
    await act(async () => { button.click() })
    expect(mocks.updateMe).toHaveBeenCalledWith(
      { handle: 'original_handle', displayName: 'Phase 1 Real Stack', about: '' },
      { intentId: 'update-me:command-1' },
    )
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
    expect((document.querySelector<HTMLTextAreaElement>('#set-about')!).disabled).toBe(true)
    expect(document.querySelector('#set-avatar')).toBeNull()
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(true)

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
    expect((document.querySelector<HTMLTextAreaElement>('#set-about')!).disabled).toBe(false)
    expect(document.querySelector('#set-avatar')).toBeNull()
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(false)
    expect(mocks.success).toHaveBeenCalledWith('Profile saved')
  })

  it.each([
    { label: 'image/gif', filename: 'avatar.gif', type: 'image/gif' },
    { label: 'application/pdf', filename: 'avatar.pdf', type: 'application/pdf' },
    { label: 'empty type string', filename: 'avatar.bin', type: '' },
  ])('rejects a disallowed file type ($label) before calling the upload API', async ({ filename, type }) => {
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([1, 2, 3])], filename, { type })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.uploadAvatar).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Choose a PNG, JPEG or WebP image.')
    expect(document.querySelector('[data-testid="avatar-upload-status"]')).toBeNull()
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')).toBeNull()
  })

  it('accepts a whitelisted webp file type and uploads it', async () => {
    mocks.uploadAvatar.mockResolvedValue({
      account: { id: 'account-1', email: 'user@example.test' },
      profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: 'https://cdn.example.test/avatar.webp' },
    })
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'avatar.webp', { type: 'image/webp' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.uploadAvatar).toHaveBeenCalledWith(file, { intentId: 'upload-avatar:command-1' })
    expect(mocks.success).toHaveBeenCalledWith('Avatar updated')
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')?.getAttribute('src')).toBe('https://cdn.example.test/avatar.webp')
  })

  it('shows the API error message as an alert when the avatar upload fails', async () => {
    mocks.uploadAvatar.mockRejectedValue({
      code: 'rate_limited', message: 'Too many requests', fieldErrors: [],
      recoveryHint: 'Too many requests',
    })
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.uploadAvatar).toHaveBeenCalledWith(file, { intentId: 'upload-avatar:command-1' })
    expect(mocks.error).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Too many requests')
    expect(mocks.success).not.toHaveBeenCalled()
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(false)
    expect(document.querySelector('[data-testid="avatar-upload-status"]')).toBeNull()
  })

  it('shows a generic alert when the avatar upload fails with a non-API error', async () => {
    mocks.uploadAvatar.mockRejectedValue(new Error('network'))
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.error).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Avatar could not be uploaded. Try again.')
    expect(mocks.success).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="settings-avatar-preview"] img')).toBeNull()
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(false)
    expect(document.querySelector('[data-testid="avatar-upload-status"]')).toBeNull()
  })

  it('uses the first field error message as the alert when the avatar upload fails with field errors', async () => {
    const message = 'avatar must be a PNG, JPEG, or WebP image'
    mocks.uploadAvatar.mockRejectedValue({
      code: 'invalid_avatar', message: 'conflict', fieldErrors: [{ path: '/avatarUrl', code: 'invalid_avatar', message }],
    })
    render()
    const input = document.querySelector<HTMLInputElement>('#set-avatar-file')!
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(mocks.error).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message)
    expect((document.querySelector<HTMLInputElement>('#set-avatar-file')!).disabled).toBe(false)
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

  it('shows the handle as a public address the holder is invited to change', () => {
    render()
    const hint = document.querySelector('#set-handle-hint')
    // Without this the assigned handle reads as a system-owned key and
    // holders never discover the field is theirs.
    expect(hint?.textContent).toContain('know-n.com/u/original_handle')
    expect(hint?.textContent).toContain('change')
    expect(document.querySelector('#set-handle')?.getAttribute('aria-describedby'))
      .toBe('set-handle-hint')
  })

  it('previews the typed handle and bounds the input at the claim length', () => {
    render()
    const input = document.querySelector<HTMLInputElement>('#set-handle')!
    expect(input.maxLength).toBe(30)

    change(input, 'quiet-fern')
    expect(document.querySelector('#set-handle-hint')?.textContent)
      .toContain('know-n.com/u/quiet-fern')
  })

  it('does not overwrite a dirty about draft when the same account refreshes asynchronously', () => {
    mocks.auth.user = { ...mocks.auth.user!, about: 'Stored about' }
    render()
    const about = document.querySelector<HTMLTextAreaElement>('#set-about')!
    expect(about.value).toBe('Stored about')
    change(about, 'Draft about')

    mocks.auth.user = { ...mocks.auth.user!, name: 'Refreshed Name', about: 'Stored about' }
    render()
    expect(about.value).toBe('Draft about')
  })

  it('submits about with the real profile mutation', async () => {
    mocks.updateMe.mockResolvedValue({
      account: { id: 'account-1', email: 'user@example.test' },
      profile: { id: 'profile-1', handle: 'original_handle', displayName: 'Phase 1 Real Stack', avatarUrl: null, about: 'I collect bookmarks.' },
    })
    render()
    change(document.querySelector<HTMLTextAreaElement>('#set-about')!, 'I collect bookmarks.')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(mocks.updateMe).toHaveBeenCalledWith(
      { handle: 'original_handle', displayName: 'Phase 1 Real Stack', about: 'I collect bookmarks.' },
      { intentId: 'update-me:command-1' },
    )
    expect(mocks.auth.runAuthMutation).toHaveBeenCalled()
    expect(mocks.success).toHaveBeenCalledWith('Profile saved')
  })

  it('retries a stale CSRF token once when saving about', async () => {
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
    change(document.querySelector<HTMLTextAreaElement>('#set-about')!, 'I collect bookmarks.')
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
    change(document.querySelector<HTMLTextAreaElement>('#set-about')!, 'I collect bookmarks.')
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

  it('renders a field validation failure once, inline under the about textarea', async () => {
    const message = 'about must be at most 2000 characters'
    mocks.updateMe.mockRejectedValue({
      code: 'invalid_about', message, fieldErrors: [{ path: '/about', code: 'invalid_about', message }],
    })
    render()
    change(document.querySelector<HTMLTextAreaElement>('#set-about')!, '   ')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })

    expect(document.querySelector('#set-about + .field-error')?.textContent).toBe(message)
    expect(document.querySelectorAll('[data-testid="field-error"]')).toHaveLength(1)
    expect([...document.querySelectorAll('[role="alert"]')].map((node) => node.id)).toEqual(['set-about-error'])
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('hosts the community reply switch only while community is exposed', () => {
    mountTree(<MemoryRouter initialEntries={['/library?settings=notifications']}><SettingsDialog /></MemoryRouter>)
    expect(document.querySelector('[data-testid="in-app-preference"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="community-preference"]')).toBeNull()

    cleanup()
    mocks.communityEnabled = true
    mountTree(<MemoryRouter initialEntries={['/library?settings=notifications']}><SettingsDialog /></MemoryRouter>)
    const toggle = document.querySelector<HTMLButtonElement>('[data-testid="community-preference"] [role="switch"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-label')).toBe('Community reply notifications')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')
    act(() => toggle!.click())
    expect(mocks.communityNotifications.setPreference).toHaveBeenCalledWith(false)
  })
})
