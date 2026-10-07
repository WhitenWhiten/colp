// @vitest-environment happy-dom
import { act } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../api/featureFlags'
import { ProductApiError } from '../api/errors'
import { formatDate } from '../lib/formatDate'
import collaboratorsSource from './Collaborators.tsx?raw'
import { Collaborators } from './Collaborators'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'
import { clearRouteCache } from '../lib/routeCache'

const mocks = vi.hoisted(() => ({
  auth: { isLoggedIn: true, bootstrapping: false },
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  listCollectionMembers: vi.fn(),
  inviteCollectionMember: vi.fn(),
  revokeCollectionInvite: vi.fn(),
  updateCollectionMemberRole: vi.fn(),
  removeCollectionMember: vi.fn(),
}))

vi.mock('../auth/AuthContext', () => ({ useAuth: () => mocks.auth }))
vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      listCollectionMembers: mocks.listCollectionMembers,
      inviteCollectionMember: mocks.inviteCollectionMember,
      revokeCollectionInvite: mocks.revokeCollectionInvite,
      updateCollectionMemberRole: mocks.updateCollectionMemberRole,
      removeCollectionMember: mocks.removeCollectionMember,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

/** Buttons of the shared confirm modal (ConfirmProvider is mounted by mountTree). */
function modalButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="modal-panel"] button')]
    .find((button) => button.textContent?.trim() === label)
}

