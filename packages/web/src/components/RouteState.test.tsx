// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RouteState } from './RouteState'
import { cleanup, mountTree } from '../test/render'

const auth = vi.hoisted(() => ({ sessionState: 'signed-out', refreshSession: vi.fn(async () => {}) }))
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }))

describe('RouteState', () => {
  beforeEach(() => {
    auth.sessionState = 'signed-out'
    auth.refreshSession.mockClear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('sends auth failures to Sign in instead of Retry', () => {
    mountTree(
      <MemoryRouter>
        <RouteState kind="auth" description="You need to be signed in to review this inbox." />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Sign in to continue')
    expect(document.querySelector('a[href="/login"]')?.textContent).toBe('Sign in')
    expect(document.body.textContent).not.toContain('Retry')
  })

  it('shows an outage state, not Sign in, while the session cannot be read (R15-23)', () => {
    auth.sessionState = 'offline'
    mountTree(
      <MemoryRouter>
        <RouteState kind="auth" title="Sign in to open your library" />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Know-N is unavailable right now')
    expect(document.body.textContent).not.toContain('Sign in')
    expect(document.querySelector('a[href^="/login"]')).toBeNull()
    ;[...document.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click()
    expect(auth.refreshSession).toHaveBeenCalledTimes(1)
  })

  it('forwards an optional returnTo on the Sign in link', () => {
    mountTree(
      <MemoryRouter>
        <RouteState kind="auth" returnTo="/library/new" />
      </MemoryRouter>,
    )
    expect(document.querySelector('a[href="/login?returnTo=%2Flibrary%2Fnew"]')?.textContent).toBe('Sign in')
  })

  it('defaults the Sign in link to the current location', () => {
    mountTree(
      <MemoryRouter initialEntries={['/sync']}>
        <RouteState kind="auth" />
      </MemoryRouter>,
    )
    expect(document.querySelector('a[href="/login?returnTo=%2Fsync"]')?.textContent).toBe('Sign in')
  })

  it('renders deployment-unavailable copy without a retry action', () => {
    mountTree(
      <MemoryRouter>
        <RouteState kind="unavailable" title="Link health is not available yet" feature="bookmark link health" />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Link health is not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(document.body.textContent).not.toContain('Retry')
    expect(document.body.textContent).not.toContain('This library has not enabled')
  })

  it('announces a forbidden page without Retry or Sign in', () => {
    mountTree(
      <MemoryRouter>
        <RouteState kind="forbidden" />
      </MemoryRouter>,
    )
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('You do not have access')
    expect(document.body.textContent).not.toContain('Retry')
    expect(document.body.textContent).not.toContain('Sign in')
  })

  it('keeps a Try again button on generic load errors', () => {
    const onRetry = vi.fn()
    mountTree(
      <MemoryRouter>
        <RouteState kind="error" title="Couldn't load link health" onRetry={onRetry} />
      </MemoryRouter>,
    )
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')
    expect(retry).toBeTruthy()
    retry?.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})