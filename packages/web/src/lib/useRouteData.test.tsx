// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { clearRouteCache } from './routeCache'
import { useRouteData } from './useRouteData'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

function Harness({
  cacheKey = 'route-data:test',
  enabled = true,
  load,
}: {
  cacheKey?: string
  enabled?: boolean
  load: (signal: AbortSignal) => Promise<string>
}) {
  const route = useRouteData({
    cacheKey,
    enabled,
    load,
    fallbackError: 'Could not load the board. Try again.',
  })
  return (
    <div data-testid="route" data-status={route.status} data-error={route.error ?? ''}>
      <span data-testid="value">{route.data ?? ''}</span>
      <button type="button" onClick={() => void route.reload()}>Retry</button>
      <button type="button" onClick={() => void route.reload({ silent: true })}>Silent</button>
    </div>
  )
}

describe('useRouteData', () => {
  beforeEach(() => {
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z',
    })
    applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
  })
  afterEach(() => { cleanup(); clearSession(); clearRouteCache(); document.body.innerHTML = '' })

  it('loads, caches, and paints the cache on remount while revalidating', async () => {
    /* Endpoint state, not a call queue: the resource holds `first` until it is
       updated to `second`. Every read during the first mount therefore sees
       the same body, however many times React invokes the mount effect. */
    let version = 'first'
    const load = vi.fn(() => Promise.resolve(version))
    mountTree(<Harness load={load} />)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('first')
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-status')).toBe('ready')

    version = 'second'
    const loadsBeforeRemount = load.mock.calls.length
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    mountTree(<Harness load={load} />)
    // The cached body paints before the revalidating read resolves...
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('first')
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-status')).toBe('ready')
    // ...and the remount does revalidate.
    expect(load.mock.calls.length).toBeGreaterThan(loadsBeforeRemount)
    await waitForDom(() => document.querySelector('[data-testid="value"]')?.textContent === 'second')
  })

  it('maps 401 to auth and 404 to unavailable, and Retry recovers from error', async () => {
    const load = vi.fn()
      .mockRejectedValue(new ProductApiError({ status: 401, code: 'authentication_required', message: 'Sign in' }))
    mountTree(<Harness load={load} />)
    await waitForDom(() => document.querySelector('[data-testid="route"]')?.getAttribute('data-status') === 'auth')
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('')

    cleanup()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    const missing = vi.fn().mockRejectedValue(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'Gone',
    }))
    mountTree(<Harness load={missing} />)
    await waitForDom(() => document.querySelector('[data-testid="route"]')?.getAttribute('data-status') === 'unavailable')

    cleanup()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    /* The board is unreachable until the reader retries, then it answers. */
    let reachable = false
    const flaky = vi.fn(() => (
      reachable ? Promise.resolve('recovered') : Promise.reject(new Error('network'))
    ))
    mountTree(<Harness load={flaky} />)
    await waitForDom(() => document.querySelector('[data-testid="route"]')?.getAttribute('data-status') === 'error')
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-error')).toBe('Could not load the board. Try again.')
    reachable = true
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Retry')?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('recovered')
  })

  it('does not treat AbortError as a load failure', async () => {
    const load = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    mountTree(<Harness load={load} />)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-status')).toBe('ready')
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-error')).toBe('')
  })

  it('keeps painted rows when a silent refresh fails, and skips work when disabled', async () => {
    /* The board loads, then the endpoint starts failing: the silent refresh
       must keep the painted rows and surface no error. */
    let failing = false
    const load = vi.fn(() => (
      failing ? Promise.reject(new Error('network')) : Promise.resolve('cached')
    ))
    mountTree(<Harness load={load} />)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('cached')
    failing = true
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Silent')?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('cached')
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-status')).toBe('ready')
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-error')).toContain('previously loaded data')

    cleanup()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    const idle = vi.fn()
    mountTree(<Harness enabled={false} load={idle} />)
    expect(document.querySelector('[data-testid="route"]')?.getAttribute('data-status')).toBe('unavailable')
    expect(idle).not.toHaveBeenCalled()
  })
  it('rejects an old account response after a session identity switch', async () => {
    const releases: ((value: string) => void)[] = []; let switched = false
    const load = () => switched ? Promise.resolve('account-b data') : new Promise<string>(resolve => releases.push(resolve))
    mountTree(<Harness load={load} />)
    await act(async () => { switched = true; applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } }) })
    await waitForDom(domFinishedLoading)
    await act(async () => { for (const release of releases) release('old private data') })
    expect(document.querySelector('[data-testid="value"]')?.textContent).toBe('account-b data')
  })

})
