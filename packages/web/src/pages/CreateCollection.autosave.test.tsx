// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateCollection } from './CreateCollection'
import { cleanup, renderWithRouter } from '../test/render'
import { autoSaveDraftStorageKey, readAutoSaveDraft } from '../lib/useAutoSaveDraft'

const mocks = vi.hoisted(() => ({
  refreshSession: vi.fn(async () => undefined),
  toast: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  createCollection: vi.fn(),
  auth: {
    isLoggedIn: true,
    bootstrapping: false,
    accountId: 'account-a' as string | null,
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    isLoggedIn: mocks.auth.isLoggedIn,
    bootstrapping: mocks.auth.bootstrapping,
    user: mocks.auth.accountId === null ? null : { accountId: mocks.auth.accountId },
    refreshSession: mocks.refreshSession,
  }),
}))

vi.mock('../components/AppToast', () => ({
  useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      createCollection: mocks.createCollection,
    },
  }
})

const draftKey = (accountId: string) => autoSaveDraftStorageKey('create-collection', `account:${accountId}`)

describe('CreateCollection draft persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.auth.accountId = 'account-a'
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    localStorage.clear()
  })

  it('restores a draft and debounces the current form values after editing', async () => {
    localStorage.setItem(draftKey('account-a'), JSON.stringify({
      title: 'Restored title',
      summary: 'Restored summary',
      kind: 'reading_path',
    }))
    renderWithRouter(<CreateCollection />, { route: '/library/new' })

    const title = document.getElementById('cc-title') as HTMLInputElement
    const summary = document.getElementById('cc-summary') as HTMLTextAreaElement
    const kind = document.querySelector('[data-testid="cc-kind"]') as HTMLElement
    const readingPath = kind.querySelector('input[value="reading_path"]') as HTMLInputElement
    expect(title.value).toBe('Restored title')
    expect(summary.value).toBe('Restored summary')
    expect(readingPath.checked).toBe(true)

    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Edited title')
      title.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Edited title' }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(summary, 'Edited summary')
      summary.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Edited summary' }))
      ;(kind.querySelector('input[value="mixed"]') as HTMLInputElement).click()
    })

    await act(async () => { await vi.advanceTimersByTimeAsync(799) })
    expect(JSON.parse(localStorage.getItem(draftKey('account-a')) ?? '{}')).toMatchObject({
      title: 'Restored title', summary: 'Restored summary', kind: 'reading_path',
    })

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(JSON.parse(localStorage.getItem(draftKey('account-a')) ?? '{}')).toEqual({
      title: 'Edited title', summary: 'Edited summary', kind: 'mixed',
    })
  })

  it('rejects malformed and non-object drafts instead of breaking the form', () => {
    for (const raw of ['{', 'null', '[]', '"not a draft"']) {
      localStorage.setItem(draftKey('account-a'), raw)
      expect(readAutoSaveDraft('create-collection', 'account:account-a')).toBeNull()
    }
  })

  it('does not show one account draft to another and keeps both after sign-out', () => {
    localStorage.setItem(draftKey('account-a'), JSON.stringify({
      title: 'Alpha title', summary: 'Alpha summary', kind: 'reading_path',
    }))
    localStorage.setItem(draftKey('account-b'), JSON.stringify({
      title: 'Beta title', summary: 'Beta summary', kind: 'mixed',
    }))
    const view = renderWithRouter(<CreateCollection />, { route: '/library/new' })
    expect((document.getElementById('cc-title') as HTMLInputElement).value).toBe('Alpha title')
    expect((document.getElementById('cc-summary') as HTMLTextAreaElement).value).toBe('Alpha summary')

    mocks.auth.accountId = 'account-b'
    view.rerender(<CreateCollection />)
    expect((document.getElementById('cc-title') as HTMLInputElement).value).toBe('Beta title')
    expect((document.getElementById('cc-summary') as HTMLTextAreaElement).value).toBe('Beta summary')
    expect(document.body.textContent).not.toContain('Alpha title')
    expect(readAutoSaveDraft('create-collection', 'account:account-a')).toEqual({
      title: 'Alpha title', summary: 'Alpha summary', kind: 'reading_path',
    })

    mocks.auth.isLoggedIn = false
    mocks.auth.accountId = null
    view.rerender(<CreateCollection />)
    expect(document.getElementById('cc-title')).toBeNull()
    expect(readAutoSaveDraft('create-collection', 'account:account-a')).toEqual({
      title: 'Alpha title', summary: 'Alpha summary', kind: 'reading_path',
    })
    expect(readAutoSaveDraft('create-collection', 'account:account-b')).toEqual({
      title: 'Beta title', summary: 'Beta summary', kind: 'mixed',
    })
  })

  it('a late debounce does not write into the other partition', async () => {
    const view = renderWithRouter(<CreateCollection />, { route: '/library/new' })
    const title = document.getElementById('cc-title') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(title, 'Late alpha')
      title.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Late alpha' }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(799) })

    mocks.auth.accountId = 'account-b'
    view.rerender(<CreateCollection />)
    expect((document.getElementById('cc-title') as HTMLInputElement).value).toBe('')

    await act(async () => { await vi.advanceTimersByTimeAsync(800) })
    expect(readAutoSaveDraft('create-collection', 'account:account-a')).toEqual({
      title: 'Late alpha', summary: '', kind: 'bookmarks',
    })
    expect(readAutoSaveDraft('create-collection', 'account:account-b')).toBeNull()
    expect(readAutoSaveDraft('create-collection', 'anonymous')).toBeNull()
  })

  it('does not load a private draft before identity is known or copy an anonymous draft', () => {
    localStorage.setItem(draftKey('account-a'), JSON.stringify({
      title: 'Secret title', summary: '', kind: 'bookmarks',
    }))
    localStorage.setItem(autoSaveDraftStorageKey('create-collection', 'anonymous'), JSON.stringify({
      title: 'Anon secret', summary: '', kind: 'bookmarks',
    }))
    mocks.auth.bootstrapping = true
    const view = renderWithRouter(<CreateCollection />, { route: '/library/new' })
    expect(document.getElementById('cc-title')).toBeNull()

    mocks.auth.bootstrapping = false
    mocks.auth.accountId = 'account-b'
    view.rerender(<CreateCollection />)
    expect((document.getElementById('cc-title') as HTMLInputElement).value).toBe('')
    expect(document.body.textContent).not.toContain('Secret title')
    expect(document.body.textContent).not.toContain('Anon secret')
    expect(readAutoSaveDraft('create-collection', 'anonymous')).toEqual({
      title: 'Anon secret', summary: '', kind: 'bookmarks',
    })
    expect(readAutoSaveDraft('create-collection', 'account:account-a')).toEqual({
      title: 'Secret title', summary: '', kind: 'bookmarks',
    })
    expect(readAutoSaveDraft('create-collection', 'account:account-b')).toBeNull()
  })
})

