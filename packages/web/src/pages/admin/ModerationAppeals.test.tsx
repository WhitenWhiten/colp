// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../../api/errors'
import { ModerationAppeals } from './ModerationAppeals'
import { cleanup, mountTree, waitForDom } from '../../test/render'

const mocks = vi.hoisted(() => ({
  listModerationAppeals: vi.fn(),
  decideModerationAppeal: vi.fn(),
  isLoggedIn: true,
  isLive: true,
}))

vi.mock('../../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api')>(),
  isLive: () => mocks.isLive,
  productClient: {
    listModerationAppeals: (...args: unknown[]) => mocks.listModerationAppeals(...args),
    decideModerationAppeal: (...args: unknown[]) => mocks.decideModerationAppeal(...args),
    mutationIntentKey: () => 'intent',
    newCommandId: () => '11111111-1111-4111-8111-111111111111',
  },
}))

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mocks.isLoggedIn }),
}))

describe('content-governance admin appeals page', () => {
  beforeEach(() => {
    mocks.listModerationAppeals.mockReset()
    mocks.decideModerationAppeal.mockReset()
    mocks.isLoggedIn = true
    mocks.isLive = true
    mocks.listModerationAppeals.mockResolvedValue({
      items: [{
        id: 'apl_1',
        actionId: 'act_1',
        description: 'please restore',
        status: 'submitted',
        resolution: null,
        revision: '1',
        createdAt: '2026-09-16T00:00:00.000Z',
        updatedAt: '2026-09-16T00:00:00.000Z',
      }],
      nextCursor: null,
    })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
  })

  it('lists official appeals for server-checked roles', async () => {
    mountTree(
      <MemoryRouter>
        <ModerationAppeals />
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="admin-moderation-appeal-list"]') !== null)
    expect(document.body.textContent).toContain('please restore')
    expect(document.body.textContent).toContain('Submitted')
  })

  it('treats a server 403 as missing official access', async () => {
    mocks.listModerationAppeals.mockRejectedValue(new ProductApiError({
      status: 403,
      code: 'insufficient_permission',
      message: 'You do not have permission to perform this action.',
    }))
    mountTree(
      <MemoryRouter>
        <ModerationAppeals />
      </MemoryRouter>,
    )
    await waitForDom(() => document.body.textContent?.includes('Official reviewer access is required.') === true)
    expect(document.querySelector('[data-testid="admin-moderation-appeal-list"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Official reviewer access is required.')
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(false)
  })
  it('shows the feature as unavailable while the governance flag is off', () => {
    mocks.isLive = false
    mountTree(
      <MemoryRouter>
        <ModerationAppeals />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Moderation appeals are not available yet')
    expect(document.body.textContent).toContain('It will appear here when it is ready.')
    expect(mocks.listModerationAppeals).not.toHaveBeenCalled()
  })

})
