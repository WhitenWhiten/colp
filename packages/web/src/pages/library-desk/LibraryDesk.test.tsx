// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, domFinishedLoading, waitForDom } from '../../test/render'
import {
  extraBookmark,
  filterDesk,
  mocks,
  mount,
  setControlValue,
  setUpLibraryDesk,
  snapshot,
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

describe('LibraryDesk', () => {
  beforeEach(setUpLibraryDesk)
  afterEach(tearDownLibraryDesk)

  it('keeps a moderation-hidden followed digest in the sidebar as an inert row', async () => {
    window.__KNOWN_FLAGS__ = { reports: true }
    /* The two series below are the list endpoint's steady state, so they are
       the base implementation: StrictMode's mount → cleanup → mount walk reads
       the first page twice, and a single queued page would leave the second
       mount (and therefore the sidebar) empty. */
    mocks.listFollowedReports.mockResolvedValue({
      items: [
        {
          id: 'series-hidden', ownerSubjectId: 'owner-1', title: 'Digest hidden', summary: null,
          slug: null, visibility: 'public', allowSearchIndexing: false, state: 'active',
          resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1',
          followedAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
          hiddenPublic: true,
        },
        {
          id: 'series-live', ownerSubjectId: 'owner-1', title: 'Weekly notes', summary: null,
          slug: 'weekly-notes', visibility: 'public', allowSearchIndexing: true, state: 'active',
          resourceRevision: 'r2', contentRevision: 'c2', policyRevision: 'p2',
          followedAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    })
    mount()
    await waitForDom(() => document.querySelector('[data-testid="library-nav-digests"]') != null)
    const nav = document.querySelector('[data-testid="library-nav-digests"]')!
    const tombstone = nav.querySelector('[data-digest-hidden]')!
    expect(tombstone.querySelector('a')).toBeNull()
    expect(tombstone.querySelector('span.library-nav-label')?.textContent).toBe('Digest hidden')
    expect(nav.querySelector('a[href="/reports/weekly-notes"]')).not.toBeNull()
    // R12-14: same section anatomy as the collection sections — a
    // collapsible head and an icon row for the create entry.
    expect(nav.querySelector('button[aria-controls="library-nav-section-digests"]')?.textContent).toBe('Digests')
    expect(nav.querySelector('a[href="/library/digests?new=1"] [data-icon="plus"]')).not.toBeNull()
    await waitForDom(domFinishedLoading)
  })

  it('shows bookmarks first and keeps edit behind More', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-workspace"]')).not.toBeNull()
    expect(document.querySelector('a[href="/library?view=reading"] [data-icon="book"]')).not.toBeNull()
    // Root layer, public-page style: the Later folder is a row, its nested
    // bookmark stays behind it instead of flattening out.
    expect(document.querySelector('[data-testid="library-main"] [data-collection-subfolder]')?.textContent).toContain('Later')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).not.toContain('First page item')
    // Subtree is 2; the root layer shows the one bookmark that lives here.
    expect(document.querySelector('[data-testid="library-kind-chip"]')).toBeNull()
    expect(document.querySelector('[data-testid="library-desk-count"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 bookmarks · 1 here')
    const navCount = document.querySelector('a[data-collection-id="col-1"] .library-nav-count')
    expect(navCount?.textContent).toBe('2 bookmarks')
    expect(navCount?.getAttribute('title')).toBe('2 bookmarks in this collection')
    // A folder row names its own container, and one bookmark is singular.
    const folderCount = document.querySelector('[data-testid="library-nav"] [data-folder-id="col-1-folder"] .library-nav-count')
    expect(folderCount?.textContent).toBe('1 bookmark')
    expect(folderCount?.getAttribute('title')).toBe('1 bookmark in this folder')
    // The desk row counts the same thing the sidebar does: subtree bookmarks.
    expect(document.querySelector('[data-testid="library-main"] [data-folder-id="col-1-folder"] .collection-folder-count')?.textContent).toBe('1 bookmark')
    expect([...document.querySelectorAll('button')].filter((button) => button.textContent === 'Add bookmark')).toHaveLength(1)
    expect(document.querySelectorAll('button[aria-label="More collection actions"]')).toHaveLength(1)
    expect(document.querySelector<HTMLInputElement>('[data-testid="library-desk-search"] input')?.placeholder).toBe('Filter by title, description, host, or folder…')
    expect(document.querySelector('[data-testid="library-desk-search"]')?.classList.contains('search-field')).toBe(true)
    expect(document.body.textContent).toContain('Loose bookmark')
    expect(document.body.textContent).not.toContain('Edit collection')
    expect(document.body.textContent).not.toContain('Select a node to edit title/URL.')
    expect(document.body.textContent).not.toContain('Fences')
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    const edit = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent === 'Edit collection')
    expect(edit).not.toBeUndefined()
    act(() => edit?.click())
    expect(document.querySelector('[data-testid="collection-settings"]')).not.toBeNull()
  })

  it('keeps a kind chip when the collection is not the bookmarks default', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.collection = { ...snap.collection, kind: 'reading_path' }
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-kind-chip"]')?.textContent).toBe('Reading path')
  })

  it('labels a knowledge collection with the full kind name', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.collection = { ...snap.collection, kind: 'knowledge_collection' }
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-kind-chip"]')?.textContent).toBe('Knowledge collection')
  })

  it('keeps the Mixed kind chip short', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.collection = { ...snap.collection, kind: 'mixed' }
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-kind-chip"]')?.textContent).toBe('Mixed')
  })

  it('renders bookmarks immediately when a sub-route remounts the desk', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    mount()

    // No settle(): the desk paints from the cache on its very first frame,
    // so neither the loading state nor an empty shelf is ever shown.
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
    expect(document.body.textContent).not.toContain('Loading bookmarks…')
    await waitForDom(domFinishedLoading)
  })

  it('revalidates a restored desk snapshot without showing a loading state', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const firstPass = mocks.loadEditorSnapshot.mock.calls.length

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    mount()
    await waitForDom(domFinishedLoading)

    expect(mocks.loadEditorSnapshot.mock.calls.length).toBeGreaterThan(firstPass)
    expect(document.body.textContent).not.toContain('Loading bookmarks…')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
  })

  it('auto-expands the selected collection and still collapses/expands by hand', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    // Sidebar-scoped: the desk folder layer also carries data-folder-id rows.
    const navFolder = (id: string) =>
      document.querySelector(`[data-testid="library-nav"] [data-folder-id="${id}"]`)
    // Selection expands the first folder level without an extra Expand click.
    expect(navFolder('col-1-folder')?.textContent).toContain('Later')
    const collapse = document.querySelector<HTMLButtonElement>('button[aria-label="Collapse Reading queue"]')
    expect(collapse).not.toBeNull()
    act(() => collapse?.click())
    expect(navFolder('col-1-folder')).toBeNull()
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Expand Reading queue"]')?.click()
    })
    expect(navFolder('col-1-folder')?.textContent).toContain('Later')
  })

  it('remembers a manual collapse when the collection is selected again', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const navFolder = (id: string) =>
      document.querySelector(`[data-testid="library-nav"] [data-folder-id="${id}"]`)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Collapse Reading queue"]')?.click()
    })
    expect(navFolder('col-1-folder')).toBeNull()
    act(() => {
      document.querySelector<HTMLAnchorElement>('a[data-collection-id="col-2"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    // The newly selected collection auto-expands…
    expect(navFolder('col-2-folder')?.textContent).toContain('Later')
    act(() => {
      document.querySelector<HTMLAnchorElement>('a[data-collection-id="col-1"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    // …but the manually collapsed one stays collapsed on reselection.
    expect(navFolder('col-1-folder')).toBeNull()
    expect(document.querySelector('button[aria-label="Expand Reading queue"]')).not.toBeNull()
  })

  it('keeps the parent collection current when a selected folder is collapsed', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLAnchorElement>('a[data-folder-id="col-1-folder"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Collapse Reading queue"]')?.click()
    })
    expect(document.querySelector('[data-folder-id="col-1-folder"]')).toBeNull()
    expect(document.querySelector('a[data-collection-id="col-1"]')?.closest('.library-nav-row')?.classList.contains('is-current')).toBe(true)
  })

  it('filters bookmarks when a folder is selected', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLAnchorElement>('a[data-folder-id="col-1-folder"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('First page item')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).not.toContain('Loose bookmark')
    // The folder's subtree is that one bookmark, so there is no separate "here".
    expect(document.querySelector('[data-testid="library-desk-count"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 bookmark')
  })

  it('drills through nested folders with desk rows, a breadcrumb, and a recursive sidebar', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = [
      ...snap.nodes,
      {
        ...snap.nodes[0]!,
        id: 'col-1-sub',
        parentId: 'col-1-folder',
        position: 'b',
        title: 'Archive',
        etag: '"f-sub"',
      },
      extraBookmark('col-1-deep', 'col-1', 'col-1-sub', 'a', 'Deep bookmark'),
    ]
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mount()
    await waitForDom(domFinishedLoading)

    // Root layer: the Later folder row, the loose bookmark, nothing deeper.
    const deskFolderRow = () =>
      document.querySelector<HTMLAnchorElement>('[data-testid="library-main"] [data-collection-subfolder]')
    expect(deskFolderRow()?.textContent).toContain('Later')
    expect(document.body.textContent).not.toContain('Deep bookmark')

    // Enter Later: its direct bookmark plus the Archive subfolder row.
    act(() => deskFolderRow()?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-main"] h1')?.textContent).toBe('Later')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('First page item')
    expect(deskFolderRow()?.textContent).toContain('Archive')

    // Enter Archive: nested layer with a breadcrumb back through Later.
    act(() => deskFolderRow()?.click())
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-main"] h1')?.textContent).toBe('Archive')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Deep bookmark')
    const trail = document.querySelector('[data-testid="library-folder-trail"]')
    expect(trail?.textContent).toContain('Reading queue')
    expect(trail?.textContent).toContain('Later')
    expect(trail?.querySelector('[aria-current="location"]')?.textContent).toBe('Archive')

    // Sidebar: the chain to the nested folder is disclosed recursively.
    expect(document.querySelector('[data-testid="library-nav"] [data-folder-id="col-1-sub"]')).not.toBeNull()

    // The breadcrumb climbs back one level.
    act(() => {
      [...(trail?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
        .find((link) => link.textContent === 'Later')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-main"] h1')?.textContent).toBe('Later')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('First page item')
  })

  it('renders annotation-backed TL;DR and note snippets on comfort rows only', async () => {
    mocks.loadAnnotations.mockImplementation(async (
      _collectionId: string,
      subject: { resourceId: string },
    ) => (subject.resourceId === 'col-1-loose'
      ? [
          { id: 'an-1', type: 'tldr', visibility: 'private', value: 'Machine summary of the loose page' },
          { id: 'an-2', type: 'note', visibility: 'private', value: 'Re-read before the sync meeting' },
        ]
      : []))
    mount()
    await waitForDom(domFinishedLoading)
    await waitForDom(() => document.querySelector('[data-testid="bookmark-tldr"]') != null)

    const row = document.querySelector('[data-testid="library-bookmarks"] [data-node-id="col-1-loose"]')
    expect(row?.querySelector('[data-testid="bookmark-tldr"]')?.textContent).toContain('Machine summary of the loose page')
    expect(row?.querySelector('[data-testid="bookmark-note"]')?.textContent).toContain('Re-read before the sync meeting')
    // Only the visible layer is looked up — one subject per bookmark row.
    expect(mocks.loadAnnotations).toHaveBeenCalledWith(
      'col-1',
      expect.objectContaining({ resourceType: 'node', resourceId: 'col-1-loose' }),
      expect.anything(),
    )

    // Compact keeps rows single-register: no snippets, no extra lookups.
    mocks.loadAnnotations.mockClear()
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Compact') button.click()
      })
    })
    expect(document.querySelector('[data-testid="library-bookmarks"][data-density="compact"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="bookmark-tldr"]')).toBeNull()
    expect(document.querySelector('[data-testid="bookmark-note"]')).toBeNull()
    expect(mocks.loadAnnotations).not.toHaveBeenCalled()
  })

  it('opens the source from the row but sends annotation snippets to full details', async () => {
    mocks.loadAnnotations.mockImplementation(async (
      _collectionId: string,
      subject: { resourceId: string },
    ) => (subject.resourceId === 'col-1-loose'
      ? [{ id: 'an-1', type: 'tldr', visibility: 'private', value: 'Full details live here' }]
      : []))
    mount()
    await waitForDom(() => document.querySelector('[data-testid="bookmark-tldr"]') != null)

    const primary = document.querySelector<HTMLAnchorElement>('a[data-node-id="col-1-loose"]')
    expect(primary?.getAttribute('href')).toBe('https://loose.example/')
    expect(primary?.getAttribute('target')).toBe('_blank')
    act(() => {
      document.querySelector<HTMLElement>('[data-testid="bookmark-tldr"]')?.click()
    })
    expect(document.querySelector('[data-testid="location"]')?.textContent).toBe('/r/col-1-loose?collectionId=col-1&subjectType=node')
  })

  it('matches bookmark descriptions in the desk filter', async () => {
    const snap = snapshot('col-1', 'Reading queue')
    snap.nodes = snap.nodes.map((node) => (node.id === 'col-1-loose'
      ? { ...node, description: 'Weekly digest of inference engines' }
      : node))
    mocks.loadEditorSnapshot.mockImplementation((id: string) =>
      Promise.resolve(id === 'col-1' ? snap : snapshot(id, 'Second shelf')))
    mount()
    await waitForDom(domFinishedLoading)

    filterDesk('digest')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
    expect(document.body.textContent).toContain('1 bookmark match')
  })

  it('scrolls the desk to the top when entering a folder layer', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    act(() => {
      document.querySelector<HTMLAnchorElement>('[data-testid="library-main"] [data-collection-subfolder]')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-main"] h1')?.textContent).toBe('Later')
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
    scrollSpy.mockRestore()
  })

  it('loads another collection tree when its folder row is expanded', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-folder-id="col-2-folder"]')).toBeNull()
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Expand Second shelf"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-folder-id="col-2-folder"]')?.textContent).toContain('Later')
    expect(mocks.loadEditorSnapshot).toHaveBeenCalledWith('col-2', expect.anything())
  })

  it('switches collections without remounting the tree and auto-expands the next one', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    const firstLink = document.querySelector('a[data-collection-id="col-1"]')
    const nav = document.querySelector('[aria-label="Collection folders"]')
    expect(document.querySelector('button[aria-label="Collapse Reading queue"]')).not.toBeNull()
    expect(document.querySelector('button[aria-label="Expand Second shelf"]')).not.toBeNull()
    expect(document.querySelector('[data-folder-id="col-2-folder"]')).toBeNull()
    act(() => {
      document.querySelector<HTMLAnchorElement>('a[data-collection-id="col-2"]')?.click()
    })
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="library-main"] h1')?.textContent).toBe('Second shelf')
    expect(document.querySelector('[data-testid="library-bookmarks"]')?.textContent).toContain('Loose bookmark')
    expect(document.querySelector('a[data-collection-id="col-1"]')).toBe(firstLink)
    expect(document.querySelector('[aria-label="Collection folders"]')).toBe(nav)
    // Selecting a collection expands its first folder level automatically.
    expect(document.querySelector('[data-folder-id="col-2-folder"]')?.textContent).toContain('Later')
    expect(document.querySelector('button[aria-label="Collapse Second shelf"]')).not.toBeNull()
    expect(document.querySelector('a[data-collection-id="col-2"]')?.closest('.library-nav-row')?.classList.contains('is-current')).toBe(true)
  })

  it('opens the add-bookmark form from More instead of the editor', async () => {
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Add bookmark') button.click()
      })
    })
    expect(document.querySelector('[data-testid="library-compose"]')).not.toBeNull()
    setControlValue(document.getElementById('lc-title') as HTMLInputElement, 'New bookmark')
    setControlValue(document.getElementById('lc-url') as HTMLInputElement, 'https://added.example')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="library-compose"]')?.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.createCollectionNode).toHaveBeenCalled()
  })

  function openBookmarkCompose() {
    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-label="More collection actions"]')?.click()
    })
    act(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (button.textContent === 'Add bookmark') button.click()
      })
    })
  }

  it('leads the bookmark compose with URL and derives an empty title from the host', async () => {
    mocks.createCollectionNode.mockResolvedValue({})
    mount()
    await waitForDom(domFinishedLoading)
    openBookmarkCompose()
    const url = document.getElementById('lc-url') as HTMLInputElement
    const title = document.getElementById('lc-title') as HTMLInputElement
    // URL comes first in the form; the title is explicitly optional.
    expect(url.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('label[for="lc-title"]')?.textContent).toBe('Title (optional)')
    expect(document.activeElement).toBe(url)
    setControlValue(url, 'https://www.example.com/some/page')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="library-compose"]')?.requestSubmit()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.createCollectionNode).toHaveBeenCalledWith(
      'col-1',
      expect.objectContaining({
        node: expect.objectContaining({
          kind: 'bookmark',
          title: 'example.com',
          url: 'https://www.example.com/some/page',
        }),
      }),
      expect.anything(),
    )
    expect(mocks.success).toHaveBeenCalledWith('Bookmark created')
  })

  it('shows inline URL validation with role=alert instead of a toast', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openBookmarkCompose()
    const url = document.getElementById('lc-url') as HTMLInputElement
    // The default "https://" has no host and must not pass validation.
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="library-compose"]')?.requestSubmit()
      await Promise.resolve()
    })
    expect(mocks.createCollectionNode).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(url.getAttribute('aria-invalid')).toBe('true')
    const alert = document.querySelector('[data-testid="library-compose"] [role="alert"]')
    expect(alert?.textContent).toBe('Enter a valid URL')
    expect(alert?.id).toBe('lc-url-error')
    expect(url.getAttribute('aria-describedby')).toBe('lc-url-error')
    // Typing clears the inline error.
    setControlValue(url, 'https://fixed.example')
    expect(document.querySelector('[data-testid="library-compose"] [role="alert"]')).toBeNull()
    expect(url.getAttribute('aria-invalid')).toBeNull()
  })

  it('rejects an empty or non-http URL inline', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    openBookmarkCompose()
    const url = document.getElementById('lc-url') as HTMLInputElement
    setControlValue(url, '   ')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="library-compose"]')?.requestSubmit()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="library-compose"] [role="alert"]')?.textContent).toBe('URL is required')
    setControlValue(url, 'ftp://files.example')
    await act(async () => {
      document.querySelector<HTMLFormElement>('[data-testid="library-compose"]')?.requestSubmit()
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="library-compose"] [role="alert"]')?.textContent).toBe('URL must be http or https')
    expect(mocks.createCollectionNode).not.toHaveBeenCalled()
  })
})
