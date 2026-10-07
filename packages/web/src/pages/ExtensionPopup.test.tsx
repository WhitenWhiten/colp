// @vitest-environment happy-dom
/* Extension-popup preview boundary.
 *
 * Behaviour — the rendered popup with its two hooks mocked: the first owned
 * collection title fills the one "Save to" row (as the real popup's collapsed
 * destination), the page card is a labelled placeholder, the handle comes from
 * the session, loading/error/signed-out states use EmptyState, Save is an
 * install link rather than a fabricated success, and advancing the clock after
 * the save shortcut produces no state change at all.
 *
 * Architecture — the popup is a preview and must stay read-only: it may not
 * import the Product client or hold a save/mutation call, and the retired mock
 * folder fixture must not reappear in any branch. A save path behind a branch
 * no test drives changes no rendered frame, so its absence is asserted on the
 * module rather than on the DOM.
 */
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPopup } from './ExtensionPopup'
import popupSource from './ExtensionPopup.tsx?raw'
import { cleanup, mountTree } from '../test/render'

const signedInOwned = {
  items: [
    { collection: { id: 'col-reading', title: 'Reading list' } },
    { collection: { id: 'col-thesis', title: 'Thesis sources' } },
  ],
  state: 'ready' as const,
  message: '2 collections',
  hasMore: false,
  isLoadingMore: false,
  reload: async () => undefined,
  loadMore: async () => undefined,
}

const signedOutOwned = {
  items: [] as typeof signedInOwned.items,
  state: 'ready' as const,
  message: 'Sign in to view your collections',
  hasMore: false,
  isLoadingMore: false,
  reload: async () => undefined,
  loadMore: async () => undefined,
}

const mocks = vi.hoisted(() => ({
  auth: { user: { handle: 'kai', name: 'Kai Nakamura' } as { handle: string; name: string } | null },
  owned: {
    items: [] as Array<{ collection: { id: string; title: string } }>,
    state: 'ready' as 'loading' | 'ready' | 'error',
    message: 'Sign in to view your collections',
    hasMore: false,
    isLoadingMore: false,
    reload: async () => undefined,
    loadMore: async () => undefined,
  },
}))

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

vi.mock('../lib/useOwnedCollections', () => ({
  useOwnedCollections: () => mocks.owned,
}))

function applyOwned(next: typeof mocks.owned) {
  mocks.owned.items = next.items
  mocks.owned.state = next.state
  mocks.owned.message = next.message
  mocks.owned.hasMore = next.hasMore
  mocks.owned.isLoadingMore = next.isLoadingMore
  mocks.owned.reload = next.reload
  mocks.owned.loadMore = next.loadMore
}

