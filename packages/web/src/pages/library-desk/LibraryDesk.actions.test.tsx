// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalSiteOrigin } from '../../lib/chrome'
import { domFinishedLoading, waitForDom } from '../../test/render'
import { bulkbarButton, clickMenuItem, destinationButtons, filterDesk, mocks, mount, openRowMenu, settleAnnotationReads, setUpLibraryDesk, snapshot, tearDownLibraryDesk } from './LibraryDesk.test-helper'

vi.mock('../../auth/AuthContext', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useAuth: () => mocks.auth }
})
vi.mock('../../components/AppToast', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }) }
})
vi.mock('../../lib/useOwnedCollections', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useOwnedCollections: () => mocks.collections }
})
vi.mock('../../lib/useSharedCollections', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useSharedCollections: () => mocks.shared }
})
vi.mock('../../lib/useMyCollaborationInvites', async () => {
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return { useMyCollaborationInvites: () => mocks.invites }
})
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  const { mocks } = await import('./LibraryDesk.test-mocks')
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: mocks.loadEditorSnapshot,
      loadAnnotations: mocks.loadAnnotations,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      createCollectionNode: mocks.createCollectionNode,
      moveCollectionNode: mocks.moveCollectionNode,
      deleteCollectionNode: mocks.deleteCollectionNode,
      listFollowedCollections: mocks.listFollowedCollections,
      listFollowedReports: mocks.listFollowedReports,
      listMyReports: mocks.listMyReports,
      getFollowedReportIssuesPage: mocks.getFollowedReportIssuesPage,
      getMyLibraryOrder: mocks.getMyLibraryOrder,
      updateMyLibraryOrder: mocks.updateMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})

