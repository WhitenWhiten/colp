// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SelfHostedRegister } from './SelfHostedRegister'
import { cleanup, mountTree } from '../test/render'

const mocks = vi.hoisted(() => ({
  refreshSession: vi.fn<() => Promise<void>>(),
  getRegistrationState: vi.fn(),
  signUpWithUsername: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ refreshSession: mocks.refreshSession }),
}))
vi.mock('../api/authClient', () => ({
  authClient: {
    getRegistrationState: mocks.getRegistrationState,
    signUpWithUsername: mocks.signUpWithUsername,
  },
}))

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SelfHostedRegister', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.refreshSession.mockReset().mockResolvedValue(undefined)
    mocks.getRegistrationState.mockReset()
    mocks.signUpWithUsername.mockReset().mockResolvedValue({ status: true })
  })

  afterEach(() => cleanup())

  async function render() {
    await act(async () => {
      mountTree(
        <MemoryRouter>
          <SelfHostedRegister />
        </MemoryRouter>,
      )
    })
  }

  it('shows the owner form only when registration is open for first-run', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'first-run' })
    await render()
    expect(document.querySelector('[data-testid="registration-owner"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Create the owner account')
    expect(document.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('shows the invite form when registration is open for an invite', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'invite' })
    await render()
    expect(document.querySelector('[data-testid="registration-invite"]')).not.toBeNull()
    expect(document.querySelector('#register-invite')).not.toBeNull()
  })

  it('does not show sign-up when open is false', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: false, reason: 'closed' })
    await render()
    expect(document.querySelector('[data-testid="registration-closed"]')).not.toBeNull()
    expect(document.querySelector('form')).toBeNull()
    expect(document.querySelector('input[type="password"]')).toBeNull()
    expect(document.body.textContent).toContain('Registration is closed')
  })

  it('does not show sign-up when the registration-state body is unusable', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true })
    await render()
    expect(document.querySelector('[data-testid="registration-error"]')).not.toBeNull()
    expect(document.querySelector('form')).toBeNull()
  })

  it('posts the owner username, password, and setup token', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'first-run' })
    await render()
    expect(document.querySelector('[data-testid="setup-token-help"]')?.textContent).toContain('colp-server setup-token')
    change(document.querySelector('#register-setup-token') as HTMLInputElement, ' token-from-log ')
    change(document.querySelector('#register-username') as HTMLInputElement, 'alice')
    change(document.querySelector('#register-password') as HTMLInputElement, 'correct-horse')
    const form = document.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.signUpWithUsername).toHaveBeenCalledWith({
      username: 'alice',
      password: 'correct-horse',
      setupToken: 'token-from-log',
      callbackURL: '/library',
    })
  })

  it('asks for the setup token before posting the owner account', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'first-run' })
    await render()
    change(document.querySelector('#register-username') as HTMLInputElement, 'alice')
    change(document.querySelector('#register-password') as HTMLInputElement, 'correct-horse')
    const form = document.querySelector('form') as HTMLFormElement
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(mocks.signUpWithUsername).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Enter the setup token from the server log.')
  })

  it('does not show the setup token on the invite form', async () => {
    mocks.getRegistrationState.mockResolvedValue({ open: true, reason: 'invite' })
    await render()
    expect(document.querySelector('#register-setup-token')).toBeNull()
  })
})
