// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSnapshot, OwnedCollectionListItem, OwnedCollectionPage } from '../api/types'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import {
  assignCollistBindings,
  DashboardCollistContext,
  useDashboardCollist,
} from '../lib/collistBinding'
import type { Resource } from '../types/catalog'
import { CollectionListEmbed } from './CollectionListEmbed'
import embedSource from './CollectionListEmbed.tsx?raw'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  snapshot: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getOwnedCollectionsPage: mocks.page,
      loadEditorSnapshot: mocks.snapshot,
    },
  }
})

const BINDING_KEY = 'known.collist.binding.v1'

const interfaceModule: Resource = {
  id: 'd-list-interface',
  type: 'collectionlist',
  title: 'Interface Systems',
  url: '/c/interface-systems',
  summary: 'List view of a followed public collection — scroll inside the card.',
  host: 'known',
  layout: { x: 760, y: 600, w: 300, h: 200, z: 10 },
  meta: { collectionSlug: 'interface-systems', listMode: 'compact' },
}

const mlModule: Resource = {
  id: 'd-list-ml',
  type: 'collectionlist',
  title: 'ML Ops Field Notes',
  url: '/c/ml-ops-field-notes',
  summary: 'Another collection embedded as a scrollable list module.',
  host: 'known',
  layout: { x: 1080, y: 600, w: 280, h: 200, z: 11 },
  meta: { collectionSlug: 'ml-ops-field-notes', listMode: 'list' },
}

