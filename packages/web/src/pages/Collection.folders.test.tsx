// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicCollectionNode } from '../api/types'
import { collectLayeredRules, readStyle } from '../styles/dashboard-stack-cascade.test-helper'
import { cleanup, domFinishedLoading, waitForDom } from '../test/render'
import {
  bookmark,
  captureSearch,
  mocks,
  navigateBack,
  renderCollection,
  rootNode,
  setUpCollectionPage,
  snapshot,
  tearDownCollectionPage,
  textOutsideFolderCards,
} from './Collection.test-helper'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  const { mocks } = await import('./Collection.test-mocks')
  return {
    ...actual,
    isCommunityExposureEnabled: () => false,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      recordPublicCollectionInsightEvent: mocks.recordPublicCollectionInsightEvent,
      getPublicProfilePage: mocks.getPublicProfilePage,
      getFollowersPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getFollowingPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      isFollowingProfile: mocks.isFollowingProfile,
      followProfile: mocks.followProfile,
      unfollowProfile: mocks.unfollowProfile,
      abandonFollowIntent: mocks.abandonFollowIntent,
      getCollectionFollowState: mocks.getCollectionFollowState,
      followCollection: mocks.followCollection,
      unfollowCollection: mocks.unfollowCollection,
      abandonCollectionFollowIntent: mocks.abandonCollectionFollowIntent,
    },
  }
})

vi.mock('../components/AppToast', async () => {
  const { mocks } = await import('./Collection.test-mocks')
  return {
    useToast: () => ({ toast: mocks.toast, success: mocks.success, error: mocks.error }),
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' },
    isLoggedIn: true,
    bootstrapping: false,
  }),
}))

