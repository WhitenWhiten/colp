// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { SavedResourceView } from '../api/types'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import { useSavedResource, useSavedResources } from './useSavedResource'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), unsave: vi.fn(), abandon: vi.fn(), sequence: 0 }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient,
    loadSavedResources: mocks.load, saveResource: mocks.save, unsaveResource: mocks.unsave,
    abandonSavedResourceIntent: mocks.abandon, newCommandId: () => `command-${++mocks.sequence}`,
    mutationIntentKey: (scope: string, id: string) => `${scope}:${id}`,
  } }
})

function Harness() {
  const saved = useSavedResource({ resourceType: 'node', resourceId: 'node-1' })
  return <><button data-state={saved.state} aria-pressed={saved.saved} disabled={saved.pending} onClick={saved.toggle}>{saved.label}</button>{saved.state === 'unknown' && <button onClick={saved.retry}>Retry</button>}<button onClick={saved.reload}>Reload</button></>
}
function ListHarness() {
  const saved = useSavedResources()
  return <div data-testid="list" data-state={saved.state}>{saved.items.map((item) => item.resourceId).join(',')}</div>
}
const savedItem = (resourceId: string): SavedResourceView => ({
  resourceType: 'node', resourceId, savedAt: '2026-07-25T00:00:00Z',
  target: { availability: 'available', collectionId: 'collection-1', title: resourceId, url: null },
})
/** StrictMode mounts every effect twice and its own cleanup aborts the first
    read, so only one read per mount stays live. Counting live reads asserts
    "one outstanding read for the current identity" without encoding how many
    times React happened to invoke the effect. */