describe('LibraryDesk menus and selection', () => {
  beforeEach(setUpLibraryDesk)
  afterEach(tearDownLibraryDesk)

  it('shows the bookmark row menu with caps-gated items and never navigates', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const primary = document.querySelector<HTMLAnchorElement>('a[data-node-id="col-1-loose"]')
    expect(primary?.getAttribute('href')).toBe('https://loose.example/')
    expect(primary?.getAttribute('target')).toBe('_blank')
    expect(document.querySelector('a[href^="/read/"]')).toBeNull()
    openRowMenu('Loose bookmark')
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-1')
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent)
    expect(items).toEqual(['View details', 'Edit details', 'Move to…', 'Copy to…', 'Select', 'Delete'])
    expect(document.querySelector<HTMLAnchorElement>('[role="menuitem"][href="/r/col-1-loose?collectionId=col-1&subjectType=node"]')).not.toBeNull()
  })

  it('selects titles and annotation excerpts without following links in selection mode', async () => {
    mocks.loadAnnotations.mockImplementation(async (
      _collectionId: string,
      subject: { resourceId: string },
    ) => subject.resourceId === 'col-1-loose'
      ? [{ id: 'selection-note', type: 'note', visibility: 'private', value: 'Selection excerpt' }]
      : [])
    mount()
    await waitForDom(() => document.querySelector('[data-testid="bookmark-note"]') != null)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    const row = document.querySelector<HTMLElement>('[role="listitem"][data-node-id="col-1-loose"]')!
    expect(row.querySelector('a')).toBeNull()
    expect(row.getAttribute('data-selected')).toBe('true')
    act(() => { row.querySelector<HTMLElement>('h3')!.click() })
    expect(row.hasAttribute('data-selected')).toBe(false)
    act(() => { row.querySelector<HTMLElement>('[data-testid="bookmark-note"]')!.click() })
    expect(row.getAttribute('data-selected')).toBe('true')
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-1')
  })

  it('portals the row menu outside the bookmark list so the shared frame cannot clip it', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    const menu = document.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.closest('[data-testid="library-bookmarks"]')).toBeNull()
    expect(menu?.parentElement).toBe(document.body)
  })

  it('drives the row menu with the keyboard per the ARIA menu pattern', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const press = (key: string) => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        )
      })
    }
    // Opening moves focus into the first item (View details leads the menu).
    expect(document.activeElement).toBe(items()[0])
    expect(document.activeElement?.textContent).toBe('View details')
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('Edit details')
    press('End')
    expect(document.activeElement?.textContent).toBe('Delete')
    press('ArrowDown')
    // Wraps around.
    expect(document.activeElement?.textContent).toBe('View details')
    press('ArrowUp')
    expect(document.activeElement?.textContent).toBe('Delete')
    press('Home')
    expect(document.activeElement?.textContent).toBe('View details')
    // Esc closes and hands focus back to the ⋯ trigger.
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for Loose bookmark')
  })

  it('closes the row menu on Tab', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('drives the collection More menu with the keyboard per the ARIA menu pattern', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const press = (key: string) => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        )
      })
    }
    expect(document.activeElement).toBe(items()[0])
    expect(document.activeElement?.textContent).toBe('Add folder')
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('Edit collection')
    press('End')
    expect(document.activeElement?.textContent).toBe('Check links')
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('Add folder')
    press('ArrowUp')
    expect(document.activeElement?.textContent).toBe('Check links')
    press('Home')
    expect(document.activeElement?.textContent).toBe('Add folder')
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('More collection actions')
  })

  it('returns focus to the More trigger after Edit collection closes its sheet', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')!
    act(() => trigger.click())
    const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((item) => item.textContent === 'Edit collection')!
    act(() => edit.click())
    // Focus left the closing menu before the sheet mounted, so the trap's
    // recorded return target is the trigger.
    expect(document.activeElement).toBe(trigger)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog).not.toBeNull()
    act(() => {
      dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await waitForDom(() => document.querySelector('[role="dialog"]') === null)
    expect(document.activeElement).toBe(trigger)
  })

  it('closes the collection More menu on Tab', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('flags the shared current parent in the move picker and not for mixed selections', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    // Rows from both the root and the Later folder in one flat list.
    filterDesk('example')
    await settleAnnotationReads()
    // Single bookmark: its parent folder is disabled and marked.
    openRowMenu('First page item')
    clickMenuItem('Move to…')
    let current = destinationButtons().find((button) => button.textContent?.includes('Later'))
    expect(current?.disabled).toBe(true)
    expect(current?.textContent).toContain('(current)')
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click()
    })
    // Mixed selection (root + folder): nothing is flagged as current.
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    act(() => {
      document.querySelector<HTMLInputElement>('input[aria-label="Select First page item"]')?.click()
    })
    act(() => bulkbarButton('Move')?.click())
    current = destinationButtons().find((button) => button.textContent?.includes('(current)'))
    expect(current).toBeUndefined()
    for (const button of destinationButtons()) expect(button.disabled).toBe(false)
  })

  it('shows the long-press selection tip once and never for menu Select', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    // Entering via the row menu never tips.
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    expect(mocks.toast).not.toHaveBeenCalled()
    act(() => bulkbarButton('Cancel')?.click())

    const longPressRow = (title: string) => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="library-bookmarks"] [role="listitem"]')]
        .find((el) => el.textContent?.includes(title))
      vi.useFakeTimers()
      act(() => {
        row?.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          pointerType: 'touch',
          clientX: 10,
          clientY: 10,
        }))
      })
      act(() => {
        vi.advanceTimersByTime(500)
      })
      vi.useRealTimers()
    }

    // First long-press entry: one-time tip.
    longPressRow('Loose bookmark')
    expect(document.querySelector('[data-testid="library-bulkbar"]')).not.toBeNull()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
    expect(mocks.toast).toHaveBeenCalledWith('Tip: long-press any bookmark to add it to the selection')
    expect(localStorage.getItem('known.library.select-tip.v1')).toBe('1')
    act(() => bulkbarButton('Cancel')?.click())

    // Second long-press entry: the marker suppresses the tip.
    longPressRow('Loose bookmark')
    expect(mocks.toast).toHaveBeenCalledTimes(1)
  })

  it('keeps one tab stop in the bulk toolbar and roams with arrow keys', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openRowMenu('Loose bookmark')
    clickMenuItem('Select')
    const bar = document.querySelector<HTMLElement>('[data-testid="library-bulkbar"]')
    if (!bar) throw new Error('bulkbar missing')
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1)
    act(() => buttons[0]!.focus())
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(document.activeElement).toBe(buttons[1])
    act(() => buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    expect(document.activeElement).toBe(buttons[0])
    act(() => buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
    expect(buttons[0]!.tabIndex).toBe(-1)
    act(() => bulkbarButton('Cancel')?.click())
  })

  it('keeps a details-only bookmark menu for viewers without node capabilities', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.capabilities = {
      updateCollection: false,
      managePublication: false,
      createNode: false,
      updateNode: false,
      moveNode: false,
      deleteNode: false,
    }
    mocks.loadEditorSnapshot.mockResolvedValue(snap)
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
    openRowMenu('Loose bookmark')
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['View details'])
  })

  it('keeps a public details-only bookmark menu on followed collections', async () => {
    mount('/library/following/shared-shelf')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Followed bookmark')
    openRowMenu('Followed bookmark')
    const items = [...document.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['View details'])
    expect(items[0]?.getAttribute('href')).toBe('/r/bm-f?subjectType=node&slug=shared-shelf')
  })

  it.each(['viewer', 'followed'] as const)('does not enter selection on a %s collection long-press', async (kind) => {
    if (kind === 'viewer') {
      const snap = snapshot('col-1', 'Reading queue')
      snap.capabilities = {
        updateCollection: false, managePublication: false, createNode: false,
        updateNode: false, moveNode: false, deleteNode: false,
      }
      mocks.loadEditorSnapshot.mockResolvedValue(snap)
    }
    mount(kind === 'followed' ? '/library/following/shared-shelf' : '/library/col-1')
    await waitForDom(domFinishedLoading)
    const title = kind === 'followed' ? 'Followed bookmark' : 'Loose bookmark'
    const row = [...document.querySelectorAll<HTMLElement>('[data-testid="library-bookmarks"] [role="listitem"]')]
      .find((el) => el.textContent?.includes(title))!
    expect(row).toBeTruthy()
    vi.useFakeTimers()
    try {
      act(() => {
        row.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, pointerType: 'touch', clientX: 10, clientY: 10,
        }))
      })
      act(() => { vi.advanceTimersByTime(500) })
      expect(document.querySelector('[data-testid="library-bulkbar"]')).toBeNull()
      expect(row.querySelector('input[type="checkbox"]')).toBeNull()
      expect(row.querySelector('a')).not.toBeNull()
      expect(mocks.toast).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('copies the public link for an owned public collection and toasts when copy fails', async () => {
    const base = snapshot('col-1', 'Reading queue')
    mocks.loadEditorSnapshot.mockImplementation(async () => ({
      ...base,
      collection: { ...base.collection, visibility: 'public' as const, publicationSlug: 'notes/queue' },
    }))
    const writeText = vi.fn().mockResolvedValue(undefined)
    const previousSecure = window.isSecureContext
    const previousClipboard = navigator.clipboard
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      mount()
      await waitForDom(() => document.querySelector('[data-testid="library-visibility"]')?.textContent === 'Public')
      act(() => {
        document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
      })
      const copy = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === 'Copy public link')
      expect(copy).toBeDefined()
      await act(async () => { copy?.click() })
      expect(writeText).toHaveBeenCalledWith(`${canonicalSiteOrigin()}/c/notes%2Fqueue`)
      expect(mocks.success).toHaveBeenCalledWith('Public link copied')
      expect(document.querySelector('[role="menu"]')).toBeNull()
      /* The action returns focus to the trigger instead of dropping to body. */
      expect(document.activeElement).toBe(document.querySelector('button[aria-label="More collection actions"]'))

      writeText.mockRejectedValueOnce(new Error('denied'))
      Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
      act(() => {
        document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
      })
      const copyAgain = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === 'Copy public link')
      await act(async () => { copyAgain?.click() })
      expect(mocks.error).toHaveBeenCalledWith('Couldn’t copy the link')
    } finally {
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: previousSecure })
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
    }
  })

  it('does not offer public actions for a private owned collection', async () => {
    const base = snapshot('col-1', 'Reading queue')
    mocks.loadEditorSnapshot.mockImplementation(async () => ({
      ...base,
      collection: { ...base.collection, visibility: 'private' as const, publicationSlug: 'should-stay-hidden' },
    }))
    mount()
    await waitForDom(() => document.querySelector('[data-testid="library-visibility"]')?.textContent === 'Private')
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(labels).not.toContain('Open public page')
    expect(labels).not.toContain('Copy public link')
    expect(document.querySelector('a[href="/c/should-stay-hidden"]')).toBeNull()
  })
})