type MembersPage = {
  collection: { id: string; title: string }
  caller: { subjectId: string; role: 'owner' | 'editor' | 'viewer'; canManage: boolean; canLeave: boolean }
  policyEtag: string
  members: Array<{
    subjectId: string
    role: 'owner' | 'editor' | 'viewer'
    displayName: string
    email: string | null
    initials: string
    avatarUrl?: string | null
    grantedAt: string
  }>
  invites: Array<{
    inviteId: string
    email: string
    role: 'editor' | 'viewer'
    createdAt: string
    expiresAt: string
  }>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function membersPage(overrides: Partial<MembersPage> = {}): MembersPage {
  return {
    collection: { id: 'col-1', title: 'Research Shelf' },
    caller: { subjectId: 'sub-owner', role: 'owner', canManage: true, canLeave: false },
    policyEtag: '"p-col-1"',
    members: [
      {
        subjectId: 'sub-owner',
        role: 'owner',
        displayName: 'Pat Owner',
        email: 'pat@example.com',
        initials: 'PO',
        grantedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        subjectId: 'sub-editor',
        role: 'editor',
        displayName: 'Ed Ivor',
        email: 'ed@example.com',
        initials: 'EI',
        grantedAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    invites: [
      {
        inviteId: 'inv-1',
        email: 'pending@example.com',
        role: 'viewer',
        createdAt: '2026-03-01T00:00:00.000Z',
        expiresAt: '2026-03-08T00:00:00.000Z',
      },
    ],
    ...overrides,
  }
}


function mount(path = '/library/col-1/collaborators') {
  mountTree(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library/:id/collaborators" element={<Collaborators />} />
          <Route path="/library" element={<h1>Library</h1>} />
        </Routes>
        <Link to="/library/col-b/collaborators" data-testid="switch-collection">switch</Link>
      </MemoryRouter>,
    )
}

function setControlValue(control: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('native value setter unavailable')
  act(() => {
    setter.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the page lists live members, invites with the policy etag,
 *    keeps the caller's abilities honest (no Remove for a viewer, Leave
 *    when `canLeave`), reverts an optimistic role change on failure, drops a
 *    late response for the previous collection, and renders avatar images from
 *    the API rather than seed data. Driven through the real page with the
 *    Product client mocked.
 *
 * 2. Architecture — the *absence* of the legacy collaborator seed data
 *    (`collaboratorsSeed` / `collaboratorActivity`, the invented people) and of
 *    a private transport import. Unused seed data changes nothing a render can
 *    observe, and the reachable half of the same claim (the DOM carrying no
 *    seed names) is asserted behaviourally below.
 */
describe('Collaborators page behaviour', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.__KNOWN_FLAGS__ = { collaborators: true }
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.listCollectionMembers.mockResolvedValue(membersPage())
    mocks.inviteCollectionMember.mockResolvedValue({
      inviteId: 'inv-new',
      collectionId: 'col-1',
      role: 'editor',
      expiresAt: '2026-08-26T00:00:00.000Z',
      policyEtag: '"p-col-1-2"',
    })
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })


  it('renders a member avatar image when avatarUrl is present', async () => {
    mocks.listCollectionMembers.mockResolvedValue(membersPage({
      members: [
        {
          subjectId: 'sub-owner',
          role: 'owner',
          displayName: 'Pat Owner',
          email: 'pat@example.com',
          initials: 'PO',
          avatarUrl: 'https://cdn.example.test/pat.png',
          grantedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      invites: [],
    }))
    mount()
    await waitForDom(domFinishedLoading)
    const image = document.querySelector<HTMLImageElement>('article span[aria-hidden] img')
    expect(image?.getAttribute('src')).toBe('https://cdn.example.test/pat.png')
    expect(document.querySelector('article span[aria-hidden]')?.textContent).not.toContain('PO')
  })

  it('falls back to initials when a member has no avatarUrl', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const owner = [...document.querySelectorAll('article')]
      .find((row) => row.textContent?.includes('Pat Owner'))
    expect(owner?.querySelector('img')).toBeNull()
    expect(owner?.querySelector('span[aria-hidden]')?.textContent).toBe('PO')
  })

  it('posts invite body {email, role} with If-Match policyEtag and toasts the UI role label', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    setControlValue(document.getElementById('invite-email') as HTMLInputElement, 'new@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')?.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.inviteCollectionMember).toHaveBeenCalledWith(
      'col-1',
      { email: 'new@example.com', role: 'editor' },
      '"p-col-1"',
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    expect(mocks.success).toHaveBeenCalledWith('Invitation sent as Editor')
    expect(mocks.success.mock.calls.flat().join(' ')).not.toMatch(/email sent to registered user/i)
  })

  it('does not call the client for empty or illegal email', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')?.requestSubmit()
      await Promise.resolve()
    })
    setControlValue(document.getElementById('invite-email') as HTMLInputElement, 'not-an-email')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')?.requestSubmit()
      await Promise.resolve()
    })
    expect(mocks.inviteCollectionMember).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    const alert = document.getElementById('collab-email-error')
    expect(alert?.textContent).toBe('Enter a valid email address')
    expect(alert?.getAttribute('role')).toBe('alert')
    const input = document.getElementById('invite-email')
    expect(input?.getAttribute('aria-invalid')).toBe('true')
    expect(input?.getAttribute('aria-describedby')).toBe('collab-email-error')
  })

  it('toasts the already-has-access error on invite 409', async () => {
    mocks.inviteCollectionMember.mockRejectedValueOnce(new ProductApiError({
      status: 409,
      code: 'mutation_conflict',
      message: 'This person already has access',
    }))
    mount()
    await waitForDom(domFinishedLoading)
    setControlValue(document.getElementById('invite-email') as HTMLInputElement, 'ed@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')?.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.error).toHaveBeenCalledWith(expect.stringMatching(/already has access/i))
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('toasts the pending-invite error on invite 409 mutation_conflict', async () => {
    mocks.inviteCollectionMember.mockRejectedValueOnce(new ProductApiError({
      status: 409,
      code: 'mutation_conflict',
      message: 'An invitation is already pending',
    }))
    mount()
    await waitForDom(domFinishedLoading)
    setControlValue(document.getElementById('invite-email') as HTMLInputElement, 'pending@example.com')
    await act(async () => {
      document.querySelector<HTMLFormElement>('form')?.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.error).toHaveBeenCalledWith('An invitation is already pending')
    expect(mocks.success).not.toHaveBeenCalled()
  })

  it('hides the invite form when the caller cannot manage', async () => {
    mocks.listCollectionMembers.mockResolvedValue(membersPage({
      caller: { subjectId: 'sub-editor', role: 'editor', canManage: false, canLeave: true },
    }))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('form')).toBeNull()
  })

  it('does not let a viewer Remove other people', async () => {
    mocks.listCollectionMembers.mockResolvedValue(membersPage({
      caller: { subjectId: 'sub-viewer', role: 'viewer', canManage: false, canLeave: false },
      members: [
        ...membersPage().members,
        {
          subjectId: 'sub-viewer',
          role: 'viewer',
          displayName: 'Vie Wer',
          email: 'vie@example.com',
          initials: 'VW',
          grantedAt: '2026-04-01T00:00:00.000Z',
        },
      ],
    }))
    mount()
    await waitForDom(domFinishedLoading)
    expect([...document.querySelectorAll('button')]
      .filter((button) => button.textContent?.trim() === 'Remove')).toHaveLength(0)
  })

  it('lets the caller leave when canLeave is true', async () => {
    mocks.listCollectionMembers.mockResolvedValue(membersPage({
      caller: { subjectId: 'sub-editor', role: 'editor', canManage: false, canLeave: true },
    }))
    mocks.removeCollectionMember.mockResolvedValueOnce(undefined)
    mount()
    await waitForDom(domFinishedLoading)
    const selfRow = [...document.querySelectorAll('article')]
      .find((row) => row.textContent?.includes('Ed Ivor'))
    expect(selfRow).toBeDefined()
    expect([...(selfRow?.querySelectorAll('button') ?? [])]
      .some((button) => button.textContent?.trim() === 'Remove')).toBe(false)
    act(() => {
      [...(selfRow?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent?.trim() === 'Leave collection')
        ?.click()
    })
    await waitForDom(() => modalButton('Leave') !== undefined)
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain('Leave this collection?')
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain("You'll lose access.")
    await act(async () => {
      modalButton('Leave')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => mocks.removeCollectionMember.mock.calls.length > 0)
    expect(mocks.removeCollectionMember).toHaveBeenCalledWith(
      'col-1',
      'sub-editor',
      '"p-col-1"',
      expect.objectContaining({ intentId: expect.any(String) }),
    )
    expect(mocks.toast).toHaveBeenCalledWith('You left the collection')
    expect(mocks.toast).not.toHaveBeenCalledWith('Collaborator removed')
    expect(document.querySelector('h1')?.textContent).toBe('Library')
    expect(document.body.textContent).not.toContain('Pat Owner')
  })

  it('names the member in the shared remove confirmation and returns focus to the row', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const edRow = [...document.querySelectorAll('article')]
      .find((row) => row.textContent?.includes('Ed Ivor'))
    const trigger = [...(edRow?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Remove')
    expect(trigger?.getAttribute('aria-label')).toBe('Remove Ed Ivor')
    act(() => {
      trigger?.click()
    })
    await waitForDom(() => modalButton('Cancel') !== undefined)
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain("Remove Ed Ivor's access?")
    // The shared modal orders Cancel before the red action.
    expect([...document.querySelectorAll('[data-testid="modal-panel"] .empty-state-actions button')].map((button) => button.textContent))
      .toEqual(['Cancel', 'Remove'])
    await act(async () => {
      modalButton('Cancel')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') === null)
    expect(mocks.removeCollectionMember).not.toHaveBeenCalled()
    await waitForDom(() => document.activeElement === trigger)
  })

  it('says Cancel invitation for pending invites and returns focus to the row', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const inviteRow = [...document.querySelectorAll('article')]
      .find((row) => row.textContent?.includes('pending@example.com'))
    expect([...(inviteRow?.querySelectorAll('button') ?? [])]
      .some((button) => button.textContent?.trim() === 'Remove')).toBe(false)
    const trigger = [...(inviteRow?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Cancel invitation')
    expect(trigger?.getAttribute('aria-label')).toBe('Cancel invitation for pending@example.com')
    act(() => {
      trigger?.click()
    })
    await waitForDom(() => modalButton('Keep') !== undefined)
    expect(document.querySelector('[data-testid="modal-panel"]')?.textContent).toContain('Cancel the invitation for pending@example.com?')
    await act(async () => {
      modalButton('Keep')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await waitForDom(() => document.querySelector('[data-testid="modal-panel"]') === null)
    await waitForDom(() => document.activeElement === trigger)
  })

  it('does not paint a late members response for the previous collection id', async () => {
    const first = deferred<MembersPage>()
    const second = deferred<MembersPage>()
    mocks.listCollectionMembers.mockImplementation((id: string) => {
      if (id === 'col-a') return first.promise
      if (id === 'col-b') return second.promise
      return Promise.resolve(membersPage())
    })
    mount('/library/col-a/collaborators')
    await waitForDom(() => document.querySelector('[data-testid="switch-collection"]') !== null)
    const firstSignal = mocks.listCollectionMembers.mock.calls[0]?.[1]?.signal as AbortSignal | undefined
    expect(firstSignal).toBeInstanceOf(AbortSignal)

    act(() => {
      document.querySelector<HTMLAnchorElement>('[data-testid="switch-collection"]')?.click()
    })
    await settled()
    expect(firstSignal?.aborted).toBe(true)
    expect(mocks.listCollectionMembers).toHaveBeenCalledWith('col-b', expect.anything())

    await act(async () => first.resolve(membersPage({
      collection: { id: 'col-a', title: 'Alpha Shelf' },
    })))
    await settled()
    expect(document.body.textContent).not.toContain('Alpha Shelf')

    await act(async () => second.resolve(membersPage({
      collection: { id: 'col-b', title: 'Beta Shelf' },
    })))
    await waitForDom(() => document.body.textContent?.includes('Beta Shelf') === true)
    expect(document.body.textContent).toContain('Beta Shelf')
    expect(document.body.textContent).not.toContain('Alpha Shelf')
  })

  it('maps 403 to the forbidden RouteState and 404 to not found, neither with Retry', async () => {
    mocks.listCollectionMembers.mockRejectedValue(new ProductApiError({
      status: 403, code: 'insufficient_permission', message: 'no access',
    }))
    mount()
    await waitForDom(() => document.body.textContent?.includes('Collaborators are not available') === true)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Collaborators are not available')
    expect(document.body.textContent).not.toContain('Retry')
    cleanup()
    document.body.innerHTML = '<div id="root"></div>'
    clearRouteCache()

    mocks.listCollectionMembers.mockRejectedValue(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'gone',
    }))
    mount()
    await waitForDom(() => document.body.textContent?.includes('Collection not found') === true)
    expect(document.body.textContent).not.toContain('Retry')
  })

  it('renders live members without seed names, Commenter invite options, or delivery copy', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const title = document.querySelector('h1')
    expect(title?.textContent).toBe('Collaborators')
    expect(title?.previousElementSibling?.getAttribute('aria-label')).toBe('Breadcrumb')
    expect(document.body.textContent).not.toContain('Work together without losing provenance')
    expect(document.body.textContent).toContain('Research Shelf')
    expect(document.body.textContent).toContain('Pat Owner')
    expect(document.body.textContent).toContain(`Joined ${formatDate('2026-01-01T00:00:00.000Z')}`)
    expect(document.body.textContent).toContain(`Invite sent ${formatDate('2026-03-01T00:00:00.000Z')}`)
    expect(document.body.textContent).toContain(`Expires ${formatDate('2026-03-08T00:00:00.000Z')}`)
    expect(document.body.textContent).not.toContain('No recent activity')
    expect(document.querySelector('[data-testid="collab-activity"]')).toBeNull()
    expect(document.querySelector('[data-testid="collab-owner"]')?.textContent).toBe('Owner')
    expect(document.body.textContent).not.toContain('Alex Chen')
    expect(document.body.textContent).not.toContain('mira@known.dev')
    expect(document.body.textContent).not.toContain('collaboratorsSeed')
    const inviteOptions = [...document.querySelectorAll('[data-testid="invite-role"] [role="radio"]')].map((option) => option.textContent)
    expect(inviteOptions).toEqual(['Editor', 'Viewer'])
    expect(inviteOptions).not.toContain('Commenter')
    const guide = document.querySelector('[data-testid="collab-permissions"]')
    expect(guide?.textContent).not.toContain('Commenter')
    expect(guide?.querySelector(':scope > div')).toBeNull()
    const matrix = guide?.querySelector('table')
    expect(matrix?.classList.contains('collab-matrix')).toBe(true)
    expect(matrix?.querySelector('caption')?.textContent).toBe('What each role can do')
    const headers = [...matrix?.querySelectorAll('thead th') ?? []]
    expect(headers.map((cell) => cell.textContent)).toEqual(['Role', 'Edit', 'View'])
    expect(headers.map((cell) => cell.textContent)).not.toContain('Owner')
    expect(headers.every((cell) => cell.getAttribute('scope') === 'col')).toBe(true)
    expect([...matrix?.querySelectorAll('tbody tr') ?? []].map((row) => [
      row.querySelector('th')?.textContent,
      row.querySelector('th')?.getAttribute('scope'),
      ...[...row.querySelectorAll('td')].map((cell) => cell.textContent),
    ])).toEqual([
      ['Editor', 'row', 'Allowed', 'Allowed'],
      ['Viewer', 'row', 'Not allowed', 'Allowed'],
    ])
    const icons = [...matrix?.querySelectorAll('svg') ?? []]
    expect(icons).toHaveLength(3)
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true)
    expect(document.body.textContent).not.toContain('transfer ownership')
    expect(document.querySelector('[data-testid="invite-role"]')?.classList.contains('view-switch')).toBe(true)
    expect(guide?.textContent).not.toContain('✓')
    expect(document.querySelector('select')).toBeNull()
    expect(document.body.textContent).not.toMatch(/email sent to registered user/i)
    expect(document.body.textContent).not.toMatch(/delivery status|delivered|mailbox/i)
    expect(document.querySelector('a[href="/library/col-1/history"]')?.textContent).toContain('Version history')
    expect(document.querySelector('nav[aria-label="Breadcrumb"] a[href="/library"]')).not.toBeNull()
    expect(document.querySelector('nav[aria-label="Breadcrumb"] a[href="/library/col-1"]')).not.toBeNull()
    expect([...document.querySelectorAll('a')].some((link) => link.textContent?.includes('Back to library'))).toBe(false)
    expect([...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Send invitation')?.classList.contains('btn-primary')).toBe(true)
  })

  it('optimistically updates a member role and reverts when the request fails', async () => {
    const pending = deferred<{ policyEtag: string; role: 'viewer' }>()
    mocks.updateCollectionMemberRole.mockReturnValueOnce(pending.promise)
    mount()
    await waitForDom(domFinishedLoading)
    const group = document.querySelector('[aria-label="Role for Ed Ivor"]')!
    const radios = () => [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const radio = (name: string) => radios().find((button) => button.textContent === name)!
    expect(radio('Editor').getAttribute('aria-checked')).toBe('true')
    act(() => {
      radio('Viewer').click()
    })
    expect(radio('Viewer').getAttribute('aria-disabled')).toBe('true')
    expect(radio('Viewer').getAttribute('aria-checked')).toBe('true')
    await act(async () => {
      pending.reject(new ProductApiError({
        status: 503,
        code: 'unavailable',
        message: 'down',
        recovery: 'user_action',
      }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(radio('Editor').getAttribute('aria-checked')).toBe('true')
    expect(radio('Viewer').disabled).toBe(false)
    expect(mocks.error).toHaveBeenCalled()
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps production exposure live, seed data out, and the Product client on the shared barrel', () => {
    /* Runtime half: the compiled exposure switch really is on. */
    expect(FEATURE_FLAGS.collaborators).toBe(true)
    /* Unreachable half: `collaboratorsSeed` / `collaboratorActivity` and the
       invented people were removed with the seed UI. Their return is
       invisible while the branch that reads them is not taken, and the
       behaviour test above only proves the *rendered* half of the same claim.
       `AvatarImage` / `member.avatarUrl` used to be pinned here by name; the
       avatar test now proves the rendering behaviourally, which is strictly
       stronger, so only the module boundary is kept by name: the page must
       reach Product HTTP through `../api` and never a private transport. */
    expect(collaboratorsSource.length).toBeGreaterThan(12_000)
    expect(collaboratorsSource).not.toMatch(/collaboratorsSeed/)
    expect(collaboratorsSource).not.toMatch(/collaboratorActivity/)
    expect(collaboratorsSource).not.toMatch(/Alex Chen/)
    expect(collaboratorsSource).not.toMatch(/mira@known\.dev/)
    expect(collaboratorsSource).not.toMatch(/legacy-demo/)
    expect(collaboratorsSource).toMatch(/from '\.\.\/api'/)
    expect(collaboratorsSource).not.toMatch(/from ['"][^'"]*product-transport['"]/)
  })
})
