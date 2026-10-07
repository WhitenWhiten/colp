// @vitest-environment happy-dom
/**
 * Owned-collection visibility badge and public actions on the Library desk
 * (R13 W-14), split out of Library.test.tsx to keep it under its test gate.
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForDom } from '../test/render'
import {
  entry,
  mocks,
  mount,
  setUpLibrary,
  snapshot,
  tearDownLibrary,
} from './Library.test-helper'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks: apiMocks } = await import('./Library.test-mocks')
  return {
    ...actual,
    isLive: apiMocks.isLive,
    productClient: {
      ...actual.productClient,
      loadEditorSnapshot: apiMocks.loadEditorSnapshot,
      loadAnnotations: apiMocks.loadAnnotations,
      loadPublicCollectionSnapshot: apiMocks.loadPublicCollectionSnapshot,
      listFollowedCollections: apiMocks.listFollowedCollections,
      listFollowedReports: apiMocks.listFollowedReports,
      listMyReports: apiMocks.listMyReports,
      getFollowedReportIssuesPage: apiMocks.getFollowedReportIssuesPage,
      getMyLibraryOrder: apiMocks.getMyLibraryOrder,
      newCommandId: () => '11111111-1111-4111-8111-111111111111',
      mutationIntentKey: (scope: string, commandId: string) => `${scope}:${commandId}`,
    },
  }
})
vi.mock('../auth/AuthContext', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useAuth: () => m.auth }
})
vi.mock('../lib/useOwnedCollections', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useOwnedCollections: () => m.collections }
})
vi.mock('../lib/useSharedCollections', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useSharedCollections: () => m.shared }
})
vi.mock('../lib/useMyCollaborationInvites', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return { useMyCollaborationInvites: () => m.invites }
})
vi.mock('../lib/useSavedResource', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return {
    useSavedResources: () => m.saved,
    useSavedResource: () => ({ state: 'ready', saved: false, pending: false, label: 'Save', toggle: vi.fn(), retry: vi.fn(), reload: vi.fn() }),
  }
})
vi.mock('../lib/useReadingProgress', async () => {
  const { mocks: m } = await import('./Library.test-mocks')
  return {
    useReadingProgressList: () => m.progress,
    useReadingProgress: () => ({ progress: 0, status: 'not_started', saveState: 'saved', message: '', setProgress: vi.fn(), toggleComplete: vi.fn(), retry: vi.fn(), flush: vi.fn(), reload: vi.fn() }),
  }
})
vi.mock('../components/AppToast', () => ({ useToast: () => ({ toast: vi.fn(), success: vi.fn(), error: vi.fn() }) }))

describe('Library owned collection publication', () => {
  beforeEach(setUpLibrary)
  afterEach(tearDownLibrary)

  function showOwnedCollection(
    visibility: 'private' | 'protected' | 'unlisted' | 'public',
    publicationSlug: string | null,
  ) {
    mocks.collections.items = [entry('one', 'One')]
    mocks.isLive.mockImplementation((flag: string) =>
      ['collectionList', 'savedResources', 'readingProgress', 'collaborators'].includes(flag))
    mocks.loadEditorSnapshot.mockImplementation(async (id: string) => {
      const base = snapshot(id, 'One')
      return { ...base, collection: { ...base.collection, visibility, publicationSlug } }
    })
  }

  async function ownedMenuLabels(): Promise<string[][]> {
    await waitForDom(() => document.querySelector('[data-testid="library-visibility"]') != null)
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="More collection actions"]')]
    expect(buttons.length).toBeGreaterThan(0)
    const labels: string[][] = []
    for (const button of buttons) {
      act(() => button.click())
      const openMenus = document.querySelectorAll('[role="menu"]')
      expect(openMenus.length).toBe(1)
      labels.push([...(openMenus[0]?.querySelectorAll('[role="menuitem"]') ?? [])].map((item) => item.textContent ?? ''))
      act(() => button.click())
      expect(document.querySelector('[role="menu"]')).toBeNull()
    }
    return labels
  }

  it('shows publication state and public actions for an owned public collection', async () => {
    showOwnedCollection('public', 'notes/queue')
    mount()
    const menus = await ownedMenuLabels()
    const badge = document.querySelector('[data-testid="library-visibility"]')
    expect(badge?.textContent).toBe('Public')
    expect(badge?.classList.contains('badge--success')).toBe(true)
    // One More menu: Add bookmark stays in the header at every width.
    expect(menus.length).toBe(1)
    for (const labels of menus) {
      expect(labels).toEqual([
        'Add folder',
        'Edit collection',
        'Version history',
        'Collaborators',
        'Open public page',
        'Copy public link',
        'Check links',
      ])
    }
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click())
    const menu = document.querySelector('[role="menu"]')
    // R15-35: the menu is named by its trigger.
    const labelledBy = menu?.getAttribute('aria-labelledby') ?? ''
    expect(labelledBy).not.toBe('')
    expect(document.getElementById(labelledBy)?.getAttribute('aria-label')).toBe('More collection actions')
    const open = menu?.querySelector<HTMLAnchorElement>('a[href="/c/notes%2Fqueue"]')
    expect(open?.textContent).toBe('Open public page')
    expect(open?.getAttribute('role')).toBe('menuitem')
    expect(open?.getAttribute('tabindex')).toBe('-1')
    const copy = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      .find((item) => item.textContent === 'Copy public link')
    expect(copy?.getAttribute('tabindex')).toBe('-1')
    const health = menu?.querySelector<HTMLAnchorElement>('a[href="/library/health"]')
    expect(health?.textContent).toBe('Check links')
    expect(health?.getAttribute('role')).toBe('menuitem')
  })

  it('shows an unlisted collection as Unlisted and still offers its public link', async () => {
    showOwnedCollection('unlisted', 'quiet-shelf')
    mount()
    const menus = await ownedMenuLabels()
    const badge = document.querySelector('[data-testid="library-visibility"]')
    expect(badge?.textContent).toBe('Unlisted')
    expect(badge?.classList.contains('badge--accent')).toBe(true)
    for (const labels of menus) {
      expect(labels).toContain('Open public page')
      expect(labels).toContain('Copy public link')
    }
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click())
    expect(document.querySelector('[role="menu"] a[href="/c/quiet-shelf"]')).not.toBeNull()
  })

  it('hides public actions on a private collection even when a slug is stored', async () => {
    showOwnedCollection('private', 'should-stay-hidden')
    mount()
    const menus = await ownedMenuLabels()
    const badge = document.querySelector('[data-testid="library-visibility"]')
    expect(badge?.textContent).toBe('Private')
    expect(badge?.classList.contains('badge--muted')).toBe(true)
    for (const labels of menus) {
      expect(labels).not.toContain('Open public page')
      expect(labels).not.toContain('Copy public link')
      expect(labels).toContain('Check links')
    }
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click())
    expect(document.querySelector('a[href="/c/should-stay-hidden"]')).toBeNull()
  })

  it('labels a protected collection with its capitalized visibility and no public actions', async () => {
    showOwnedCollection('protected', 'protected-shelf')
    mount()
    const menus = await ownedMenuLabels()
    const badge = document.querySelector('[data-testid="library-visibility"]')
    expect(badge?.textContent).toBe('Protected')
    expect(badge?.classList.contains('badge--muted')).toBe(true)
    for (const labels of menus) {
      expect(labels).not.toContain('Open public page')
      expect(labels).not.toContain('Copy public link')
    }
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click())
    expect(document.querySelector('a[href="/c/protected-shelf"]')).toBeNull()
  })

  it('hides Check links when link health is off', async () => {
    window.__KNOWN_FLAGS__ = { linkHealth: false }
    showOwnedCollection('public', 'notes-queue')
    mount()
    const menus = await ownedMenuLabels()
    for (const labels of menus) {
      expect(labels).toContain('Open public page')
      expect(labels).not.toContain('Check links')
    }
  })
})
