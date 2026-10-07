// @vitest-environment happy-dom
import { act, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrivacySection } from './PrivacySection'
import { ProductApiError } from '../../api'
import { cleanup, mountTree, settled } from '../../test/render'

const mocks = vi.hoisted(() => ({
  getMyCatalogPreferences: vi.fn(),
  updateMyCatalogPreferences: vi.fn(),
  isLoggedIn: true,
  accountId: 'acct-1',
}))

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return {
    ...actual,
    isLive: (flag: string) => flag === 'contentGovernance' || actual.isLive(flag as never),
    productClient: {
      ...actual.productClient,
      getMyCatalogPreferences: mocks.getMyCatalogPreferences,
      updateMyCatalogPreferences: mocks.updateMyCatalogPreferences,
      mutationIntentKey: actual.productClient.mutationIntentKey,
      newCommandId: actual.productClient.newCommandId,
    },
  }
})

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isLoggedIn: mocks.isLoggedIn,
    user: mocks.isLoggedIn ? { accountId: mocks.accountId } : null,
  }),
}))

vi.mock('../AppToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

/** Switches the mocked signed-in account to acct-2 on click. */
function AccountSwitchProbe() {
  const [, setTick] = useState(0)
  return (
    <>
      <button
        type="button"
        data-testid="switch-account"
        onClick={() => {
          mocks.accountId = 'acct-2'
          setTick((value) => value + 1)
        }}
      />
      <PrivacySection />
    </>
  )
}

function fieldValue(id: string): string | undefined {
  return (document.getElementById(id) as HTMLTextAreaElement | null)?.value
}

describe('PrivacySection catalog preferences', () => {
  afterEach(() => {
    cleanup()
    mocks.getMyCatalogPreferences.mockReset()
    mocks.updateMyCatalogPreferences.mockReset()
    mocks.isLoggedIn = true
    mocks.accountId = 'acct-1'
  })

  it('loads and saves personal catalog filters', async () => {
    mocks.getMyCatalogPreferences.mockResolvedValue({
      hiddenOwnerAccountIds: ['acct-1'],
      hiddenTags: ['spam'],
      hiddenTitleKeywords: ['clickbait'],
      preferredLanguages: ['en'],
      revision: '2',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    mocks.updateMyCatalogPreferences.mockResolvedValue({
      hiddenOwnerAccountIds: [],
      hiddenTags: [],
      hiddenTitleKeywords: [],
      preferredLanguages: ['en'],
      revision: '3',
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    mountTree(
      <MemoryRouter>
        <PrivacySection />
      </MemoryRouter>,
    )
    await settled()
    const owners = document.getElementById('pref-owners') as HTMLTextAreaElement
    expect(owners.value).toContain('acct-1')
    owners.value = ''
    owners.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('[data-testid="catalog-preferences-form"]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settled()
    expect(mocks.updateMyCatalogPreferences).toHaveBeenCalled()
  })

  it('reloads catalog preferences when the signed-in account changes', async () => {
    // The endpoint answers for the signed-in account (the session is its input,
    // not a call-order queue), so both StrictMode mount attempts read acct-1
    // and the switch to acct-2 is what surfaces 'second'.
    const preferencesByAccount: Record<string, {
      hiddenOwnerAccountIds: string[]
      hiddenTags: string[]
      hiddenTitleKeywords: string[]
      preferredLanguages: string[]
      revision: string
      updatedAt: string
    }> = {
      'acct-1': {
        hiddenOwnerAccountIds: [],
        hiddenTags: ['first'],
        hiddenTitleKeywords: [],
        preferredLanguages: [],
        revision: '2',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      'acct-2': {
        hiddenOwnerAccountIds: [],
        hiddenTags: ['second'],
        hiddenTitleKeywords: [],
        preferredLanguages: [],
        revision: '2',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }
    mocks.getMyCatalogPreferences.mockImplementation(() =>
      Promise.resolve(preferencesByAccount[mocks.accountId]))
    mountTree(
      <MemoryRouter>
        <AccountSwitchProbe />
      </MemoryRouter>,
    )
    await settled()
    expect(fieldValue('pref-tags')).toContain('first')
    act(() => {
      document.querySelector('[data-testid="switch-account"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await settled()
    expect(fieldValue('pref-tags')).toContain('second')
  })

  it('clears the previous account filters when the next account load fails', async () => {
    mocks.getMyCatalogPreferences.mockImplementation(() => (
      mocks.accountId === 'acct-1'
        ? Promise.resolve({
            hiddenOwnerAccountIds: ['acct-1'],
            hiddenTags: ['from-a'],
            hiddenTitleKeywords: ['a-keyword'],
            preferredLanguages: ['en'],
            revision: '2',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })
        : Promise.reject(new ProductApiError({ status: 500, code: 'internal_error', message: 'boom' }))
    ))
    mountTree(
      <MemoryRouter>
        <AccountSwitchProbe />
      </MemoryRouter>,
    )
    await settled()
    expect(fieldValue('pref-tags')).toBe('from-a')
    act(() => {
      document.querySelector('[data-testid="switch-account"]')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await settled()
    expect(['pref-owners', 'pref-tags', 'pref-keywords', 'pref-languages'].map((id) => fieldValue(id)))
      .toEqual(['', '', '', ''])
  })
})