function liveReads(): number {
  return mocks.load.mock.calls.filter((call) => !(call[1]?.signal as AbortSignal).aborted).length
}
describe('Saved Resource optimistic state', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.sequence = 0; document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' })
    applyMeView({ account: { id: 'account-a', email: 'a@test' }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } })
    mocks.load.mockResolvedValue([]); mocks.save.mockResolvedValue({}); mocks.unsave.mockResolvedValue({})
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })
  function render() { mountTree(<Harness />) }
  function renderList() { mountTree(<ListHarness />) }

  it('optimistically saves, disables duplicate clicks, and creates reverse intent only after success', async () => {
    let finish: (() => void) | undefined
    mocks.save.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    render(); await waitForDom(domFinishedLoading); const button = document.querySelector('button')!
    act(() => { button.click(); button.click() })
    expect(button.getAttribute('aria-pressed')).toBe('true'); expect(button.disabled).toBe(true); expect(mocks.save).toHaveBeenCalledTimes(1)
    await act(async () => { finish?.(); await Promise.resolve() }); act(() => button.click()); await waitForDom(domFinishedLoading)
    expect(mocks.unsave).toHaveBeenCalledTimes(1)
    expect(mocks.unsave.mock.calls[0]![2].intentId).not.toBe(mocks.save.mock.calls[0]![2].intentId)
  })

  it('keeps the optimistic state and command for unknown replay, then rolls back a definite failure', async () => {
    mocks.save
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'lost', recovery: 'same_request', sameRequestRetrySafe: true }))
      .mockRejectedValueOnce(new ProductApiError({ status: 409, code: 'command_id_reused', message: 'reuse', recovery: 'same_request', sameRequestRetrySafe: true }))
      .mockRejectedValueOnce(new ProductApiError({ status: 403, code: 'insufficient_permission', message: 'denied', recovery: 'user_action', sameRequestRetrySafe: false }))
    render(); await waitForDom(domFinishedLoading); const button = document.querySelector('button')!
    act(() => button.click()); await waitForDom(domFinishedLoading); expect(button.dataset.state).toBe('unknown'); expect(button.getAttribute('aria-pressed')).toBe('true'); expect(button.disabled).toBe(true)
    act(() => ([...document.querySelectorAll('button')][1] as HTMLButtonElement).click()); await waitForDom(domFinishedLoading); expect(mocks.save.mock.calls[1]![2].intentId).toBe(mocks.save.mock.calls[0]![2].intentId)
    act(() => ([...document.querySelectorAll('button')][1] as HTMLButtonElement).click()); await waitForDom(domFinishedLoading); expect(button.dataset.state).toBe('error'); expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('aborts reads on unmount and partitions private cache by account/session epoch', async () => {
    let firstSignal: AbortSignal | undefined
    mocks.load.mockImplementation((_query, options) => { firstSignal = options.signal; return new Promise(() => {}) })
    render(); await settled(); cleanup(); expect(firstSignal?.aborted).toBe(true)
    act(() => applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } }))
    mocks.load.mockResolvedValue([]); render(); await waitForDom(domFinishedLoading)
    /* One live read for account-b, and no further reads while nothing changes. */
    expect(liveReads()).toBe(1)
    const readsForAccountB = mocks.load.mock.calls.length
    await settled()
    expect(mocks.load.mock.calls.length).toBe(readsForAccountB)
    act(() => applySessionView({ authenticated: true, csrfToken: 'rotated-csrf', idleExpiresAt: '2026-07-25T02:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z' }))
    await waitForDom(domFinishedLoading)
    /* A rotated session epoch is a new private identity: exactly one more read. */
    expect(mocks.load.mock.calls.length).toBe(readsForAccountB + 1)
    act(() => clearSession())
    await waitForDom(domFinishedLoading); expect(document.querySelector('button')?.getAttribute('aria-pressed')).toBe('false')
    expect(sessionStorage.getItem('known.saved')).toBeNull()
  })

  it('aborts an in-flight private mutation and reloads when the account changes', async () => {
    let mutationSignal: AbortSignal | undefined
    mocks.save.mockImplementation((_type, _id, options) => {
      mutationSignal = options.signal
      return new Promise(() => {})
    })
    render(); await waitForDom(domFinishedLoading)
    const readsBeforeAccountChange = mocks.load.mock.calls.length
    act(() => document.querySelector('button')!.click())
    expect(document.querySelector('button')!.getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } })
      await Promise.resolve(); await Promise.resolve()
    })
    expect(mutationSignal?.aborted).toBe(true)
    /* The identity change reloads once — not once per invocation of the effect. */
    expect(mocks.load.mock.calls.length).toBe(readsBeforeAccountChange + 1)
    expect(document.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('does not let reload invalidate an in-flight mutation', async () => {
    let finish: (() => void) | undefined
    mocks.save.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    render(); await waitForDom(domFinishedLoading)
    const readsAfterMount = mocks.load.mock.calls.length
    act(() => document.querySelector<HTMLButtonElement>('button')!.click())
    act(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === 'Reload')?.click())
    /* Reload must not start a read that would supersede the pending mutation. */
    expect(mocks.load.mock.calls.length).toBe(readsAfterMount)
    await act(async () => { finish?.(); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector<HTMLButtonElement>('button')?.dataset.state).toBe('ready')
    expect(document.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false)
  })

  it('ignores a saved-resource list that resolves after the private identity changes', async () => {
    let resolveOld: ((items: SavedResourceView[]) => void) | undefined
    /* The list endpoint answers per signed-in account: account-a's read is held
       open so it can settle after the switch, account-b answers immediately. */
    mocks.load.mockImplementation(() => {
      if ((getSessionSnapshot().me?.account.id ?? 'anonymous') === 'account-a') {
        return new Promise<SavedResourceView[]>((resolve) => { resolveOld = resolve })
      }
      return Promise.resolve([savedItem('account-b-item')])
    })
    renderList(); await settled()
    const oldSignal = mocks.load.mock.calls.at(-1)![1].signal as AbortSignal
    await act(async () => {
      applyMeView({ account: { id: 'account-b', email: 'b@test' }, profile: { id: 'profile-b', handle: 'b', displayName: 'B', avatarUrl: null } })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(oldSignal.aborted).toBe(true)
    await waitForDom(() => document.querySelector('[data-testid="list"]')?.textContent === 'account-b-item')
    expect(document.querySelector('[data-testid="list"]')?.textContent).toBe('account-b-item')
    await act(async () => { resolveOld?.([savedItem('account-a-item')]); await Promise.resolve(); await Promise.resolve() })
    expect(document.querySelector('[data-testid="list"]')?.textContent).toBe('account-b-item')
  })
})
