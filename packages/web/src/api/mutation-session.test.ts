import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from './errors'
import { captureMutationSession } from './mutation-session'
import { createMutationCall } from './product-client-shared'
import type { SessionView } from './types'

const state = vi.hoisted(() => ({
  snapshot: {
    authenticated: true,
    csrfToken: 'csrf-A',
    sessionEpoch: 1,
    me: { account: { id: 'A' } },
  },
  clear: vi.fn(),
  rotate: vi.fn(),
}))
vi.mock('./sessionStore', () => ({
  getSessionSnapshot: () => state.snapshot,
  getCsrfToken: () => state.snapshot.csrfToken,
}))
vi.mock('./commandId', () => ({
  getOrCreateCommandId: () => 'fixture-command',
  clearCommandId: state.clear,
  rotateCommandId: state.rotate,
}))

const authError = () => new ProductApiError({
  status: 401, code: 'authentication_required', message: 'expired',
  recovery: 'user_action', sameRequestRetrySafe: false,
})
const sessionView = () => ({ authenticated: true, csrfToken: state.snapshot.csrfToken }) as SessionView
const switchAccount = () => {
  state.snapshot = { authenticated: true, csrfToken: 'csrf-B', sessionEpoch: 2, me: { account: { id: 'B' } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.snapshot = { authenticated: true, csrfToken: 'csrf-A', sessionEpoch: 1, me: { account: { id: 'A' } } }
})

describe('mutation session identity fencing', () => {
  it('accepts an unchanged session', () => {
    expect(captureMutationSession()).not.toThrow()
  })

  it('rejects a new epoch even when the account ID is unchanged', () => {
    const guard = captureMutationSession()
    state.snapshot.sessionEpoch += 1
    expect(guard).toThrow(/session changed/)
  })

  it('rejects a changed account even before an epoch update arrives', () => {
    const guard = captureMutationSession()
    state.snapshot.me.account.id = 'B'
    expect(guard).toThrow(/session changed/)
  })

  it('rejects sign-out and an A-to-B-to-A replacement session', () => {
    const guard = captureMutationSession()
    state.snapshot.authenticated = false
    expect(guard).toThrow(/session changed/)
    state.snapshot.authenticated = true
    state.snapshot.sessionEpoch += 2
    expect(guard).toThrow(/session changed/)
  })

  it('preserves ordinary successful mutation and command cleanup', async () => {
    const readSession = vi.fn(async () => sessionView())
    const mutate = createMutationCall(readSession, async () => 'csrf-A')
    const action = vi.fn(async () => 'saved')
    await expect(mutate(action, { intentId: 'save' })).resolves.toBe('saved')
    expect(action).toHaveBeenCalledOnce()
    expect(state.clear).toHaveBeenCalledWith('save')
  })

  it('permits one auth retry only when refresh preserves identity and epoch', async () => {
    const readSession = vi.fn(async () => sessionView())
    const mutate = createMutationCall(readSession, async () => 'csrf-A')
    const action = vi.fn(async () => 'saved').mockRejectedValueOnce(authError())
    await expect(mutate(action, { intentId: 'save' })).resolves.toBe('saved')
    expect(action).toHaveBeenCalledTimes(2)
    expect(readSession).toHaveBeenCalledOnce()
  })

  it('does not replay account A content after refresh discovers account B', async () => {
    const readSession = vi.fn(async () => { switchAccount(); return sessionView() })
    const mutate = createMutationCall(readSession, async () => state.snapshot.csrfToken)
    const action = vi.fn(async () => 'saved').mockRejectedValueOnce(authError())
    await expect(mutate(action, { intentId: 'save' })).rejects.toMatchObject({
      code: 'mutation_conflict', sameRequestRetrySafe: false,
    })
    expect(action).toHaveBeenCalledOnce()
    expect(state.clear).not.toHaveBeenCalled()
  })

  it('checks identity again after awaiting CSRF acquisition', async () => {
    const readSession = vi.fn(async () => sessionView())
    const mutate = createMutationCall(readSession, async () => { switchAccount(); return 'csrf-B' })
    const action = vi.fn(async () => 'saved')
    await expect(mutate(action, { intentId: 'save' })).rejects.toThrow(/session changed/)
    expect(action).not.toHaveBeenCalled()
  })

  it('also fences automatic transient-error retries', async () => {
    const readSession = vi.fn(async () => sessionView())
    const mutate = createMutationCall(readSession, async () => state.snapshot.csrfToken)
    const action = vi.fn(async () => {
      switchAccount()
      throw new ProductApiError({
        status: 503, code: 'internal_error', message: 'retry', recovery: 'same_request',
        sameRequestRetrySafe: true, retryAfterSeconds: 0,
      })
    })
    await expect(mutate(action, { intentId: 'save', maxRetries: 1 })).rejects.toThrow(/session changed/)
    expect(action).toHaveBeenCalledOnce()
    expect(readSession).not.toHaveBeenCalled()
  })

  it('does not publish a late success or clear its intent under a new account', async () => {
    const mutate = createMutationCall(async () => sessionView(), async () => 'csrf-A')
    await expect(mutate(async () => { switchAccount(); return 'saved' }, { intentId: 'save' }))
      .rejects.toThrow(/session changed/)
    expect(state.clear).not.toHaveBeenCalled()
  })
})
