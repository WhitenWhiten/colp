/**
 * Shared scaffold for the Login page suites. Each test file still registers
 * its own vi.mock factories that import Login.test-mocks.ts.
 */
import { act, type ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { Login } from './Login'
import { cleanup, mountTree } from '../test/render'
import { mocks } from './Login.test-mocks'

export { mocks } from './Login.test-mocks'

export function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

export function submitForm() {
  document.querySelector<HTMLFormElement>('form')!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
}

export function signInButton() {
  return document.querySelector<HTMLButtonElement>('form button[type="submit"]')!
}

export function sendOtpButton() {
  return document.querySelector<HTMLButtonElement>('#login-send-otp')!
}

/** The auth card is the heading's parent. Tests must not query it by class. */
export function loginCardText() {
  return document.querySelector('h1')?.parentElement?.textContent ?? ''
}

export function resetLoginMocks() {
  document.body.innerHTML = '<div id="root"></div>'
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.auth.user = null
  mocks.auth.isLoggedIn = false
  mocks.auth.bootstrapping = false
  mocks.auth.refreshSession.mockReset().mockResolvedValue(undefined)
  mocks.auth.logout.mockReset().mockResolvedValue('signed-out')
  mocks.toast.toast.mockReset()
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
  mocks.authClient.signInWithPassword.mockReset()
  mocks.authClient.signUpWithPassword.mockReset()
  mocks.authClient.sendOtp.mockReset()
  mocks.authClient.signInWithOtp.mockReset()
  mocks.authClient.startOAuth.mockReset()
}

export function renderLogin(initialPath = '/login') {
  return mountTree(
    (
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/library" element={<div data-testid="page-library" />} />
          <Route path="/approvals/:planId" element={<div data-testid="page-approval" />} />
          <Route path="/verify-email" element={<div data-testid="page-verify" />} />
          <Route path="/reset-password" element={<div data-testid="page-reset" />} />
          <Route path="/onboarding" element={<div data-testid="page-onboarding" />} />
        </Routes>
      </MemoryRouter>
    ) as ReactElement,
  )
}

export { cleanup }