describe('public Collection page folder navigation', () => {
  beforeEach(setUpCollectionPage)
  afterEach(tearDownCollectionPage)

  it('keeps a 12-level hierarchy reachable: root shows one layer, the outline jumps to the deepest', async () => {
    const nodes: PublicCollectionNode[] = [rootNode()]
    for (let index = 0; index < 250; index += 1) {
      nodes.push(bookmark(`Wide reference ${index}`))
    }
    let parentId = 'root-1'
    for (let depth = 0; depth < 12; depth += 1) {
      const id = `folder-${depth}`
      nodes.push({
        id, parentId, kind: 'folder', title: `Level ${depth}`,
        description: null, url: null, position: String(depth),
      })
      parentId = id
    }
    nodes.push(bookmark('Deep reference', parentId))
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(nodes))

    renderCollection()
    await waitForDom(domFinishedLoading)

    // Root layer: the 250 loose bookmarks plus only the first-level folder;
    // the deep bookmark stays behind its folder instead of flattening out.
    expect(document.querySelectorAll('[data-collection-resource]')).toHaveLength(250)
    expect(document.querySelectorAll('[data-collection-subfolder]')).toHaveLength(1)
    expect(textOutsideFolderCards()).not.toContain('Deep reference')
    // The outline starts collapsed at the first level; the deeper 11 levels
    // stay behind disclosure toggles instead of flooding the page.
    expect(document.querySelectorAll('[data-collection-folder]')).toHaveLength(1)
    for (let depth = 0; depth < 11; depth += 1) {
      const toggle = document.querySelector<HTMLButtonElement>(
        `button[aria-label="Expand Level ${depth}"]`,
      )
      if (!toggle) throw new Error(`Level ${depth} outline toggle missing`)
      await act(async () => toggle.click())
    }
    // Fully disclosed, the outline lists the entire 12-level tree as shortcuts.
    expect(document.querySelectorAll('[data-collection-folder]')).toHaveLength(12)

    const deepest = [...document.querySelectorAll<HTMLButtonElement>('[data-collection-folder]')]
      .find((element) => element.textContent === 'Level 11')
    if (!deepest) throw new Error('Level 11 outline chip missing')
    await act(async () => deepest.click())

    expect(document.querySelectorAll('[data-collection-resource]')).toHaveLength(1)
    expect(document.body.textContent).toContain('Deep reference')
    const deepTitle = [...document.querySelectorAll('[data-collection-resource-title]')]
      .find((element) => element.textContent === 'Deep reference')
    expect(deepTitle?.closest('[data-collection-resource]')?.getAttribute('data-depth')).toBe('12')
    // Breadcrumb: collection title plus the 11 ancestors, all links, led by
    // the icon-only back-one-level button.
    expect(document.querySelectorAll('[data-collection-trail] a:not([data-collection-trail-back])')).toHaveLength(12)
    expect(document.querySelector('[data-collection-trail] a[data-collection-trail-back]')).not.toBeNull()
    expect(document.querySelector('[data-collection-trail-current]')?.textContent).toBe('Level 11')
  })

  it('outline opens one folder layer, q searches its subtree, and re-clicking the active folder stays put', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      { id: 'folder-classics', parentId: 'folder-papers', kind: 'folder', title: 'Classics', description: null, url: null, position: '0' },
      bookmark('Nested classic survey', 'folder-classics'),
      bookmark('Direct paper note', 'folder-papers'),
      // Title contains the folder name but the bookmark sits in the root:
      // strict id membership must not leak it into the folder layer/search.
      bookmark('Papers digest weekly'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const folderButton = [...document.querySelectorAll<HTMLButtonElement>('[data-collection-folder]')]
      .find((candidate) => candidate.textContent?.trim() === 'Papers')
    if (!folderButton) throw new Error('Papers folder button missing')
    // Collapsed by default: the nested Classics chip only appears once the
    // visitor stands in (or discloses) Papers.
    expect([...document.querySelectorAll('[data-collection-folder]')].map((el) => el.textContent))
      .toEqual(['Papers'])

    await act(async () => folderButton.click())
    expect(folderButton.getAttribute('aria-current')).toBe('true')
    expect(captureSearch).toContain('folder=folder-papers')
    // Standing in Papers auto-expands its outline chain.
    expect([...document.querySelectorAll('[data-collection-folder]')].map((el) => el.textContent))
      .toEqual(['Papers', 'Classics'])
    // One layer: the direct bookmark and the Classics subfolder card —
    // the nested bookmark stays a level further down.
    expect(document.body.textContent).toContain('Direct paper note')
    expect(document.querySelector('[data-collection-subfolder]')?.textContent).toContain('Classics')
    expect(textOutsideFolderCards()).not.toContain('Nested classic survey')
    expect(document.body.textContent).not.toContain('Papers digest weekly')

    // q searches the whole Papers subtree, descendants included.
    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter bookmarks"]')
    if (!input) throw new Error('Filter input missing')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'classic')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(captureSearch).toContain('folder=folder-papers')
    expect(captureSearch).toContain('q=classic')
    expect(document.body.textContent).toContain('Nested classic survey')
    expect(document.body.textContent).not.toContain('Direct paper note')

    // Clearing q lands back on the same layer; re-clicking the active
    // outline chip does not jump to the root. The trail is how you go up.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.textContent).toContain('Direct paper note')
    await act(async () => folderButton.click())
    expect(folderButton.getAttribute('aria-current')).toBe('true')
    expect(captureSearch).toContain('folder=folder-papers')
    expect(document.body.textContent).not.toContain('Papers digest weekly')
  })

  it('auto-expands the outline chain of a deep link and lets the visitor collapse it again', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      { id: 'folder-classics', parentId: 'folder-papers', kind: 'folder', title: 'Classics', description: null, url: null, position: '0' },
      { id: 'folder-vintage', parentId: 'folder-classics', kind: 'folder', title: 'Vintage', description: null, url: null, position: '0' },
      { id: 'folder-tools', parentId: 'root-1', kind: 'folder', title: 'Tools', description: null, url: null, position: '1' },
      bookmark('Classic survey', 'folder-classics'),
    ]))
    renderCollection('/c/research-notes?folder=folder-classics')
    await waitForDom(domFinishedLoading)

    // The chain to the linked folder is disclosed (Vintage is a child layer
    // of the current folder); the unrelated root stays a collapsed sibling.
    expect([...document.querySelectorAll('[data-collection-folder]')].map((el) => el.textContent))
      .toEqual(['Papers', 'Classics', 'Vintage', 'Tools'])

    const collapse = document.querySelector<HTMLButtonElement>('button[aria-label="Collapse Papers"]')
    if (!collapse) throw new Error('Papers collapse toggle missing')
    await act(async () => collapse.click())
    // Manual collapse wins over the auto-expansion and hides the subtree.
    expect([...document.querySelectorAll('[data-collection-folder]')].map((el) => el.textContent))
      .toEqual(['Papers', 'Tools'])
    expect(document.querySelector('button[aria-label="Expand Papers"]')).not.toBeNull()

    // The drill-down layer itself is untouched by outline disclosure.
    expect(document.body.textContent).toContain('Classic survey')
  })

  it('shows only first-level folders and loose bookmarks on the root layer', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-guides', parentId: 'root-1', kind: 'folder', title: 'Guides', description: null, url: null, position: '0' },
      bookmark('Nested guide', 'folder-guides'),
      bookmark('Loose bookmark'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const card = document.querySelector('[data-collection-subfolder]')
    expect(card?.textContent).toContain('Guides')
    // A folder card counts the bookmarks filed anywhere below it.
    expect(card?.textContent).toContain('1 bookmark')
    expect(document.body.textContent).toContain('Loose bookmark')
    expect(textOutsideFolderCards()).not.toContain('Nested guide')
    // Root layer renders no breadcrumb trail — the masthead title is the root.
    expect(document.querySelector('[data-collection-trail]')).toBeNull()
    // Public folder rows stay plain links: no desk ⋯ actions leak in (FE-05).
    expect(document.querySelector('[data-testid="folder-actions"]')).toBeNull()
    expect(document.querySelector('button[aria-label^="Actions for"]')).toBeNull()
  })

  it('drills down three layers through folder cards and climbs back via the breadcrumb', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Level one', description: null, url: null, position: '0' },
      { id: 'folder-2', parentId: 'folder-1', kind: 'folder', title: 'Level two', description: null, url: null, position: '0' },
      { id: 'folder-3', parentId: 'folder-2', kind: 'folder', title: 'Level three', description: null, url: null, position: '0' },
      bookmark('Root note'),
      bookmark('One note', 'folder-1'),
      bookmark('Two note', 'folder-2'),
      bookmark('Three note', 'folder-3'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const enterFolder = async (title: string) => {
      const card = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-subfolder]')]
        .find((candidate) => candidate.textContent?.includes(title))
      if (!card) throw new Error(`${title} folder card missing`)
      await act(async () => card.click())
    }

    await enterFolder('Level one')
    expect(captureSearch).toContain('folder=folder-1')
    expect(document.body.textContent).toContain('One note')
    expect(document.body.textContent).not.toContain('Root note')

    await enterFolder('Level two')
    await enterFolder('Level three')
    expect(captureSearch).toContain('folder=folder-3')
    expect(document.body.textContent).toContain('Three note')
    expect(document.body.textContent).not.toContain('Two note')

    // Breadcrumb: title / Level one / Level two are links; Level three is current.
    const crumbs = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-trail] a:not([data-collection-trail-back])')]
    expect(crumbs.map((link) => link.textContent)).toEqual(['Research notes', 'Level one', 'Level two'])
    expect(document.querySelector('[data-collection-trail-current]')?.textContent).toBe('Level three')

    // The back arrow is a visual affordance off the tab order (the parent
    // crumb in the path is the one control), and still climbs one level.
    const backLink = document.querySelector<HTMLAnchorElement>('[data-collection-trail-back]')
    expect(backLink?.getAttribute('aria-hidden')).toBe('true')
    expect(backLink?.getAttribute('tabindex')).toBe('-1')
    expect(backLink?.getAttribute('href')).toContain('folder=folder-2')

    // Crumbs truncate via CSS; the full text stays reachable through title=.
    expect(crumbs.every((link) => link.getAttribute('title') === link.textContent)).toBe(true)
    expect(document.querySelector('[data-collection-trail-current]')?.getAttribute('title')).toBe('Level three')
    const trailRules = collectLayeredRules(readStyle('pages-shared.css'))
    const crumbRule = trailRules.find((rule) => rule.selector === '.folder-trail a:not(.trail-back)' && !rule.media)
    expect(crumbRule?.body).toMatch(/max-width:\s*12ch/)
    const currentRule = trailRules.find((rule) => (
      rule.selector === '.folder-trail span.folder-trail-current' && !rule.media
    ))
    expect(currentRule?.body).toMatch(/max-width:\s*18ch/)

    const levelOneCrumb = crumbs.find((link) => link.textContent === 'Level one')
    if (!levelOneCrumb) throw new Error('Level one crumb missing')
    await act(async () => levelOneCrumb.click())
    expect(captureSearch).toContain('folder=folder-1')
    expect(document.body.textContent).toContain('One note')

    const titleCrumb = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-trail] a')]
      .find((link) => link.textContent === 'Research notes')
    if (!titleCrumb) throw new Error('title crumb missing')
    await act(async () => titleCrumb.click())
    expect(captureSearch).not.toContain('folder=')
    expect(document.body.textContent).toContain('Root note')
    expect(document.querySelector('[data-collection-trail]')).toBeNull()
  })

  it('retraces pushed folder layers with Back while q edits stay replace-only', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Level one', description: null, url: null, position: '0' },
      { id: 'folder-2', parentId: 'folder-1', kind: 'folder', title: 'Level two', description: null, url: null, position: '0' },
      bookmark('Root note'),
      bookmark('One note', 'folder-1'),
      bookmark('Two note', 'folder-2'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const enterFolder = async (title: string) => {
      const card = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-subfolder]')]
        .find((candidate) => candidate.textContent?.includes(title))
      if (!card) throw new Error(`${title} folder card missing`)
      await act(async () => card.click())
    }

    await enterFolder('Level one')
    await enterFolder('Level two')
    expect(captureSearch).toContain('folder=folder-2')

    // Typing q replaces the current history entry instead of pushing one.
    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter bookmarks"]')
    if (!input) throw new Error('Filter input missing')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'two')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(captureSearch).toContain('q=two')

    // One Back step skips the replaced q edit and lands on the parent layer.
    await act(async () => navigateBack())
    expect(captureSearch).toContain('folder=folder-1')
    expect(captureSearch).not.toContain('q=')
    expect(document.body.textContent).toContain('One note')

    // Second Back step returns to the root layer.
    await act(async () => navigateBack())
    expect(captureSearch).not.toContain('folder=')
    expect(document.body.textContent).toContain('Root note')
  })

  it('scrolls folder hops to the top of the layer and restores the saved position on Back', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-1', parentId: 'root-1', kind: 'folder', title: 'Level one', description: null, url: null, position: '0' },
      bookmark('Root note'),
      bookmark('One note', 'folder-1'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    // Simulate the visitor scrolling the root layer before drilling in: the
    // NavigationScrollManager records window.scrollY against the current
    // history entry (rAF-throttled, so flush one frame to land the save).
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true })
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    const scrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const card = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-subfolder]')]
      .find((candidate) => candidate.textContent?.includes('Level one'))
    if (!card) throw new Error('Level one folder card missing')
    await act(async () => card.click())
    expect(document.body.textContent).toContain('One note')
    expect(scrollSpy).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })

    // The spy swallows the real scroll, so park the folder layer at its top
    // by hand — otherwise the next save would store 640 under the new entry.
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })

    // Browser Back (POP) restores the position saved for the root entry.
    scrollSpy.mockClear()
    await act(async () => navigateBack())
    expect(document.body.textContent).toContain('Root note')
    expect(scrollSpy).toHaveBeenCalledWith({ top: 640, behavior: 'instant' })
    scrollSpy.mockRestore()
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true })
  })

  it('hydrates a direct ?folder= link into that layer and ignores unknown ids', async () => {
    const publishedNodes: PublicCollectionNode[] = [
      rootNode(),
      { id: 'folder-a', parentId: 'root-1', kind: 'folder', title: 'Archive', description: null, url: null, position: '0' },
      bookmark('Archived note', 'folder-a'),
      bookmark('Front note'),
    ]
    // The published snapshot is the endpoint's steady state: every read —
    // including the remount below — is served the same published tree.
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot(publishedNodes))
    renderCollection('/c/research-notes?folder=folder-a')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Archived note')
    expect(document.body.textContent).not.toContain('Front note')
    expect(document.querySelector('[data-collection-trail-current]')?.textContent).toBe('Archive')

    cleanup()
    document.body.innerHTML = '<div id="test-root"></div>'
    renderCollection('/c/research-notes?folder=not-a-folder')
    await waitForDom(domFinishedLoading)

    // Unknown ids fall back to the root layer, exactly like before.
    expect(document.body.textContent).toContain('Front note')
    expect(textOutsideFolderCards()).not.toContain('Archived note')
    expect(document.querySelector('[data-collection-trail]')).toBeNull()
  })

  it('enters folders and returns in list and compact views through row links', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-a', parentId: 'root-1', kind: 'folder', title: 'Archive', description: null, url: null, position: '0' },
      bookmark('Archived note', 'folder-a'),
      bookmark('Front note'),
    ]))
    renderCollection('/c/research-notes?view=list')
    await waitForDom(domFinishedLoading)

    // The folder outline is no longer hidden in list/compact views.
    expect(document.querySelector('[aria-label="Collection folders"]')).not.toBeNull()

    const row = document.querySelector<HTMLAnchorElement>('[data-collection-folder-layer] [data-collection-subfolder]')
    if (!row) throw new Error('folder row missing')
    await act(async () => row.click())
    expect(captureSearch).toContain('view=list')
    expect(captureSearch).toContain('folder=folder-a')
    expect(document.body.textContent).toContain('Archived note')
    expect(document.body.textContent).not.toContain('Front note')

    // Compact keeps the same navigation, rows in the joined shell.
    const compactButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Compact')
    if (!compactButton) throw new Error('Compact button missing')
    await act(async () => compactButton.click())
    expect(document.querySelector('[data-testid="public-collection-page"]')?.getAttribute('data-view')).toBe('compact')

    const backCrumb = [...document.querySelectorAll<HTMLAnchorElement>('[data-collection-trail] a')]
      .find((link) => link.textContent === 'Research notes')
    if (!backCrumb) throw new Error('breadcrumb root link missing')
    await act(async () => backCrumb.click())
    expect(captureSearch).not.toContain('folder=')
    expect(document.querySelector('[data-collection-folder-layer] [data-collection-subfolder]')).not.toBeNull()
    expect(document.body.textContent).toContain('Front note')
  })

  it('searches descendants from the current folder and shows subtree-relative paths', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      { id: 'folder-classics', parentId: 'folder-papers', kind: 'folder', title: 'Classics', description: null, url: null, position: '0' },
      bookmark('Nested classic survey', 'folder-classics'),
    ]))
    renderCollection('/c/research-notes?folder=folder-papers&q=survey')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Nested classic survey')
    const card = document.querySelector('[data-collection-resource]')
    expect(card?.textContent).toContain('Classics')
    // Relative to the Papers layer — the current folder is not repeated.
    expect(card?.textContent).not.toContain('Papers')
  })

  it('renders an empty state inside a folder with no published children', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-empty', parentId: 'root-1', kind: 'folder', title: 'Unfiled', description: null, url: null, position: '0' },
      bookmark('Only root entry'),
    ]))
    renderCollection('/c/research-notes?folder=folder-empty')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('This folder is empty')
    const back = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Back to Research notes')
    if (!back) throw new Error('Back button missing')
    await act(async () => back.click())
    expect(captureSearch).not.toContain('folder=')
    expect(document.body.textContent).toContain('Only root entry')
  })

  it('clears the search from the filter-empty state and keeps the folder', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-empty', parentId: 'root-1', kind: 'folder', title: 'Unfiled', description: null, url: null, position: '0' },
      bookmark('Only root entry'),
    ]))
    renderCollection('/c/research-notes?folder=folder-empty&q=nothing')
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('No bookmarks match')
    expect(document.body.textContent).toContain('Nothing in this folder matches “nothing”.')
    expect(document.body.textContent).not.toContain('Searching the items loaded so far')
    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === 'Clear search')
    if (!clear) throw new Error('Clear search button missing')
    await act(async () => clear.click())
    expect(captureSearch).toContain('folder=folder-empty')
    expect(captureSearch).not.toContain('q=')
    expect(document.body.textContent).toContain('This folder is empty')
    expect(document.body.textContent).not.toContain('Only root entry')
  })

  it('keeps the count chip for searches and counts a folder subtree in its head', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot([
      rootNode(),
      { id: 'folder-papers', parentId: 'root-1', kind: 'folder', title: 'Papers', description: null, url: null, position: '0' },
      { id: 'folder-classics', parentId: 'folder-papers', kind: 'folder', title: 'Classics', description: null, url: null, position: '0' },
      { id: 'folder-tools', parentId: 'folder-papers', kind: 'folder', title: 'Tools', description: null, url: null, position: '1' },
      bookmark('Direct paper', 'folder-papers'),
      bookmark('Nested classic', 'folder-classics'),
      bookmark('Root digest'),
    ]))
    renderCollection()
    await waitForDom(domFinishedLoading)

    const toolbarText = () => document.querySelector('[data-testid="collection-toolbar"]')?.textContent ?? ''
    expect(document.body.textContent).not.toContain('Public view')
    expect(toolbarText()).not.toMatch(/\d+ (of \d+ )?bookmarks?/)

    const input = document.querySelector<HTMLInputElement>('[aria-label="Filter bookmarks"]')
    if (!input) throw new Error('Filter input missing')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'nested')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(toolbarText()).toContain('1 of 3 bookmarks')

    const clear = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Clear')
    await act(async () => { clear?.click() })
    expect(toolbarText()).not.toMatch(/\d+ (of \d+ )?bookmarks?/)

    const folderButton = [...document.querySelectorAll<HTMLButtonElement>('[data-collection-folder]')]
      .find((candidate) => candidate.textContent?.trim() === 'Papers')
    if (!folderButton) throw new Error('Papers folder button missing')
    await act(async () => { folderButton.click() })
    // The folder head states the subtree — both bookmarks below Papers (one
    // inside Classics) and both subfolders — so the chip stays off until a
    // search needs a tally.
    const head = document.querySelector('[data-collection-layer-head]')
    expect(head?.querySelector('h2')?.textContent).toBe('Papers')
    expect(head?.textContent).toContain('2 bookmarks')
    expect(head?.textContent).toContain('2 folders')
    expect(toolbarText()).not.toMatch(/\d+ (of \d+ )?bookmarks?/)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'nested')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(toolbarText()).toContain('1 of 2 bookmarks')
  })
})
