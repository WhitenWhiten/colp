// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthRecovery } from './AuthRecovery'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  auth: {
    user: null as { name: string } | null,
    isLoggedIn: false,
    bootstrapping: false,
    csrfToken: null as string | null,
    refreshSession: vi.fn<() => Promise<void>>(),
    logout: vi.fn<() => Promise<'signed-out' | 'failed'>>(),
  },
  toast: {
    toast: vi.fn<(msg: string, variant?: string) => void>(),
    success: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
  },
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../components/AppToast', () => ({ useToast: () => mocks.toast }))

function LoginProbe() {
  const location = useLocation()
  return <div data-testid="page-login">{location.search}</div>
}

describe('AuthRecovery', () => {

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = null
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.auth.logout.mockReset().mockResolvedValue('signed-out')
    mocks.toast.success.mockReset()
  })

  afterEach(() => cleanup())

  function render(initialPath = '/auth/recovery') {
    mountTree(
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/auth/recovery" element={<AuthRecovery />} />
            <Route path="/login" element={<LoginProbe />} />
            <Route path="/verify-email" element={<div data-testid="page-verify" />} />
            <Route path="/library" element={<div data-testid="page-library" />} />
          </Routes>
        </MemoryRouter>,
      )
  }

  it('explains a failed OAuth callback and links back to login with the safe returnTo', async () => {
    render('/auth/recovery?auth=failed&returnTo=%2Flibrary')
    expect(document.body.textContent).toContain('Sign-in failed')
    expect(document.body.textContent).toContain('Your session was not created')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-testid="recovery-login"]')!.click()
    })
    expect(document.querySelector('[data-testid="page-login"]')?.textContent).toBe(
      '?returnTo=%2Flibrary',
    )
  })

  it('signs out and returns to login when the session must restart', async () => {
    render('/auth/recovery?auth=restart&returnTo=%2Flibrary')
    expect(document.body.textContent).toContain('Session ended')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-testid="recovery-logout"]')!.click()
    })
    expect(mocks.auth.logout).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-login"]')).not.toBeNull()
    // Recovery never bootstraps a session by itself.
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
  })

  it('asks the user to verify their email for verification_required', async () => {
    render('/auth/recovery?error=verification_required')
    expect(document.body.textContent).toContain('Verify your email')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-testid="recovery-verify"]')!.click()
    })
    expect(document.querySelector('[data-testid="page-verify"]')).not.toBeNull()
  })

  it('explains explicit account linking for link_required', async () => {
    render('/auth/recovery?error=link_required')
    expect(document.body.textContent).toContain('Account linking required')
    expect(document.body.textContent).toContain('Sign in with your email')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-testid="recovery-login"]')!.click()
    })
    expect(document.querySelector('[data-testid="page-login"]')).not.toBeNull()
  })

  it('handles account_link_required the same way', async () => {
    render('/auth/recovery?error=account_link_required')
    expect(document.body.textContent).toContain('Account linking required')
  })

  it('falls back to /library when returnTo is cross-origin', async () => {
    render('/auth/recovery?auth=failed&returnTo=https%3A%2F%2Fevil.example%2Fphish')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[data-testid="recovery-login"]')!.click()
    })
    const search = document.querySelector('[data-testid="page-login"]')?.textContent
    expect(search).toBe('?returnTo=%2Flibrary')
    expect(search).not.toContain('evil.example')
  })

  it('offers to continue to the returnTo when signed in', async () => {
    mocks.auth.isLoggedIn = true
    mocks.auth.user = { name: 'Ada' }
    render('/auth/recovery?auth=failed&returnTo=%2Flibrary')

    const continueButton = document.querySelector<HTMLButtonElement>(
      'button[data-testid="recovery-continue"]',
    )
    expect(continueButton).not.toBeNull()
    await act(async () => {
      continueButton!.click()
    })
    expect(document.querySelector('[data-testid="page-library"]')).not.toBeNull()
  })

  it('renders a neutral panel when no recovery params are present', () => {
    render('/auth/recovery')
    expect(document.body.textContent).toContain('Authentication recovery')
    const loginLink = document.querySelector<HTMLAnchorElement>('a[href^="/login"]')
    expect(loginLink).not.toBeNull()
    expect(document.querySelector('[data-testid="recovery-logout"]')).toBeNull()
    expect(mocks.auth.logout).not.toHaveBeenCalled()
  })

  it('never sets a session while recovering', () => {
    render('/auth/recovery?auth=failed&returnTo=%2Flibrary')
    expect(mocks.auth.refreshSession).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="page-library"]')).toBeNull()
  })
})
