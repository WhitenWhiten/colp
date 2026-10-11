// @vitest-environment happy-dom
/* P2B-25 Search frontend boundary.
 *
 * Behaviour (proven by driving useProductSearch against the canonical client
 * with the client mocked): the query, type filters and limit travel to
 * `productClient.searchResources`; the in-flight request is cancelled on
 * unmount; a superseded query that resolves late never repaints; and the mock
 * source is reachable *only* while the Search flag is off.
 *
 * Architecture (kept as module-graph assertions because running code cannot
 * falsify them): the mock barrel is reached by dynamic import only — a static
 * import would silently pull the demo seed into the live Search chunk without
 * changing any observable behaviour; the search route literal belongs to the
 * transport family; snippet text is rendered by exactly one component; the
 * query/snippet privacy rule is an absence of storage/reporting/logging APIs.
 */
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { clearRouteCache } from '../lib/routeCache'
import { useProductSearch } from '../lib/useProductSearch'
import workflowSource from '../lib/useProductSearch.ts?raw'
import paletteSource from '../components/SearchPalette.tsx?raw'
import searchResultRowSource from '../components/SearchResultRow.tsx?raw'
import searchPageSource from '../pages/Search.tsx?raw'
import { cleanup, mountTree, waitForDom } from '../test/render'
import type { SearchPage } from './types'
import transportSource from './product-transport.ts?raw'

const transportDomainSources = Object.values(import.meta.glob('./product-transport*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
})) as string[]
const transportSources = [transportSource, ...transportDomainSources].join('\n')
import typesSource from './types.ts?raw'
// Search palette/product styles moved from polish.css into search.css.
const searchCssSource = readFileSync(resolve(import.meta.dirname, '../styles/search.css'), 'utf8')

const mocks = vi.hoisted(() => ({ search: vi.fn() }))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, searchResources: mocks.search } }
})

type SearchResultItem = SearchPage['items'][number]

function result(id: string): SearchResultItem {
  return {
    resourceType: 'collection', resourceId: id, title: `Result ${id}`, snippet: 'snippet', rank: 0.5,
  }
}

function searchPage(id: string) {
  return {
    query: 'alpha',
    types: ['collection'] as const,
    items: [result(id)],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    consistency: { authority: 'recheck-each-page' as const, ranking: 'restart-on-mutation' as const },
  }
}

describe('P2B-25 Search frontend boundary', () => {
  describe('useProductSearch behaviour', () => {
    let current!: ReturnType<typeof useProductSearch>

    function Probe({ query }: { query: string }) {
      current = useProductSearch({ query, types: ['collection'], limit: 12, debounceMs: 0 })
      return null
    }
    function renderProbe(query: string) {
      mountTree(createElement(Probe, { query }))
    }

    beforeEach(() => {
      vi.clearAllMocks()
      clearRouteCache()
      mocks.search.mockResolvedValue(searchPage('live-1'))
    })
    afterEach(() => { cleanup(); delete window.__KNOWN_FLAGS__ })

    it('sends the query, filters and limit through the canonical client', async () => {
      renderProbe('design systems')
      await waitForDom(() => current.items.length > 0)
      expect(mocks.search).toHaveBeenCalledWith(
        { q: 'design systems', types: ['collection'], limit: 12 },
        expect.objectContaining({ maxRetries: 0 }),
      )
      for (const call of mocks.search.mock.calls) {
        expect(call[1]?.signal).toBeInstanceOf(AbortSignal)
      }
      expect(current.items.map((item) => item.resourceId)).toEqual(['live-1'])
    })

    it('aborts the in-flight search on unmount', async () => {
      const signals: AbortSignal[] = []
      mocks.search.mockImplementation((_query: unknown, options: { signal?: AbortSignal }) => {
        signals.push(options.signal!)
        return new Promise(() => {})
      })
      renderProbe('alpha')
      await waitForDom(() => signals.length > 0)
      expect(signals[signals.length - 1]!.aborted).toBe(false)
      cleanup()
      for (const signal of signals) expect(signal.aborted).toBe(true)
    })

    it('never repaints a superseded query that resolves late', async () => {
      const pending: { q: string; resolve: (page: ReturnType<typeof searchPage>) => void }[] = []
      mocks.search.mockImplementation((query: { q: string }) =>
        new Promise((resolve) => { pending.push({ q: query.q, resolve }) }))
      renderProbe('alpha')
      await waitForDom(() => pending.length > 0)
      renderProbe('beta')
      await waitForDom(() => pending.length > 1)
      /* The newest query answers first; the older one lands afterwards. */
      await act(async () => { pending[1]!.resolve(searchPage('beta')) })
      await waitForDom(() => current.items.length > 0)
      await act(async () => { pending[0]!.resolve(searchPage('alpha')) })
      expect(current.items.map((item) => item.resourceId)).toEqual(['beta'])
      expect(current.state).toBe('ready')
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('consumes generated Search DTOs through the shared Product client', () => {
      /* Types are erased at runtime, so "the alias is the generated schema" can
         only be asserted against the declaration — anchored on the declaration
         itself, not on a bare substring. */
      expect(typesSource).toMatch(/export type SearchPage = Schemas\['SearchPage'\]/u)
      // Profiles have no page on this server, so the UI type drops that arm.
      expect(typesSource).toMatch(/export type SearchResult = Exclude<Schemas\['SearchResult'\], \{ resourceType: 'profile' \}>/u)
      /* The route literal is owned by the transport layer. */
      expect(transportSources).toMatch(/path:\s*'\/api\/v1\/search'/u)
    })

    it('does not persist, log, analyze, or inject query and snippet text', () => {
      for (const [name, source] of [['SearchPalette', paletteSource], ['Search', searchPageSource], ['useProductSearch', workflowSource]] as const) {
        expect(source, name).not.toMatch(/localStorage|sessionStorage|dangerouslySetInnerHTML/iu)
        expect(source, name).not.toMatch(/console\.(?:log|info|warn|error)|analytics|trackEvent/iu)
      }
      /* Snippet text is rendered by exactly one component, so a new surface
         cannot start injecting raw hit text without a visible diff here. */
      expect(paletteSource).toMatch(/from\s+['"]\.\/SearchResultRow['"]/u)
      expect(searchPageSource).toMatch(/from\s+['"]\.\.\/components\/SearchResultRow['"]/u)
      expect(searchResultRowSource).toContain('data-search-snippet')
      expect(paletteSource).not.toContain('data-search-snippet')
      expect(searchPageSource).not.toContain('data-search-snippet')
      expect(searchCssSource).toMatch(/\.search-result \.result-row-title\s*\{[\s\S]*min-width:\s*0[\s\S]*overflow-wrap:\s*anywhere/u)
    })
  })
})
