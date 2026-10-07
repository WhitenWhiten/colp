// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import { ProductApiError } from '../api/errors'
import { useMyCollaborationInvites } from './useMyCollaborationInvites'
import hookSource from './useMyCollaborationInvites.ts?raw'
import clientSource from '../api/productClient.ts?raw'

const clientDomainSources = Object.values(import.meta.glob('../api/product-client-*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const clientSources = [clientSource, ...clientDomainSources].join('\n')
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      listMyCollaborationInvites: mocks.list,
      acceptCollaborationInvite: mocks.accept,
      declineCollaborationInvite: mocks.decline,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

type Invite = {
  inviteId: string
  collectionId: string
  collectionTitle: string
  role: 'editor' | 'viewer'
  email: string
  expiresAt: string
  invitedAt: string
}

function invite(overrides: Partial<Invite> = {}): Invite {
  return {
    inviteId: 'inv-1',
    collectionId: 'col-shared',
    collectionTitle: 'Frozen Shelf',
    role: 'editor',
    email: 'b@example.test',
    expiresAt: '2026-08-26T00:00:00.000Z',
    invitedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  }
}

function Harness() {
  const invites = useMyCollaborationInvites()
  return (
    <div data-state={invites.state} data-pending={invites.pendingInviteId ?? ''}>
      <span data-testid="titles">{invites.items.map((item) => item.collectionTitle).join(',')}</span>
      <span data-testid="ids">{invites.items.map((item) => item.inviteId).join(',')}</span>
      <span data-testid="message">{invites.message}</span>
      <button type="button" onClick={() => void invites.accept('inv-1')}>Accept</button>
      <button type="button" onClick={() => void invites.decline('inv-1')}>Decline</button>
      <button type="button" onClick={() => void invites.reload()}>Reload</button>
    </div>
  )
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the hook renders the invitation's *frozen* `collectionTitle`
 *    from the list payload, accepts/declines with a command intent and exactly
 *    two arguments, refreshes the list exactly once, ignores a late response
 *    for the previous account, and stays inert while signed out or before /me
 *    hydrates. Driven through the real hook with the Product client mocked.
 *
 * 2. Architecture — the *invite* half of the no-If-Match rule and the absence
 *    of seeded people. The hook half is behaviour-proven (both calls are made
 *    with exactly two arguments); what no render can see is the generated
 *    client bridge adding an If-Match inside its own call — with the client
 *    mocked that is indistinguishable from the correct call and would only
 *    fail against the live API. An unused seed list renders nothing either.
 */
describe('useMyCollaborationInvites behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z',
    })
    applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
    mocks.list.mockResolvedValue({ items: [invite()] })
    mocks.accept.mockResolvedValue({
      collectionId: 'col-shared', subjectId: 'sub-b', role: 'editor',
      grantedAt: '2026-08-19T01:00:00.000Z', policyEtag: '"p-2"',
    })
    mocks.decline.mockResolvedValue(undefined)
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })
  function render() { mountTree(<Harness />) }

  it('renders the frozen collectionTitle from the invitation payload', async () => {
    /* The hook shows the title frozen into the invitation, not a live
       collection lookup: the value is tied to the payload field by
       construction, so a hook that re-derived the title from anywhere else
       fails here. */
    const frozen = invite({ collectionTitle: 'Frozen Shelf (title at invite time)' })
    mocks.list.mockResolvedValue({ items: [frozen] })
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="titles"]')?.textContent).toBe(frozen.collectionTitle)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('inv-1')
  })

  it('accepts with command intent and CSRF path, then refreshes pending invites', async () => {
    /* The server owns the pending list: accepting removes the invite, so every
       read (including StrictMode's duplicate mount read) sees the same state. */
    let serverInvites: Invite[] = [invite()]
    mocks.list.mockImplementation(() => Promise.resolve({ items: serverInvites }))
    mocks.accept.mockImplementation(async () => {
      serverInvites = []
      return {
        collectionId: 'col-shared', subjectId: 'sub-b', role: 'editor',
        grantedAt: '2026-08-19T01:00:00.000Z', policyEtag: '"p-2"',
      }
    })
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('inv-1')
    const readsBeforeAccept = mocks.list.mock.calls.length
    await act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Accept')?.click()
      await Promise.resolve(); await Promise.resolve()
    })
    expect(mocks.accept).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({ intentId: expect.stringContaining('accept-collaboration-invite:inv-1') }),
    )
    expect(mocks.accept.mock.calls[0]).toHaveLength(2)
    /* Accepting must refresh the list exactly once — a re-fetch loop would show
       up as more than one extra read. */
    expect(mocks.list.mock.calls.length).toBe(readsBeforeAccept + 1)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('')
  })

  it('declines without If-Match and removes the invite after refresh', async () => {
    /* Same server-state model as accept: declining removes the invite. */
    let serverInvites: Invite[] = [invite()]
    mocks.list.mockImplementation(() => Promise.resolve({ items: serverInvites }))
    mocks.decline.mockImplementation(async () => { serverInvites = [] })
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('inv-1')
    const readsBeforeDecline = mocks.list.mock.calls.length
    await act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Decline')?.click()
      await Promise.resolve(); await Promise.resolve()
    })
    expect(mocks.decline).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({ intentId: expect.stringContaining('decline-collaboration-invite:inv-1') }),
    )
    expect(mocks.decline.mock.calls[0]).toHaveLength(2)
    /* Declining must refresh the list exactly once. */
    expect(mocks.list.mock.calls.length).toBe(readsBeforeDecline + 1)
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('')
  })

  it('ignores a late list after the account changes', async () => {
    let resolveOld: ((value: { items: Invite[] }) => void) | undefined
    /* The list endpoint answers per signed-in account: account-a's read is held
       open so it can settle after the switch, account-b answers immediately. */
    mocks.list.mockImplementation(() => {
      if ((getSessionSnapshot().me?.account.id ?? 'anonymous') === 'account-a') {
        return new Promise<{ items: Invite[] }>((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve({ items: [invite({ inviteId: 'inv-b', collectionTitle: 'Account B' })] })
    })
    render(); await settled()
    /* The held-open read really exists, so the late-resolve probe below cannot
       pass by doing nothing. */
    expect(resolveOld).toBeTypeOf('function')
    const oldSignal = mocks.list.mock.calls.at(-1)![0].signal as AbortSignal
    await act(async () => {
      applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } })
      await Promise.resolve(); await Promise.resolve()
    })
    expect(oldSignal.aborted).toBe(true)
    await waitForDom(() => document.querySelector('[data-testid="titles"]')?.textContent === 'Account B')
    expect(document.querySelector('[data-testid="titles"]')?.textContent).toBe('Account B')
    await act(async () => { resolveOld?.({ items: [invite()] }); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('[data-testid="titles"]')?.textContent).toBe('Account B')
  })

  it('does not fetch invitations while signed out', async () => {
    clearSession()
    render(); await waitForDom(domFinishedLoading)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(document.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready')
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('')
  })

  it('fetches after /session even before /me hydrates', async () => {
    clearSession()
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z',
    })
    render(); await waitForDom(domFinishedLoading)
    /* StrictMode deliberately runs the mount effect twice; the hook's cleanup
       aborts the first read, so exactly one read stays live. */
    const liveReads = mocks.list.mock.calls.filter((call) => !(call[0]!.signal as AbortSignal).aborted)
    expect(liveReads).toHaveLength(1)
    expect(liveReads[0]![0]).toMatchObject({ maxRetries: 0 })
    const readsBeforeHydration = mocks.list.mock.calls.length
    await act(async () => {
      applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
      await Promise.resolve(); await Promise.resolve()
    })
    /* /me hydrating for the same private identity must not issue another read. */
    expect(mocks.list.mock.calls.length).toBe(readsBeforeHydration)
  })

  it('does not fetch invitations when the account has no verified email', async () => {
    applyMeView({ account: { id: 'account-a', email: null }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
    render(); await waitForDom(domFinishedLoading)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(document.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready')
    expect(document.querySelector('[data-testid="message"]')?.textContent).toBe('No invitations')
  })

  it('treats a verified-email requirement as an empty list, not a sidebar error', async () => {
    /* Every read for this account is rejected with the verified-email
       requirement, as the endpoint would answer it. */
    mocks.list.mockRejectedValue(new ProductApiError({
      status: 400,
      code: 'invalid_request',
      message: 'A verified email is required.',
      recovery: 'user_action',
    }))
    render(); await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ready')
    expect(document.querySelector('[data-testid="ids"]')?.textContent).toBe('')
    expect(document.querySelector('[data-testid="message"]')?.textContent).toBe('No invitations')
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('never adds If-Match to accept or decline, and ships no seeded people', () => {
    /* `ifMatch` / `If-Match` on an invite transition would make the mutation
       fail (or silently retarget) against the policy etag; the hook passes
       exactly two arguments, proven behaviourally above. The generated client
       bridge is the remaining path, and with the client mocked a bridge that
       appended an If-Match would look identical to the correct call — only the
       live API would reject it. Seeded people in the hook are dead data.
       Non-vacuity: the scanned module set really is the client bridge. */
    expect(hookSource.length).toBeGreaterThan(4_000)
    expect(clientSources.length).toBeGreaterThan(100_000)
    expect(clientSources).toContain('acceptCollaborationInvite')
    expect(clientSources).toContain('declineCollaborationInvite')
    expect(hookSource).not.toMatch(/ifMatch|If-Match/)
    expect(clientSources).not.toMatch(/\.acceptCollaborationInvite\([^)]*ifMatch/)
    expect(clientSources).not.toMatch(/\.declineCollaborationInvite\([^)]*ifMatch/)
    expect(hookSource).not.toMatch(/Alex Chen|Jordan Blake|Morgan Lee|Priya Shah/)
  })
})
