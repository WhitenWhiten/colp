// @vitest-environment happy-dom
/* LibraryDesk sharing, sidebar and counts.
 *
 * Behaviour — the real desk driven with its client and hooks mocked: the
 * Collaborators menu link on/off, shared collections in the owned branch and
 * the mobile switcher, invitations from the frozen payload, accept/decline,
 * keeping rows when the shared list fails, and the nav counts (list values,
 * snapshot overlay, folder subtree, never-prefetched collections).
 *
 * Architecture — the desk surface scan: fixture people must not appear anywhere
 * in the production library-desk modules, including branches no test renders.
 * The scan is anchored on the whole production tree and asserts its own
 * completeness, because a glob joined into one string passes vacuously when the
 * pattern matches nothing (this file's pattern used to be anchored on a
 * `./library-desk/` subdirectory that does not exist, so only LibraryDesk.tsx
 * itself was ever scanned).
 */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_FLAGS } from '../../api/featureFlags'
import librarySource from './LibraryDesk.tsx?raw'
import { flattenBookmarks } from '../../lib/libraryTree'
import { plural } from '../../lib/plural'

/* Production modules of the desk only: colocated test files may legitimately
   carry fixture people. */
const libraryDeskModules = import.meta.glob(
  ['./**/*.{ts,tsx}', '!**/*.test.*', '!**/*.test-helper.*', '!**/*.test-mocks.*'],
  {
    eager: true,
    import: 'default',
    query: '?raw',
  },
) as Record<string, string>
const libraryDeskSources = Object.values(libraryDeskModules)
import { domFinishedLoading, waitForDom } from '../../test/render'
import {
  collectionItem,
  extraBookmark,
  mocks,
  mount,
  rejectSnapshot,
  setUpLibraryDesk,
  snapshot,
  snapshotRequestedIds,
  tearDownLibraryDesk,
} from './LibraryDesk.test-helper'

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

