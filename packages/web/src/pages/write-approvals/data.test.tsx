// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLocation } from 'react-router-dom'
import { ProductApiError } from '../../api'
import { cleanup, mountTree, waitForDom } from '../../test/render'
import { useWriteApprovals } from './data'

/**
 * The superseded mount pass must not act on its own rejection.
 *
 * StrictMode mounts the list effect twice; the first pass's controller is
 * aborted on cleanup, but the request is already in flight and can still reject.
 * The success path guards on the signal, so the catch has to as well — without
 * that check a 401 from the abandoned pass runs `redirectToLogin`, and any other
 * error paints `loadError` over rows the live pass already loaded.
 */
const mocks = vi.hoisted(() => ({ page: vi.fn(), owned: vi.fn(), success: vi.fn(), error: vi.fn(), toast: vi.fn() }))
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    isWriteApprovalsExposureEnabled: () => true,
    productClient: {
      ...actual.productClient,
      getWriteApprovalPage: mocks.page,
      getWriteApproval: mocks.page,
      loadOwnedCollections: mocks.owned,
      resolveWriteApprovalCollections: mocks.owned,
    },
  }
})
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: true, bootstrapping: false }),
}))
vi.mock('../../components/AppToast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, toast: mocks.toast }),
}))

describe('useWriteApprovals superseded mount pass', () => {
  let current: ReturnType<typeof useWriteApprovals> | undefined

  /** `redirectToLogin` navigates, so the location is the observable. */
  function Probe() {
    current = useWriteApprovals()
    const location = useLocation()
    return <p data-testid="pathname">{location.pathname}</p>
  }
  const pathname = () => document.querySelector('[data-testid="pathname"]')?.textContent ?? null

  beforeEach(() => {
    vi.clearAllMocks()
    current = undefined
    mocks.owned.mockResolvedValue({ items: [] })
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })

  it('does not sign the user out when the abandoned mount pass rejects with 401', async () => {
    let release!: (reason: unknown) => void
    const first = new Promise((_resolve, reject) => { release = reject })
    mocks.page.mockImplementationOnce(() => first)
    mocks.page.mockResolvedValue({ items: [], nextCursor: null })

    mountTree(<Probe />, { initialEntries: ['/approvals'] })
    await waitForDom(() => mocks.page.mock.calls.length >= 1)

    // The abandoned pass's request rejects AFTER its controller was aborted.
    release(new ProductApiError({ status: 401, code: 'authentication_required', message: 'expired' }))
    // The LIVE pass finishes first, so anything the abandoned pass sets has landed
    // by the time this resolves.
    await waitForDom(() => current?.loading === false)

    expect(current?.loadError).toBeNull()
    expect(current?.loadErrorKind).toBeNull()
    expect(pathname()).toBe('/approvals')
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it('does not paint a load error from the abandoned mount pass', async () => {
    let release!: (reason: unknown) => void
    const first = new Promise((_resolve, reject) => { release = reject })
    mocks.page.mockImplementationOnce(() => first)
    mocks.page.mockResolvedValue({ items: [], nextCursor: null })

    mountTree(<Probe />, { initialEntries: ['/approvals'] })
    await waitForDom(() => mocks.page.mock.calls.length >= 1)
    release(new ProductApiError({ status: 503, code: 'service_unavailable', message: 'try later' }))
    await waitForDom(() => current?.loading === false)

    expect(current?.loadError).toBeNull()
    expect(current?.loadErrorKind).toBeNull()
  })
})
