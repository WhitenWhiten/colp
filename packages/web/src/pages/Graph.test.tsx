// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canonicalHref, installPageMetaBaseline } from '../test/pageMeta'
import { clearRouteCache } from '../lib/routeCache'
import { ProductApiError } from '../api/errors'
import type { PublicCollectionNode, PublicCollectionSnapshot, PublicCollectionRelation } from '../api/types'
import type { PublicCollectionResource } from '../lib/publicCollectionTree'
import {
  GRAPH_DENSE_COUNT,
  Graph,
  graphTooltipOffset,
  layoutNodes,
  projectGraphPoint,
  wrapGraphLabel,
} from './Graph'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  loadPublicCollectionSnapshot: vi.fn(),
  loadRelations: vi.fn(),
  getCollectionEditorPage: vi.fn(),
  auth: {
    isLoggedIn: false,
    bootstrapping: false,
    user: null as { profileId: string } | null,
  },
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      loadPublicCollectionSnapshot: mocks.loadPublicCollectionSnapshot,
      loadRelations: mocks.loadRelations,
      getCollectionEditorPage: mocks.getCollectionEditorPage,
    },
  }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: mocks.auth.user,
    isLoggedIn: mocks.auth.isLoggedIn,
    bootstrapping: mocks.auth.bootstrapping,
    logout: async () => {},
  }),
}))

function rootNode(): PublicCollectionNode {
  return {
    id: 'root-1', parentId: null, kind: 'root', title: 'Published contents',
    description: null, url: null, position: null,
  }
}

function bookmark(
  id: string,
  title: string,
  url: string,
  position: string,
): PublicCollectionNode {
  return {
    id, parentId: 'root-1', kind: 'bookmark', title, description: `${title} notes`, url, position,
  }
}

function snapshot(): PublicCollectionSnapshot {
  return {
    collection: {
      id: 'col-public',
      slug: 'research-notes',
      title: 'Research notes',
      summary: 'A maintained map.',
      kind: 'reading_path',
      rootNodeId: 'root-1',
      owner: {
        profileId: 'bbbbbbbbbbbbbbbbbbbbbA', handle: 'curator',
        displayName: 'Curator', avatarUrl: null,
      },
      updatedAt: '2026-07-24T12:00:00.000Z',
      access: 'public',
    },
    nodes: [
      rootNode(),
      bookmark('nd-b', 'Known repo', 'https://github.com/know-n/web', '00000000000000000001'),
      bookmark('nd-c', 'Example site', 'https://example.com/post', '00000000000000000002'),
      bookmark('nd-a', 'Transformers paper', 'https://arxiv.org/abs/1706.03762', '00000000000000000000'),
    ],
    relations: [relation()],
    page: { cursor: null, hasMore: false, sequence: 1 },
  }
}

function relation(overrides: Partial<PublicCollectionRelation> = {}): PublicCollectionRelation {
  return {
    id: 'rel-out',
    fromNodeId: 'nd-a',
    toNodeId: 'nd-c',
    type: 'related',
    label: 'See also',
    ...overrides,
  }
}

function signIn() {
  mocks.auth.isLoggedIn = true
  mocks.auth.bootstrapping = false
  mocks.auth.user = { profileId: 'profile-graph' }
}

function drawnEdges(): Array<[string | null, string | null]> {
  return [...document.querySelectorAll('[data-from]')].map((edge) => [
    edge.getAttribute('data-from'),
    edge.getAttribute('data-to'),
  ])
}

function hasUndirectedEdge(from: string, to: string): boolean {
  return drawnEdges().some(([left, right]) => (
    (left === from && right === to) || (left === to && right === from)
  ))
}

function openResourceLink() {
  return [...document.querySelectorAll('aside a')].find((anchor) => (
    anchor.textContent?.includes('Open bookmark')
  ))
}

