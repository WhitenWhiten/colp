// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { ModerationCases } from './ModerationCases'
import { cleanup, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  listModerationCases: vi.fn(),
  isLoggedIn: true,
  isLive: true,
}))

vi.mock('../../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api')>(),
  isLive: () => mocks.isLive,
  productClient: {
    listModerationCases: (...args: unknown[]) => mocks.listModerationCases(...args),
  },
}))

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mocks.isLoggedIn }),
}))

describe('content-governance admin cases page', () => {
  beforeEach(() => {
    mocks.listModerationCases.mockReset()
    mocks.isLoggedIn = true
    mocks.isLive = true
    mocks.listModerationCases.mockResolvedValue({
      items: [{
        case: {
          id: 'case_1',
          target: { kind: 'collection', id: 'col_1' },
          category: 'spam',
          status: 'submitted',
          publicResolution: null,
          revision: '1',
          createdAt: '2026-09-15T00:00:00.000Z',
          updatedAt: '2026-09-15T00:00:00.000Z',
        },
        reporterAccountId: 'acc_1',
        description: 'spam',
        assignedToAccountId: null,
        evidenceIds: [],
        actionIds: [],
        internalNote: null,
      }],
      nextCursor: null,
    })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lists official cases for server-checked roles', async () => {
    mountTree(
      <MemoryRouter>
        <ModerationCases />
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-case-list"]') !== null)
    const [subject, reason, status] = document.querySelectorAll('[data-testid="admin-moderation-case-list"] [role="cell"]')
    expect(subject?.querySelector('strong')?.textContent).toBe('Collection')
    expect(subject?.querySelector('a')?.getAttribute('href')).toBe('/admin/moderation/cases/case_1')
    expect(subject?.querySelector('span')?.textContent).toContain('col_1')
    expect(reason?.querySelector('strong')?.textContent).toBe('Spam')
    expect(status?.textContent).toBe('Submitted')
    expect(document.body.textContent).toContain('Reports that need an official decision. Actions are checked on the server.')
    expect(document.body.textContent).not.toContain('Hide buttons are not authorization')
  })

  it('treats a server 403 as missing official access, not a local hide button', async () => {
    mocks.listModerationCases.mockRejectedValue(new ProductApiError({
      status: 403,
      code: 'insufficient_permission',
      message: 'You do not have permission to perform this action.',
    }))
    mountTree(
      <MemoryRouter>
        <ModerationCases />
      </MemoryRouter>,
    )
    await waitForDom(() => document.body.textContent?.includes('Official reviewer access is required.') === true)
    expect(document.querySelector('[data-testid="admin-moderation-case-list"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Official reviewer access is required.')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(false)
    expect(document.body.textContent).not.toContain('Sign in to continue')
  })

  it('sends signed-out visitors to login with returnTo', () => {
    mocks.isLoggedIn = false
    mountTree(
      <MemoryRouter>
        <ModerationCases />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Sign in to continue')
    expect(document.querySelector('a[href="/login?returnTo=%2Fadmin%2Fmoderation%2Fcases"]')?.textContent).toBe('Sign in')
    expect(mocks.listModerationCases).not.toHaveBeenCalled()
  })
  it('shows the feature as unavailable while the governance flag is off', () => {
    mocks.isLive = false
    mountTree(
      <MemoryRouter>
        <ModerationCases />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Moderation cases are not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(mocks.listModerationCases).not.toHaveBeenCalled()
  })

})