describe('ExtensionPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.auth.user = { handle: 'kai', name: 'Kai Nakamura' }
    applyOwned({ ...signedInOwned, items: [...signedInOwned.items] })
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    document.body.innerHTML = ''
  })

  function render() {
    mountTree(<MemoryRouter><ExtensionPopup /></MemoryRouter>)
  }

  describe('capture popup behaviour', () => {
    it('shows the first owned collection in one Save to row and a placeholder page card', () => {
      render()
      expect(document.body.textContent).toContain('@kai')
      expect(document.body.textContent).not.toContain('@lin-yichen')
      expect(document.querySelector('[role="listbox"]')).toBeNull()
      const dest = document.querySelector('[data-testid="ext-popup-dest"]')
      expect(dest?.querySelector('#ext-save-dest-label')?.textContent).toBe('Save to')
      expect(dest?.textContent).toContain('Reading list › Bookmarks bar')
      expect(document.body.textContent).not.toContain('Thesis sources')
      expect(document.body.textContent).not.toContain('Save to collection')
      expect(document.body.textContent).not.toContain('Unsorted')
      expect(document.body.textContent).not.toContain('Design systems')
      expect(document.body.textContent).not.toContain('Create: Editorial layout')
      expect(document.body.textContent).not.toContain('92% match')
      expect(document.body.textContent).not.toContain('% match')
      expect(document.body.textContent).not.toContain('Spacing as a system')
      /* The page card mirrors the real popup's: icon, title and URL with no
         field labels, and the placeholder URL appears nowhere else. */
      const card = document.querySelector('[data-testid="ext-tab-preview"]')
      expect(card?.querySelector('svg')).not.toBeNull()
      expect(card?.querySelector('strong')?.textContent).toBe('Page title from your open tab')
      expect(card?.querySelector('span')?.textContent).toBe('https://example.com/article')
      expect(document.querySelector('#ext-tab-title, #ext-tab-url, label')).toBeNull()
      expect(document.body.textContent?.split('example.com')).toHaveLength(2)
      const chrome = document.querySelector('[aria-label="Know-N extension"]')
      expect(chrome?.textContent).toContain('Allow bookmark access so the extension can save pages.')
      expect(chrome?.textContent).toContain("Folders that don't sync to Know-N can still save on this device.")
      expect(chrome?.textContent).not.toContain('sync range')
      const buttons = [...(chrome?.querySelectorAll('button') ?? [])]
      const allow = buttons.find((button) => button.textContent?.trim() === 'Allow')
      expect(allow?.disabled).toBe(true)
      expect(buttons.find((button) => button.textContent?.trim() === 'Change')).toBeUndefined()
    })

    it('turns Save into an install link instead of a fake success toast', () => {
      render()
      expect(document.body.textContent).not.toContain('Save bookmark')
      expect(document.querySelector('button.ext-popup-save')).toBeNull()
      const save = document.querySelector('a.ext-popup-save')
      expect(save?.getAttribute('href')).toBe('/extension')
      expect(save?.textContent).toMatch(/install/i)
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
      })
      expect(document.body.textContent).not.toContain('Saved to')
      expect(document.body.textContent).not.toContain('classify inbox')
    })

    it('never fabricates a save when the shortcut runs and time advances', () => {
      vi.useFakeTimers()
      render()
      const before = document.body.textContent
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
      })
      act(() => {
        vi.advanceTimersByTime(30_000)
      })
      /* The retired preview faked a save on a timer ("Saved to …", 92% match).
         Nothing may change after the shortcut, however long the clock runs. */
      expect(document.body.textContent).toBe(before)
      expect(document.body.textContent).not.toContain('Saved to')
      expect(document.body.textContent).not.toContain('% match')
      expect(document.querySelector('a.ext-popup-save')?.getAttribute('href')).toBe('/extension')
    })

    it('shows EmptyState when signed out and does not hardcode a handle or mock folders', () => {
      mocks.auth.user = null
      applyOwned({ ...signedOutOwned })
      render()
      expect(document.querySelector('[role="listbox"]')).toBeNull()
      expect(document.body.textContent).toContain('Sign in to view your collections')
      expect(document.body.textContent).not.toContain('Design systems')
      expect(document.body.textContent).not.toContain('Unsorted')
      expect(document.body.textContent).not.toContain('@lin-yichen')
      expect(document.body.textContent).not.toContain('@kai')
      const login = [...document.querySelectorAll('a')].find((link) => link.getAttribute('href')?.startsWith('/login'))
      expect(login).toBeTruthy()
    })

    it('uses EmptyState for loading and error instead of falling back to mock folders', () => {
      applyOwned({
        ...signedOutOwned,
        state: 'loading',
        message: 'Loading collections',
      })
      render()
      expect(document.querySelector('[role="status"]')?.textContent).toContain('Loading collections')
      expect(document.body.textContent).not.toContain('Design systems')
      expect(document.querySelector('[role="listbox"]')).toBeNull()

      applyOwned({
        ...signedOutOwned,
        state: 'error',
        message: "Couldn't load collections",
      })
      mountTree(<MemoryRouter><ExtensionPopup /></MemoryRouter>)
      const alert = document.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain("Couldn't load collections")
      expect(document.body.textContent).not.toContain('Design systems')
      expect(document.querySelector('[role="listbox"]')).toBeNull()
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps the popup read-only and free of the retired mock fixture', () => {
      /* The rendered popup is a preview: the only save affordance navigates to
         the install page (observed above). What no render can show is a save or
         mutation call sitting in a branch the test never drives, or mock folder
         content in a fallback list — those ship silently. The assertions are on
         module specifiers and symbols, so a rename cannot make them red. The
         positive anchor first: an empty read would pass every absence check. */
      expect(popupSource).toContain('export function ExtensionPopup')
      expect(popupSource).toMatch(/from ['"][^'"]*useOwnedCollections['"]/u)
      expect(popupSource).not.toMatch(/from ['"][^'"]*\/api(?:\/[\w-]+)*['"]/u)
      expect(popupSource).not.toMatch(/\bproductClient\b/u)
      expect(popupSource).not.toContain('saveBookmark')
      expect(popupSource).not.toContain('createCollectionNode')
      for (const mockContent of [
        'myFolders',
        '@lin-yichen',
        'Saved to',
        'Create: Editorial layout',
        '92%',
        'Spacing as a system',
      ]) {
        expect(popupSource, mockContent).not.toContain(mockContent)
      }
    })
  })
})