function clickNode(id: string) {
  const node = document.querySelector(`[data-node-id="${id}"]`)
  if (!node) throw new Error(`missing node ${id}`)
  act(() => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function hoverNode(id: string) {
  const node = document.querySelector(`[data-node-id="${id}"]`)
  if (!node) throw new Error(`missing node ${id}`)
  act(() => {
    node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
  })
}

function stubResources(n: number): PublicCollectionResource[] {
  return Array.from({ length: n }, (_, i) => ({
    node: bookmark(`nd-${i}`, `Title ${i}`, `https://example.com/${i}`, String(i).padStart(20, '0')),
    depth: 1,
    path: ['root-1'],
    pathIds: [],
    href: `https://example.com/${i}`,
    host: 'example.com',
  }))
}

function radiiFrom(positions: Array<{ x: number; y: number }>, width = 720, height = 520): number[] {
  const cx = width / 2
  const cy = height / 2
  return positions.map((p) => Math.hypot(p.x - cx, p.y - cy))
}

describe('layoutNodes', () => {
  it('keeps a single ring below the density threshold', () => {
    const positions = layoutNodes(stubResources(12), 720, 520)
    const radii = radiiFrom(positions)
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(40)
  })

  it('uses concentric rings at n >= 18', () => {
    const positions = layoutNodes(stubResources(GRAPH_DENSE_COUNT + 2), 720, 520)
    const radii = radiiFrom(positions)
    expect(positions).toHaveLength(GRAPH_DENSE_COUNT + 2)
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(40)
    const bands = new Set(radii.map((r) => Math.round(r / 8)))
    expect(bands.size).toBeGreaterThanOrEqual(2)
  })
})

describe('projectGraphPoint', () => {
  it('leaves the viewBox center still under zoom and shifts it by pan', () => {
    const center = { x: 360, y: 260 }
    expect(projectGraphPoint(center, { x: 0, y: 0 }, 1)).toEqual(center)
    expect(projectGraphPoint(center, { x: 0, y: 0 }, 2)).toEqual(center)
    expect(projectGraphPoint(center, { x: 40, y: -10 }, 1.5)).toEqual({ x: 400, y: 250 })
  })

  it('does not pull a centered node to the canvas edge the way (x+pan)*zoom did', () => {
    const center = { x: 360, y: 260 }
    const oldZoomed = { x: (center.x + 0) * 2, y: (center.y + 0) * 2 }
    expect(oldZoomed.x).toBe(720)
    expect(projectGraphPoint(center, { x: 0, y: 0 }, 2).x).toBe(360)
  })
})

describe('graphTooltipOffset', () => {
  it('stays in canvas space and does not jump horizontally for a vertically centered node', () => {
    const point = { x: 360, y: 80 }
    const canvas = { width: 720, height: 520 }
    const atRest = graphTooltipOffset(point, { x: 0, y: 0 }, 1, canvas)
    const zoomed = graphTooltipOffset(point, { x: 0, y: 0 }, 2, canvas)
    expect(atRest.left).toBe(zoomed.left)
    expect(atRest.left).toBeGreaterThan(12)
    expect(atRest.left).toBeLessThan(500)
  })
})

describe('wrapGraphLabel', () => {
  it('keeps short titles on one line', () => {
    expect(wrapGraphLabel('Gestalt')).toEqual(['Gestalt'])
  })

  it('wraps on word boundaries and ellipsizes the last line', () => {
    expect(wrapGraphLabel('Suggested reading path for systems', 18, 2)).toEqual([
      'Suggested reading',
      'path for systems',
    ])
    const long = wrapGraphLabel('Human-Computer Interaction as a practice', 18, 2)
    expect(long).toHaveLength(2)
    expect(long[0]).not.toContain('…')
    expect(long[1]?.endsWith('…') || (long[1]?.length ?? 0) <= 18).toBe(true)
  })
})


describe('Graph product browsing', () => {
  beforeEach(() => {
    clearRouteCache()
    vi.clearAllMocks()
    mocks.getCollectionEditorPage.mockResolvedValue({ capabilities: { updateNode: false } })
    mocks.auth.isLoggedIn = false
    mocks.auth.bootstrapping = false
    mocks.auth.user = null
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function renderGraph(path = '/graph/research-notes') {
    return mountTree(<MemoryRouter initialEntries={[path]}><Routes><Route path="/graph/:slug" element={<Graph />} /></Routes></MemoryRouter>)
  }
  async function ready() { await waitForDom(domFinishedLoading) }

  it('shows anonymous published relations without inventing adjacency edges', async () => {
    renderGraph(); await ready()
    expect(hasUndirectedEdge('nd-a', 'nd-c')).toBe(true)
    expect(hasUndirectedEdge('nd-a', 'nd-b')).toBe(false)
    expect(hasUndirectedEdge('nd-b', 'nd-c')).toBe(false)
    expect(mocks.loadRelations).not.toHaveBeenCalled()
    expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalledWith('research-notes', expect.objectContaining({ includeRelations: true }))
    expect(openResourceLink()?.getAttribute('href')).toBe('https://arxiv.org/abs/1706.03762')
  })
  it('keeps the complete graph when selecting another node', async () => {
    signIn(); renderGraph(); await ready()
    clickNode('nd-b'); await ready()
    expect(hasUndirectedEdge('nd-a', 'nd-c')).toBe(true)
    expect(document.querySelector('aside h3')?.textContent).toBe('Known repo')
    expect(document.querySelector('aside')?.textContent).toContain('No visible relations')
    expect(mocks.loadRelations).not.toHaveBeenCalled()
  })
  it('keeps sidebar relations tied to selection during hover', async () => {
    renderGraph(); await ready()
    const sidebar = document.querySelector('aside')!.textContent
    const calls = mocks.loadPublicCollectionSnapshot.mock.calls.length
    hoverNode('nd-b')
    expect(document.querySelector('aside')!.textContent).toBe(sidebar)
    expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalledTimes(calls)
  })
  it('preserves direction, labels and multiple relations between a pair', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), relations: [relation({ type: 'supports' }), relation({ id: 'reverse', fromNodeId: 'nd-c', toNodeId: 'nd-a', type: 'contradicts', label: 'Counterexample' })] })
    renderGraph(); await ready()
    const edges = [...document.querySelectorAll('path[data-relation-id]')]
    expect(edges).toHaveLength(2)
    expect(edges.every((edge) => edge.hasAttribute('marker-end'))).toBe(true)
    expect(edges[0]?.getAttribute('d')).not.toBe(edges[1]?.getAttribute('d'))
    expect(document.querySelector('aside')?.textContent).toContain('Incoming · contradicts')
    expect(document.querySelector('aside')?.textContent).toContain('Outgoing · supports')
    expect(document.querySelector('aside')?.textContent).toContain('Counterexample')
  })
  it('does not draw relations to endpoints outside the snapshot or to self', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), relations: [relation({ toNodeId: 'missing' }), relation({ id: 'self', toNodeId: 'nd-a' })] })
    renderGraph(); await ready()
    expect(drawnEdges()).toEqual([])
    expect(document.body.textContent).toContain('No visible relations yet')
  })
  it('updates selection after filtering and clears the sidebar on no matches', async () => {
    renderGraph(); await ready()
    const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
    const setQuery = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    setQuery('Known repo'); await ready()
    expect(document.querySelector('aside h3')?.textContent).toBe('Known repo')
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(1)
    setQuery('no match'); await ready()
    expect(document.querySelector('aside h3')).toBeNull()
    expect(document.body.textContent).toContain('No nodes match')
  })
  it('distinguishes an empty collection from empty search results', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), nodes: [rootNode()], relations: [] })
    renderGraph(); await ready()
    expect(document.body.textContent).toContain('No bookmarks yet')
  })
  it('shows unavailable for withdrawn collections', async () => {
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not found' }))
    renderGraph(); await ready()
    expect(document.body.textContent).toContain('Collection unavailable')
    expect(document.querySelector('[role="status"]')?.classList.contains('not-found-stage')).toBe(true)
    expect(document.querySelector('[data-testid="graph-page"]')).toBeNull()
  })
  it('surfaces load failure and retries the complete graph', async () => {
    mocks.loadPublicCollectionSnapshot.mockRejectedValue(new Error('offline'))
    renderGraph(); await ready()
    expect(document.querySelector('[role="alert"]')).not.toBeNull()
    const calls = mocks.loadPublicCollectionSnapshot.mock.calls.length
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(snapshot())
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click())
    await ready()
    expect(drawnEdges()).toHaveLength(1)
    expect(mocks.loadPublicCollectionSnapshot).toHaveBeenCalledTimes(calls + 1)
  })
  it('waits for identity bootstrap before requesting the graph', async () => {
    mocks.auth.bootstrapping = true
    renderGraph()
    expect(mocks.loadPublicCollectionSnapshot).not.toHaveBeenCalled()
  })
  it('allows keyboard selection and announces selected nodes', async () => {
    renderGraph(); await ready()
    const node = document.querySelector('[data-node-id="nd-c"]')!
    act(() => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(node.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('aside h3')?.textContent).toBe('Example site')
  })
  it('filters relation types and resets neighborhood and search together', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), relations: [relation({ type: 'supports' }), relation({ id: 'other', fromNodeId: 'nd-b', toNodeId: 'nd-c', type: 'mentions' })] })
    renderGraph(); await ready()
    const filter = document.querySelector<HTMLSelectElement>('[aria-label="Relation type filter"]')!
    act(() => { filter.value = 'supports'; filter.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(drawnEdges()).toHaveLength(1)
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(2)
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Focus neighborhood')!.click())
    expect(document.body.textContent).toContain('Show all neighborhoods')
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Clear filters')!.click())
    expect(drawnEdges()).toHaveLength(2)
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(3)
  })
  it('bounds a large canvas and can select a resource beyond its initial range', async () => {
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), nodes: [rootNode(), ...stubResources(205).map((resource) => resource.node)], relations: [] })
    renderGraph(); await ready()
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(200)
    expect(document.body.textContent).toContain('Canvas shows 200 bookmarks')
    for (let i = 0; i < 4; i += 1) act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Next')!.click())
    act(() => [...document.querySelectorAll('[aria-label="Graph bookmarks"] button')].find((button) => button.textContent === 'Title 204')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.querySelector('[data-node-id="nd-204"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('aside h3')?.textContent).toBe('Title 204')
  })
  it('fits the graph after zoom and preserves selected state', async () => {
    renderGraph(); await ready()
    clickNode('nd-c')
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click())
    // R15-41: the accessible name starts with the visible percentage.
    const fit = () => document.querySelector<HTMLButtonElement>('[aria-label$="fit graph to view"]')
    expect(fit()?.textContent).toBe('115%')
    expect(fit()?.getAttribute('aria-label')).toBe('115%, fit graph to view')
    act(() => fit()!.click())
    expect(fit()?.textContent).toBe('100%')
    expect(fit()?.getAttribute('aria-label')).toBe('100%, fit graph to view')
    expect(document.querySelector('[data-node-id="nd-c"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('restores a linked node and offers editing only with server-granted capability', async () => {
    signIn()
    mocks.getCollectionEditorPage.mockResolvedValue({ capabilities: { updateNode: true } })
    renderGraph('/graph/research-notes?node=nd-c'); await ready()
    expect(document.querySelector('aside h3')?.textContent).toBe('Example site')
    const link = [...document.querySelectorAll('aside a')].find((item) => item.textContent === 'Manage relations')!
    const url = new URL(link.getAttribute('href')!, 'https://known.test')
    expect(url.pathname).toBe('/r/nd-c')
    expect(url.searchParams.get('collectionId')).toBe('col-public')
    expect(url.searchParams.get('fromGraph')).toBe('1')
    expect(url.searchParams.get('slug')).toBe('research-notes')
  })
  it('does not offer edits to anonymous visitors or read-only members', async () => {
    renderGraph(); await ready()
    expect(mocks.getCollectionEditorPage).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Manage relations')
    cleanup(); signIn(); renderGraph(); await ready()
    expect(mocks.getCollectionEditorPage).toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Manage relations')
  })

  it('discards a member response that arrives after logout', async () => {
    signIn()
    let resolveMember!: (value: PublicCollectionSnapshot) => void
    const pending = new Promise<PublicCollectionSnapshot>((resolve) => { resolveMember = resolve })
    mocks.loadPublicCollectionSnapshot.mockReturnValue(pending)
    const mounted = renderGraph()
    mocks.auth.isLoggedIn = false
    mocks.auth.user = null
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), relations: [] })
    mounted.rerender(<MemoryRouter initialEntries={['/graph/research-notes']}><Routes><Route path="/graph/:slug" element={<Graph />} /></Routes></MemoryRouter>)
    await ready()
    await act(async () => { resolveMember({ ...snapshot(), relations: [relation({ label: 'Member-only secret' })] }); await pending })
    expect(drawnEdges()).toHaveLength(0)
    expect(document.body.textContent).not.toContain('Member-only secret')
  })
  it('keeps the canonical collection URL when selecting graph nodes', async () => {
    installPageMetaBaseline()
    renderGraph(); await ready()
    const canonical = canonicalHref()
    expect(canonical).toContain('/c/research-notes')
    // The breadcrumb names the collection it returns to.
    expect(document.querySelector('nav a[href="/c/research-notes"]')?.textContent).toBe('Research notes')
    clickNode('nd-c')
    expect(canonicalHref()).toBe(canonical)
  })
  it('keeps dense labels focused and type overflow outside the chip rail', async () => {
    const urls = ['https://github.com/a', 'https://arxiv.org/1', 'https://coursera.org/1', 'https://youtube.com/1', 'https://zhihu.com/1', 'https://reddit.com/1', 'https://x.com/1']
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), relations: [], nodes: [rootNode(), ...Array.from({ length: 20 }, (_, i) => bookmark(`nd-${i}`, `Title ${i}`, urls[i % urls.length]!, String(i).padStart(20, '0')))] })
    renderGraph(); await ready()
    expect(document.querySelector('[data-dense]')).not.toBeNull()
    hoverNode('nd-5')
    expect(document.querySelector('[data-node-id="nd-5"] [data-testid="graph-node-label"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-testid="graph-node-label"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="graph-more-types"]')?.closest('[data-testid="graph-type-chip-row"]')).toBeNull()
  })

  it('includes legal folder and root relation endpoints in the graph', async () => {
    const value = snapshot()
    value.nodes.push({ id: 'folder', parentId: 'root-1', kind: 'folder', title: 'Research folder', description: null, url: null, position: 'z' })
    value.relations = [relation({ fromNodeId: 'root-1', toNodeId: 'folder' }), relation({ id: 'folder-bookmark', fromNodeId: 'folder', toNodeId: 'nd-a' })]
    mocks.loadPublicCollectionSnapshot.mockResolvedValue(value)
    renderGraph(); await ready()
    expect(drawnEdges()).toHaveLength(2)
    expect(document.querySelector('[data-node-id="root-1"]')?.getAttribute('aria-label')).toContain('Collection:')
    clickNode('folder')
    expect(document.querySelector('aside h3')?.textContent).toBe('Research folder')
    expect(document.querySelector('aside')?.textContent).toContain('Published contents')
    expect(document.querySelector('[data-node-id="folder"]')?.getAttribute('aria-label')).toContain('Folder:')
  })
  it('withdraws stale editing capability while checking a refreshed snapshot', async () => {
    signIn()
    mocks.loadPublicCollectionSnapshot.mockImplementation(async () => snapshot())
    mocks.getCollectionEditorPage.mockResolvedValue({ capabilities: { updateNode: true } })
    renderGraph(); await ready()
    expect(document.body.textContent).toContain('Manage relations')
    let resolveAccess!: (value: unknown) => void
    mocks.getCollectionEditorPage.mockReturnValue(new Promise((resolve) => { resolveAccess = resolve }))
    act(() => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Refresh graph')!.click())
    await ready()
    expect(document.body.textContent).not.toContain('Manage relations')
    await act(async () => { resolveAccess({ capabilities: { updateNode: false } }); await Promise.resolve() })
    expect(document.body.textContent).not.toContain('Manage relations')
  })

  it('provides an empty-collection author a path to add resources', async () => {
    signIn()
    mocks.getCollectionEditorPage.mockResolvedValue({ capabilities: { updateNode: true } })
    mocks.loadPublicCollectionSnapshot.mockResolvedValue({ ...snapshot(), nodes: [rootNode()], relations: [] })
    renderGraph(); await ready()
    const add = [...document.querySelectorAll('a')].find((link) => link.textContent === 'Add bookmarks')
    expect(add?.getAttribute('href')).toBe('/library/col-public')
  })

})