function ownedItem(
  id: string,
  title: string,
  publicationSlug: string | null,
  extras?: Pick<OwnedCollectionListItem, 'bookmarkCount'> & {
    visibility?: OwnedCollectionListItem['collection']['visibility']
    kind?: OwnedCollectionListItem['collection']['kind']
  },
): OwnedCollectionListItem {
  return {
    collection: {
      id,
      kind: extras?.kind ?? 'bookmarks',
      title,
      summary: null,
      visibility: extras?.visibility ?? 'private',
      allowSearchIndexing: false,
      publicationSlug,
      publishedAt: null,
      rootNodeId: `root-${id}`,
      revision: 'r',
      etag: '"r"',
      contentRevision: 'c',
      contentEtag: '"c"',
      policyRevision: 'p',
      policyEtag: '"p"',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    },
    capabilities: {
      updateCollection: true,
      managePublication: false,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    bookmarkCount: extras?.bookmarkCount,
  }
}

function pageOf(items: OwnedCollectionListItem[]): OwnedCollectionPage {
  return {
    items,
    page: { returnedCount: items.length, hasMore: false, nextCursor: null },
  }
}

function snapshot(id: string, title: string, bookmarkTitle: string): EditorSnapshot {
  return {
    collection: ownedItem(id, title, null).collection,
    root: {
      id: `root-${id}`,
      collectionId: id,
      kind: 'folder',
      folderRole: 'root',
      parentId: null,
      position: null,
      title: 'Root',
      description: null,
      tags: [],
      visibility: 'inherit',
      revision: '1',
      etag: `"root-${id}"`,
      readOnly: false,
      readOnlyReason: null,
      childrenRevision: '1',
      childrenEtag: `"root-c-${id}"`,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    nodes: [
      {
        id: `${id}-bm-1`,
        collectionId: id,
        kind: 'bookmark',
        title: bookmarkTitle,
        url: `https://snapshot.example/${id}`,
        description: 'From editor snapshot',
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: `"n-${id}"`,
        parentId: `root-${id}`,
        position: 'a',
        readOnly: false,
        readOnlyReason: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z',
      },
    ],
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: {
      snapshotId: `snap-${id}`,
      contentRevision: '1',
      policyRevision: '1',
      comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z',
      returnedCount: 1,
      hasMore: false,
      nextCursor: null,
    },
  }
}

function signIn() {
  applySessionView({
    authenticated: true,
    csrfToken: 'csrf',
    idleExpiresAt: '2026-08-20T01:00:00Z',
    absoluteExpiresAt: '2026-08-21T00:00:00Z',
  })
  applyMeView({
    account: { id: 'account-a', email: 'a@test' },
    profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null },
  })
}

function CollistHarness({
  moduleIds,
  children,
}: {
  moduleIds: string[]
  children: ReactNode
}) {
  const collist = useDashboardCollist(moduleIds)
  return (
    <DashboardCollistContext.Provider value={collist}>
      {children}
    </DashboardCollistContext.Provider>
  )
}

describe('assignCollistBindings', () => {
  it('keeps a saved id even when owned order changes', () => {
    const saved = { 'd-list-interface': 'col-alpha', 'd-list-ml': 'col-beta' }
    const next = assignCollistBindings(
      ['d-list-interface', 'd-list-ml'],
      ['col-beta', 'col-alpha'],
      saved,
    )
    expect(next).toEqual(saved)
  })

  it('fills empty slots from unused owned ids in list order', () => {
    const next = assignCollistBindings(
      ['d-list-interface', 'd-list-ml'],
      ['col-one', 'col-two'],
      {},
    )
    expect(next).toEqual({
      'd-list-interface': 'col-one',
      'd-list-ml': 'col-two',
    })
  })
})

/* Two different kinds of claim live in this file and they are kept apart:
 *
 * 1. Behaviour — the embed renders the bound owned collection, its snapshot
 *    rows and the library/public links, keeps the binding across a remount,
 *    and shows an honest empty slot instead of mock catalog data. Driven
 *    through the real component with the Product client mocked.
 *
 * 2. Architecture — the *absence* of a second owned-list pagination path
 *    (`useOwnedCollections` / `getOwnedCollectionsPage`), of the legacy mock
 *    catalog seeds, and of hardcoded CJK copy. None of those is observable
 *    while unused: an unreferenced fallback module or a hardcoded string in a
 *    branch that is not taken renders nothing, so no probe can falsify it. The
 *    reachable half of the same claim (the three user-facing strings) was moved
 *    into the behaviour block below.
 */
describe('CollectionListEmbed behaviour', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true
    signIn()
    mocks.page.mockResolvedValue(
      pageOf([ownedItem('col-alpha', 'Alpha Shelf', null, { bookmarkCount: 4 })]),
    )
    mocks.snapshot.mockImplementation((id: string) =>
      Promise.resolve(snapshot(id, 'Alpha Shelf', 'Alpha bookmark from editor')),
    )
  })

  afterEach(() => {
    cleanup()
    clearSession()
    localStorage.clear()
    document.body.innerHTML = ''
  })

  async function renderEmbed(moduleIds: string[], nodes: ReactNode) {
    mountTree(
        <MemoryRouter>
          <CollistHarness moduleIds={moduleIds}>{nodes}</CollistHarness>
        </MemoryRouter>,
      )
    await waitForDom(domFinishedLoading)
    await waitForDom(domFinishedLoading)
  }

  it('shows the owned title, library Open href, no /c/ for a null slug, and snapshot rows', async () => {
    await renderEmbed(['d-list-interface'], <CollectionListEmbed resource={interfaceModule} />)

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="collist-title-row"]')?.textContent).toContain('Alpha Shelf')
    })

    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('Spacing as a system')
    expect(document.body.textContent).toContain('Alpha bookmark from editor')

    const open = [...document.querySelectorAll('a')].find((el) => el.textContent?.trim() === 'Open')
    expect(open?.getAttribute('href')).toBe('/library/col-alpha')
    expect(document.querySelector('a[href^="/c/"]')).toBeNull()
    expect(document.body.innerHTML).not.toContain('/c/null')
    // StrictMode double-invokes mount effects (main.tsx wraps App in it, and
    // the helper now matches). The guarantee under test is the REQUEST — one
    // shape, no pagination loop — not React's invocation count.
    expect(new Set(mocks.page.mock.calls.map((call) => JSON.stringify(call[0]))).size).toBe(1)
    expect(mocks.page.mock.calls[0]![0]).toEqual({ limit: 30 })
    expect(mocks.snapshot).toHaveBeenCalledWith('col-alpha', expect.anything())
  })

  it('adds a public /c/{slug} link only when publicationSlug is a string', async () => {
    mocks.page.mockResolvedValue(
      pageOf([ownedItem('col-pub', 'LLM 学习路径', 'llm-learning-path', { visibility: 'public' })]),
    )
    mocks.snapshot.mockResolvedValue(
      snapshot('col-pub', 'LLM 学习路径', 'Transformer notes'),
    )
    await renderEmbed(['d-list-interface'], <CollectionListEmbed resource={interfaceModule} />)

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('LLM 学习路径')
    })

    const open = [...document.querySelectorAll('a')].find((el) => el.textContent?.trim() === 'Open')
    expect(open?.getAttribute('href')).toBe('/library/col-pub')

    act(() => {
      document.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click()
    })
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Change bound collection')
  })

  it('does not show Interface Systems when signed out', async () => {
    clearSession()
    await renderEmbed(['d-list-interface'], <CollectionListEmbed resource={interfaceModule} />)

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Sign in to view your collections')
    })

    expect(mocks.page).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('Mira Okada')
    expect(document.querySelector('a[href="/c/interface-systems"]')).toBeNull()
  })

  it('keeps the same collectionId after remount when owned order changes', async () => {
    mocks.page.mockResolvedValue(
      pageOf([
        ownedItem('col-alpha', 'Alpha Shelf', null),
        ownedItem('col-beta', 'Beta Shelf', null),
      ]),
    )
    mocks.snapshot.mockImplementation((id: string) =>
      Promise.resolve(
        snapshot(
          id,
          id === 'col-alpha' ? 'Alpha Shelf' : 'Beta Shelf',
          id === 'col-alpha' ? 'Alpha bookmark from editor' : 'Beta bookmark from editor',
        ),
      ),
    )

    await renderEmbed(
      ['d-list-interface', 'd-list-ml'],
      <>
        <CollectionListEmbed resource={interfaceModule} />
        <CollectionListEmbed resource={mlModule} />
      </>,
    )

    await vi.waitFor(() => {
      const titles = [...document.querySelectorAll('[data-testid="collist-title-row"]')].map((el) => el.textContent)
      expect(titles[0]).toContain('Alpha Shelf')
      expect(titles[1]).toContain('Beta Shelf')
    })
    expect(JSON.parse(localStorage.getItem(BINDING_KEY) ?? '{}')).toEqual({
      'd-list-interface': 'col-alpha',
      'd-list-ml': 'col-beta',
    })
    // Two embeds share one page request; the count is per-mount, not per-effect.
    expect(mocks.page.mock.calls.length).toBeGreaterThanOrEqual(1)

    cleanup()
        mocks.page.mockClear()
    mocks.snapshot.mockClear()
    mocks.page.mockResolvedValue(
      pageOf([
        ownedItem('col-beta', 'Beta Shelf', null),
        ownedItem('col-alpha', 'Alpha Shelf', null),
      ]),
    )

    await renderEmbed(
      ['d-list-interface', 'd-list-ml'],
      <>
        <CollectionListEmbed resource={interfaceModule} />
        <CollectionListEmbed resource={mlModule} />
      </>,
    )

    await vi.waitFor(() => {
      const titles = [...document.querySelectorAll('[data-testid="collist-title-row"]')].map((el) => el.textContent)
      expect(titles[0]).toContain('Alpha Shelf')
      expect(titles[1]).toContain('Beta Shelf')
    })
    expect(JSON.parse(localStorage.getItem(BINDING_KEY) ?? '{}')).toEqual({
      'd-list-interface': 'col-alpha',
      'd-list-ml': 'col-beta',
    })
  })

  it('shows No collections yet for a signed-in user with no owned collections', async () => {
    mocks.page.mockResolvedValue(pageOf([]))
    await renderEmbed(['d-list-interface'], <CollectionListEmbed resource={interfaceModule} />)

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('No collections yet')
    })
    expect(mocks.page.mock.calls[0]![0]).toEqual({ limit: 30 })
    expect(document.body.textContent).not.toContain('Interface Systems')
    expect(document.body.textContent).not.toContain('No more collections')
  })

  it('shows an empty slot instead of mock when owned is fewer than modules', async () => {
    await renderEmbed(
      ['d-list-interface', 'd-list-ml'],
      <>
        <CollectionListEmbed resource={interfaceModule} />
        <CollectionListEmbed resource={mlModule} />
      </>,
    )

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('No more collections')
    })
    expect(document.body.textContent).toContain('Alpha Shelf')
    expect(document.body.textContent).not.toContain('ML Ops Field Notes')
    expect(document.querySelector('a[href="/library/new"]')).not.toBeNull()
  })
})