describe('LibraryDesk sharing and sidebar counts', () => {
  beforeEach(setUpLibraryDesk)
  afterEach(tearDownLibraryDesk)

  it('shows the Collaborators menu link when production exposure is live', async () => {
    expect(FEATURE_FLAGS.collaborators).toBe(true)
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    const collaborators = document.querySelector<HTMLAnchorElement>('a[href="/library/col-1/collaborators"]')
    expect(collaborators?.textContent).toContain('Collaborators')
    expect([...document.querySelectorAll('[data-testid="library-nav"] .section-label')].map((node) => node.textContent)).not.toContain('Shared with you')
    expect([...document.querySelectorAll('[data-testid="library-nav"] .section-label')].map((node) => node.textContent)).not.toContain('Invitations')
  })

  it('hides the Collaborators menu link when __KNOWN_FLAGS__.collaborators is false', async () => {
    window.__KNOWN_FLAGS__ = { collaborators: false }
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    expect(document.querySelector('a[href="/library/col-1/collaborators"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Collaborators')
  })

  it('shows Shared with you using the owned collection branch and a Shared mobile section', async () => {
    mocks.shared.items = [collectionItem('col-shared', 'Team research')]
    mount()
    await waitForDom(domFinishedLoading)
    const sections = [...document.querySelectorAll('button[aria-controls^="library-nav-section-"]')].map((node) => node.textContent?.trim())
    expect(sections).toContain('Shared with you')
    expect(document.body.textContent).not.toContain('The extension only syncs collections you own, not ones shared with you.')
    expect(document.querySelector('a[data-collection-id="col-shared"]')?.textContent).toContain('Team research')
    const ownedTree = document.querySelector('[aria-label="Collection folders"]')
    expect(ownedTree?.querySelector('a[data-collection-id="col-shared"]')).toBeNull()
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-mobile-switcher-trigger"]')?.click()
    })
    const sheet = document.querySelector('[data-testid="library-mobile-switcher"]')
    expect(sheet?.textContent).toContain('Shared with you')
    expect(sheet?.querySelector('[data-collection-id="col-shared"]')?.textContent).toContain('Team research')
  })

  it('lists owned collections and nested folders in the mobile switcher', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="library-mobile-switcher-trigger"]')?.click()
    })
    const sheet = document.querySelector('[data-testid="library-mobile-switcher"]')
    expect(sheet?.querySelector('[data-collection-id="col-1"]')?.textContent).toContain('Reading queue')
    expect(sheet?.querySelector('[data-folder-id="col-1-folder"]')?.textContent).toContain('Later')
  })

  it('shows Invitations with the frozen collectionTitle from the invite payload', async () => {
    mocks.invites.items = [{
      inviteId: 'inv-1',
      collectionId: 'col-shared',
      collectionTitle: 'Frozen Shelf',
      role: 'editor',
      email: 'b@example.test',
      expiresAt: '2026-08-26T00:00:00.000Z',
      invitedAt: '2026-08-19T00:00:00.000Z',
    }]
    mount()
    await waitForDom(domFinishedLoading)
    const nav = document.querySelector('[data-testid="library-nav"]')
    const invites = nav?.querySelector('[data-testid="library-nav-invites"]')
    const sections = [...(nav?.children ?? [])]
      .filter((node) => node.tagName === 'SECTION')
      .map((node) => node.getAttribute('data-testid'))
    expect([...document.querySelectorAll('[data-testid="library-nav"] .section-label')].map((node) => node.textContent)).toContain('Invitations')
    expect(invites?.querySelector('[aria-label="Pending invitations"]')?.textContent).toContain('Frozen Shelf')
    expect(invites?.querySelector('[aria-label="Pending invitations"]')?.getAttribute('role')).not.toBe('tree')
    expect(invites?.querySelector('[role="treeitem"]')).toBeNull()
    expect(invites?.querySelector('[aria-label="Accept invitation to Frozen Shelf"]')?.className).toBe('btn btn-secondary btn-sm')
    expect(invites?.querySelector('[aria-label="Decline invitation to Frozen Shelf"]')?.className).toBe('btn btn-ghost btn-sm')
    expect(sections[0]).toBe('library-nav-invites')
    expect(sections[1]).toBe('library-nav-mine')
    // R15-44 (R13 D-25 option B): a list while idle, a tree only in reorder mode.
    expect(nav?.querySelector('[aria-label="Collection folders"]')?.getAttribute('role')).toBe('list')
  })

  it('accepts an invite, refreshes shared collections, and navigates to the collection', async () => {
    mocks.invites.items = [{
      inviteId: 'inv-1',
      collectionId: 'col-shared',
      collectionTitle: 'Frozen Shelf',
      role: 'editor',
      email: 'b@example.test',
      expiresAt: '2026-08-26T00:00:00.000Z',
      invitedAt: '2026-08-19T00:00:00.000Z',
    }]
    mount()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Accept')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.invites.accept).toHaveBeenCalledWith('inv-1')
    expect(mocks.shared.reload).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/library/col-shared')
  })

  it('declines an invite', async () => {
    mocks.invites.items = [{
      inviteId: 'inv-1',
      collectionId: 'col-shared',
      collectionTitle: 'Frozen Shelf',
      role: 'editor',
      email: 'b@example.test',
      expiresAt: '2026-08-26T00:00:00.000Z',
      invitedAt: '2026-08-19T00:00:00.000Z',
    }]
    mount()
    await waitForDom(domFinishedLoading)
    await act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Decline')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.invites.decline).toHaveBeenCalledWith('inv-1')
  })

  it('keeps the owned tree when the shared list fails', async () => {
    mocks.shared.state = 'error'
    mocks.shared.message = "Couldn't load shared collections"
    mocks.shared.items = []
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('a[data-collection-id="col-1"]')?.textContent).toContain('Reading queue')
    expect(document.querySelector('a[data-collection-id="col-2"]')?.textContent).toContain('Second shelf')
    expect(document.querySelector('[aria-label="Shared collections"]')).toBeNull()
    expect([...document.querySelectorAll('[data-testid="library-nav-shared"] [role="alert"]')].some((node) => node.textContent === "Couldn't load shared collections")).toBe(true)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
  })

  it('keeps an empty Shared with you section honest and hides empty Invitations', async () => {
    mocks.shared.items = []
    mocks.shared.state = 'ready'
    mocks.invites.items = []
    mocks.invites.state = 'ready'
    mount()
    await waitForDom(domFinishedLoading)
    const eyebrows = [...document.querySelectorAll('[data-testid="library-nav"] .section-label')].map((node) => node.textContent)
    expect(eyebrows).toContain('Collections')
    expect(eyebrows).not.toContain('Invitations')
    const sharedSection = document.querySelector('[data-testid="library-nav-shared"]')
    expect(sharedSection?.textContent).toContain('Shared with you')
    expect(sharedSection?.textContent).toContain('Nothing is shared with you yet.')
    expect(sharedSection?.querySelector('[aria-label="Shared collections"]')).toBeNull()
    expect(document.body.textContent).not.toContain('A verified email is required.')
  })

  it('does not surface a verified-email invite error as a sidebar heading', async () => {
    mocks.invites.state = 'error'
    mocks.invites.message = 'A verified email is required.'
    mocks.invites.items = []
    mount()
    await waitForDom(domFinishedLoading)
    expect([...document.querySelectorAll('[data-testid="library-nav"] .section-label')].map((node) => node.textContent)).not.toContain('Invitations')
    expect(document.body.textContent).not.toContain('A verified email is required.')
  })

  it('shows list bookmarkCount for a collection that was never opened', async () => {
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue', { bookmarkCount: 2 }),
      collectionItem('col-2', 'Second shelf', { bookmarkCount: 9 }),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      if (id === 'col-2') return rejectSnapshot(id)
      return Promise.resolve(snapshot(id, 'Reading queue'))
    })
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-collection-id="col-2"] .library-nav-count')?.textContent).toBe('9 bookmarks')
    expect(snapshotRequestedIds()).toContain('col-1')
    expect(snapshotRequestedIds()).not.toContain('col-2')
  })

  it('renders bookmarkCount 0 in the collection nav', async () => {
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue', { bookmarkCount: 2 }),
      collectionItem('col-2', 'Second shelf', { bookmarkCount: 0 }),
    ]
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-collection-id="col-2"] .library-nav-count')?.textContent).toBe('0 bookmarks')
  })

  it('omits the nav count when bookmarkCount is missing', async () => {
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue', { bookmarkCount: 2 }),
      collectionItem('col-2', 'Second shelf'),
    ]
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-collection-id="col-2"] .library-nav-count')).toBeNull()
    expect(document.querySelector('a[data-collection-id="col-2"]')).not.toBeNull()
  })

  it('overlays flattenBookmarks length over the list bookmarkCount when a snapshot is ready', async () => {
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue', { bookmarkCount: 3 }),
      collectionItem('col-2', 'Second shelf', { bookmarkCount: 9 }),
    ]
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [
      ...snap.nodes,
      extraBookmark('col-1-third', 'col-1', snap.root.id, 'd', 'Third bookmark'),
      extraBookmark('col-1-fourth', 'col-1', snap.root.id, 'e', 'Fourth bookmark'),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      if (id === 'col-2') return rejectSnapshot(id)
      return Promise.resolve(snap)
    })
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    expect(flattenBookmarks(snap.root, snap.nodes)).toHaveLength(4)
    expect(document.querySelector('[data-collection-id="col-1"] .library-nav-count')?.textContent).toBe('4 bookmarks')
  })

  it('keeps folder row counts on the snapshot subtree instead of the list bookmarkCount', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    const listTotal = 9
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue', { bookmarkCount: listTotal }),
      collectionItem('col-2', 'Second shelf', { bookmarkCount: 3 }),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      if (id === 'col-2') return rejectSnapshot(id)
      return Promise.resolve(snap)
    })
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Expand Reading queue"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    const folderCount = flattenBookmarks(snap.root, snap.nodes, 'col-1-folder').length
    expect(folderCount).not.toBe(listTotal)
    expect(document.querySelector('[data-folder-id="col-1-folder"] .library-nav-count')?.textContent).toBe(plural(folderCount, 'bookmark'))
    expect(document.querySelector('[data-collection-id="col-1"] .library-nav-count')?.textContent).not.toBe(plural(listTotal, 'bookmark'))
  })

  it('does not loadEditorSnapshot for an unselected unexpanded collection', async () => {
    mocks.collections.items = [
      collectionItem('col-1', 'Reading queue', { bookmarkCount: 2 }),
      collectionItem('col-2', 'Second shelf', { bookmarkCount: 9 }),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) => {
      if (id === 'col-2') return rejectSnapshot(id)
      return Promise.resolve(snapshot(id, 'Reading queue'))
    })
    mount('/library/col-1')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('button[aria-label="Expand Second shelf"]')).not.toBeNull()
    expect(document.querySelector('[data-folder-id="col-2-folder"]')).toBeNull()
    expect(snapshotRequestedIds()).toContain('col-1')
    expect(snapshotRequestedIds()).not.toContain('col-2')
    expect(mocks.loadEditorSnapshot).not.toHaveBeenCalledWith('col-2', expect.anything())
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('scans the whole production desk surface, not a mis-anchored empty glob', () => {
      /* The completeness anchor. Every absence assertion below is vacuous if the
         glob matches nothing, and this is not hypothetical: the pattern used to
         be `./library-desk/**` relative to this file, i.e. a directory that does
         not exist, so the array was empty and only LibraryDesk.tsx (imported
         separately) was ever scanned. Asserting the scanned set is what makes
         the boundary claim honest. */
      const scanned = Object.keys(libraryDeskModules)
      expect(scanned.length).toBeGreaterThanOrEqual(20)
      for (const required of [
        './LibraryDesk.tsx',
        './LibrarySidebar.tsx',
        './LibraryHeader.tsx',
        './navTree.tsx',
        './data.ts',
        './mutations.ts',
      ]) {
        expect(scanned, required).toContain(required)
      }
      /* Colocated test files carry fixtures and are not a user-facing surface. */
      for (const excluded of ['./LibraryDesk.test-helper.tsx', './LibraryDesk.sharing.test.tsx']) {
        expect(scanned, excluded).not.toContain(excluded)
      }
    })

    it('keeps fixture people out of the production desk modules', () => {
      /* The rendered probes above only see the branches a test drives; a demo
         person sitting in an unrendered nav or menu branch would still ship.
         Scanning the whole production tree is the only complete form, and it is
         rename-proof: introducing a fixture name is the only way to fail it. */
      expect([librarySource, ...libraryDeskSources].join('\n')).not.toMatch(
        /Alex Chen|Jordan Blake|Morgan Lee|Priya Shah/u,
      )
    })
  })
})