describe('CreateCollection title validation', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.auth.accountId = 'account-a'
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('marks the title invalid instead of toasting when it is empty', async () => {
    renderWithRouter(<CreateCollection />, { route: '/library/new' })
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('#cc-title')?.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('#cc-title-error')?.textContent).toBe('Enter a title')
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.createCollection).not.toHaveBeenCalled()
  })

  it('clears the signed-in account draft after create and leaves other partitions', async () => {
    localStorage.setItem(draftKey('account-a'), JSON.stringify({
      title: 'Alpha', summary: 'Notes', kind: 'bookmarks',
    }))
    localStorage.setItem(draftKey('account-b'), JSON.stringify({
      title: 'Beta', summary: '', kind: 'mixed',
    }))
    mocks.createCollection.mockResolvedValue({ collection: { id: 'col-1', title: 'Alpha' } })
    renderWithRouter(<CreateCollection />, { route: '/library/new' })
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.createCollection).toHaveBeenCalled()
    expect(readAutoSaveDraft('create-collection', 'account:account-a')).toBeNull()
    expect(readAutoSaveDraft('create-collection', 'account:account-b')).toEqual({
      title: 'Beta', summary: '', kind: 'mixed',
    })
  })
})

describe('CreateCollection session gates', () => {
  beforeEach(() => {
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.auth.accountId = 'account-a'
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    mocks.auth.isLoggedIn = true
    mocks.auth.bootstrapping = false
    mocks.auth.accountId = 'account-a'
  })

  it('shows LoadingState while the session is bootstrapping', () => {
    mocks.auth.bootstrapping = true
    renderWithRouter(<CreateCollection />, { route: '/library/new' })
    expect(document.body.textContent).toContain('Checking your session')
    expect(document.querySelector('[data-testid="loading-state-dot"]')).not.toBeNull()
    expect(document.getElementById('cc-title')).toBeNull()
    expect(document.body.textContent).not.toContain('Sign in to continue')
  })

  it('shows RouteState auth with returnTo when signed out', () => {
    mocks.auth.isLoggedIn = false
    renderWithRouter(<CreateCollection />, { route: '/library/new' })
    expect(document.body.textContent).toContain('Sign in to continue')
    expect(document.body.textContent).toContain('You need to be signed in to create a collection')
    expect(document.querySelector('a[href="/login?returnTo=%2Flibrary%2Fnew"]')?.textContent).toBe('Sign in')
    expect(document.getElementById('cc-title')).toBeNull()
    expect(document.querySelector('form')).toBeNull()
  })
})