describe('architecture invariants that cannot be behaviour tested', () => {
  it('keeps a second owned-list pagination path and the mock catalog seeds out of the embed', () => {
    /* `useOwnedCollections` / `getOwnedCollectionsPage` would be a second,
       independent pagination loop beside the shared collist binding — the
       embed only ever issues the one page request the behaviour test counts.
       `featuredResources` / `applyResourceMetaSeedsOnce` and the legacy-demo
       mock module are the old catalog fallbacks: unreferenced, they change
       nothing a render can see, and referencing them only shows up once the
       fallback branch is actually taken (which no configured test reaches).
       Bare identifiers with word boundaries, so an unrelated longer name or a
       formatting change cannot make this pass or fail by accident. */
    expect(embedSource).not.toMatch(/\buseOwnedCollections\b/)
    expect(embedSource).not.toMatch(/\bgetOwnedCollectionsPage\b/)
    expect(embedSource).not.toMatch(/\bfeaturedResources\b/)
    expect(embedSource).not.toMatch(/\bapplyResourceMetaSeedsOnce\b/)
    expect(embedSource).not.toMatch(/from ['"][^'"]*(?:legacy-demo|mock-data)['"]/)
    /* Hardcoded CJK copy would be untranslated UI text baked into the module;
       the CJK the embed legitimately shows (a collection title) arrives from
       the API. Non-vacuity: the scan must see the real module. */
    expect(embedSource.length).toBeGreaterThan(10_000)
    expect(embedSource).not.toMatch(/[\u4e00-\u9fff]/)
  })
})
