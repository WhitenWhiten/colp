// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { ModerationAppeals } from './ModerationAppeals'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  listMyModerationAppeals: vi.fn(),
  listActionsAffectingMe: vi.fn(),
  createModerationAppeal: vi.fn(),
  isLoggedIn: true,
  isLive: true,
}))

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  isLive: () => mocks.isLive,
  productClient: {
    listMyModerationAppeals: (...args: unknown[]) => mocks.listMyModerationAppeals(...args),
    listActionsAffectingMe: (...args: unknown[]) => mocks.listActionsAffectingMe(...args),
    createModerationAppeal: (...args: unknown[]) => mocks.createModerationAppeal(...args),
    mutationIntentKey: () => 'intent',
    newCommandId: () => '11111111-1111-4111-8111-111111111111',
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mocks.isLoggedIn }),
}))

describe('content-governance my appeals page', () => {
  beforeEach(() => {
    mocks.listMyModerationAppeals.mockReset()
    mocks.listActionsAffectingMe.mockReset()
    mocks.createModerationAppeal.mockReset()
    mocks.isLoggedIn = true
    mocks.isLive = true
    mocks.listActionsAffectingMe.mockResolvedValue({
      items: [{
        id: 'act_1',
        target: { kind: 'collection', id: 'col_1' },
        action: 'hide_public',
        reason: 'spam network',
        state: 'active',
        revision: '1',
        createdAt: '2026-09-16T00:00:00.000Z',
        revokedAt: null,
        revokeReason: null,
      }],
      nextCursor: null,
    })
    mocks.listMyModerationAppeals.mockResolvedValue({
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

  it('lists own appeals', async () => {
    mountTree(
      <MemoryRouter>
        <ModerationAppeals />
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="moderation-appeal-list"]') !== null)
    expect(document.body.textContent).toContain('please restore')
    expect(document.body.textContent).toContain('Submitted')
    const select = document.querySelector('[data-testid="moderation-appeal-action"]') as HTMLSelectElement
    expect(select.value).toBe('act_1')
    expect(select.textContent).toContain('Hidden from the public · Collection col_1')
  })

  it('keeps the form and shows an inline error when submit fails', async () => {
    mocks.createModerationAppeal.mockRejectedValueOnce(new ProductApiError({
      status: 400,
      code: 'invalid_document',
      message: 'Appeal could not be submitted',
    }))
    mountTree(
      <MemoryRouter>
        <ModerationAppeals />
      </MemoryRouter>,
    )
    await waitForDom(() => document.querySelector('[data-testid="moderation-appeal-form"]') !== null)
    const description = document.querySelector<HTMLTextAreaElement>('#moderation-appeal-description')
    expect(description).toBeTruthy()
    await act(async () => {
      description!.value = 'please restore'
      description!.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-testid="moderation-appeal-form"]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    await waitForDom(() => document.querySelector('[role="alert"]') !== null)
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toBe('Appeal could not be submitted')
    expect(document.querySelector('[data-testid="moderation-appeal-form"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="moderation-appeal-list"]')).toBeTruthy()
  })

  it('sends signed-out visitors to login with returnTo', () => {
    mocks.isLoggedIn = false
    mountTree(
      <MemoryRouter>
        <ModerationAppeals />
      </MemoryRouter>,
    )
    expect(document.body.textContent).toContain('Sign in to continue')
    expect(document.querySelector('a[href="/login?returnTo=%2Fmoderation%2Fappeals"]')?.textContent).toBe('Sign in')
    expect(document.querySelector('[data-testid="moderation-appeal-form"]')).toBeNull()
    expect(mocks.listMyModerationAppeals).not.toHaveBeenCalled()
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
    expect(mocks.listMyModerationAppeals).not.toHaveBeenCalled()
  })

})
