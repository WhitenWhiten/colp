/* Canonical Product client boundary.
 *
 * Behaviour (driven against the real singleton with `fetch` mocked): one
 * immutable entry point is exported; owned-collection pagination continues
 * with only the opaque cursor; library order, collection follow and public
 * collection insight ingest all answer on generated routes; and the transport
 * family exposes no second/default client factory. These are the properties
 * the Phase-1 consumers depend on, and they are observed as calls rather than
 * as source text — extracting or renaming a module cannot move them.
 *
 * Architecture (kept as module-graph assertions): an unused deep import
 * changes no observable behaviour, so "consumers reach the API through the
 * public barrel, never through product-transport / types / errors /
 * sessionStore" and "legacy demo seeds stay outside Product API code" are
 * asserted on module specifiers. Type aliases are erased at runtime, so their
 * derivation from the generated schema is asserted on the declaration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import authSource from '../auth/AuthContext.tsx?raw'
import createCollectionSource from '../pages/CreateCollection.tsx?raw'
import collectionEditorRoot from '../pages/CollectionEditor.tsx?raw'
import collectionSource from '../pages/Collection.tsx?raw'
import libraryCollectionSource from '../pages/library-desk/LibraryDesk.tsx?raw'
import useFollowedCollectionsSource from '../lib/useFollowedCollections.ts?raw'
import libraryHealthSource from '../pages/LibraryHealth.tsx?raw'
import classifySource from '../pages/Classify.tsx?raw'
import dataExportSource from '../pages/DataExport.tsx?raw'
import aiOrganizeSource from '../pages/AiOrganize.tsx?raw'
import collectionHistorySource from '../pages/CollectionHistory.tsx?raw'
import generatedBridgeSource from '../generated/product-v1.ts?raw'
import canonicalClientSource from './productClient.ts?raw'
import transportSource from './product-transport.ts?raw'
import typesSource from './types.ts?raw'
import * as publicApi from './index'
import { productClient as canonicalProductClient } from './productClient'
import type { FollowedCollectionPage, LibraryOrderView, OwnedCollectionPage } from './types'
import {
  createMemorySessionStorage, installFetchMock, installSessionStorage, jsonResponse,
  requestHeaders, requestMethod, requestPathAndSearch, resetProductSession, seedAuthenticatedSession,
} from './test-helpers'

/* Production modules only — colocated test files (LibraryDesk.test.tsx etc.)
   may legitimately import deep api modules like ../../api/sessionStore. */
const libraryDeskSources = Object.values(
  import.meta.glob(
    ['../pages/library-desk/**/*.{ts,tsx}', '!../pages/library-desk/**/*.test.*', '!../pages/library-desk/**/*.test-helper.*', '!../pages/library-desk/**/*.test-mocks.*'],
    {
      eager: true,
      import: 'default',
      query: '?raw',
    },
  ),
) as string[]

const collectionEditorSources = Object.values(
  import.meta.glob(
    ['../pages/collection-editor/**/*.{ts,tsx}', '!../pages/collection-editor/**/*.test.*'],
    {
      eager: true,
      import: 'default',
      query: '?raw',
    },
  ),
) as string[]

const collectionPageSources = Object.values(
  import.meta.glob(
    ['../pages/collection/**/*.{ts,tsx}', '!../pages/collection/**/*.test.*'],
    {
      eager: true,
      import: 'default',
      query: '?raw',
    },
  ),
) as string[]

const libraryCollectionSurface = [libraryCollectionSource, ...libraryDeskSources].join('\n')
const collectionEditorSurface = [collectionEditorRoot, ...collectionEditorSources].join('\n')
const collectionSurface = [collectionSource, ...collectionPageSources].join('\n')

const exactTransportImport = /from ['"]\.\/product-transport['"]/

const phase1Consumers = {
  AuthContext: authSource,
  CreateCollection: createCollectionSource,
  CollectionEditor: collectionEditorSurface,
  Collection: collectionSurface,
  LibraryDesk: libraryCollectionSurface,
  LibraryHealth: libraryHealthSource,
  Classify: classifySource,
  DataExport: dataExportSource,
  AiOrganize: aiOrganizeSource,
  CollectionHistory: collectionHistorySource,
}

const apiModules = import.meta.glob(['./*.ts', '!./*.test.ts'], {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

/* Namespace objects, for the export-surface half of the boundary: a text scan
   cannot tell an exported second entry point from a local helper, and a
   namespace can. */
const transportModules = import.meta.glob('./product-transport*.ts', {
  eager: true,
}) as Record<string, Record<string, unknown>>

const clientDomainSource = Object.entries(apiModules)
  .filter(([path]) => path.startsWith('./product-client-'))
  .map(([, source]) => source)
  .join('\n')

const transportDomainSource = Object.entries(apiModules)
  .filter(([path]) => path.startsWith('./product-transport'))
  .map(([, source]) => source)
  .join('\n')

const clientSources = `${canonicalClientSource}\n${clientDomainSource}`
const transportSources = `${transportSource}\n${transportDomainSource}`

const legacyDemoData = import.meta.glob('../legacy-demo/data/*.ts', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

function ownedPage(id: string, hasMore: boolean, nextCursor: string | null): OwnedCollectionPage {
  return {
    items: [{
      collection: {
        id, kind: 'bookmarks', title: `Collection ${id}`, summary: null,
        visibility: 'private', allowSearchIndexing: false, publicationSlug: null,
        publishedAt: null, rootNodeId: `root-${id}`, revision: `r-${id}`,
        etag: `"r-${id}"`, contentRevision: `c-${id}`, contentEtag: `"c-${id}"`,
        policyRevision: `p-${id}`, policyEtag: `"p-${id}"`,
        createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
      },
      capabilities: {
        updateCollection: true, managePublication: true, createNode: true,
        updateNode: true, moveNode: true, deleteNode: true,
      },
    }],
    page: { returnedCount: 1, hasMore, nextCursor },
  }
}

describe('canonical Product client boundary', () => {
  let restoreStorage: () => void
  let restoreFetch: (() => void) | undefined

  beforeEach(() => {
    restoreStorage = installSessionStorage(createMemorySessionStorage())
    resetProductSession()
    seedAuthenticatedSession('csrf-boundary')
  })
  afterEach(() => {
    restoreFetch?.()
    restoreStorage()
    resetProductSession()
  })

  describe('canonical client behaviour', () => {
    it('exposes one immutable singleton through the public API entry point', () => {
      expect(publicApi.productClient).toBe(canonicalProductClient)
      expect(Object.isFrozen(canonicalProductClient)).toBe(true)
      expect(publicApi).toMatchObject({
        ProductApiError: expect.any(Function),
        isProductApiError: expect.any(Function),
        productClient: canonicalProductClient,
        recoveryStrategyFor: expect.any(Function),
      })
      expect(publicApi).not.toHaveProperty('createProductTransport')
    })

    it('offers no default or second client factory from the transport family', () => {
      const forbidden = ['defaultClient', 'clientSingleton', 'getDefaultProductClient']
      expect(transportModules['./product-transport.ts']).toHaveProperty('createProductTransport')
      for (const [path, module] of Object.entries(transportModules)) {
        expect(module, path).not.toHaveProperty('default')
        for (const name of forbidden) {
          expect(module, path).not.toHaveProperty(name)
        }
        /* Every transport module exports factories only: an exported value
           would be a shared instance the canonical client does not own. */
        for (const [name, value] of Object.entries(module)) {
          expect(typeof value, `${path}:${name}`).toBe('function')
        }
      }
    })

    it('continues owned-collection pagination with only the opaque cursor', async () => {
      const mock = installFetchMock(() => jsonResponse(
        mock.calls.length === 1 ? ownedPage('one', true, 'signed cursor/+') : ownedPage('two', false, null),
      ))
      restoreFetch = mock.restore
      const items = await canonicalProductClient.loadOwnedCollections({ limit: 1 }, { maxRetries: 0 })
      expect(items.map((item) => item.collection.id)).toEqual(['one', 'two'])
      expect(Object.fromEntries(requestPathAndSearch(mock.calls[0]!).searchParams)).toEqual({ limit: '1' })
      /* The continuation carries the cursor and nothing else — the filters are
         not replayed against a sealed cursor. */
      expect(Object.fromEntries(requestPathAndSearch(mock.calls[1]!).searchParams)).toEqual({ cursor: 'signed cursor/+' })
    })

    it('reads and updates the library order on the generated route', async () => {
      const view: LibraryOrderView = { sections: { mine: [], shared: [], following: [] } }
      const mock = installFetchMock((input, init) => requestMethod({ input, init }) === 'PUT'
        ? jsonResponse({ section: 'mine', collectionIds: [] })
        : jsonResponse(view))
      restoreFetch = mock.restore
      await expect(canonicalProductClient.getMyLibraryOrder({ maxRetries: 0 })).resolves.toEqual(view)
      await canonicalProductClient.updateMyLibraryOrder('mine', { collectionIds: [] }, { intentId: 'library-order:mine', maxRetries: 0 })
      expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/me/library-order')
      expect(requestMethod(mock.calls[1]!)).toBe('PUT')
      expect(requestPathAndSearch(mock.calls[1]!).pathname).toBe('/api/v1/me/library-order/mine')
      expect(requestHeaders(mock.calls[1]!).get('x-csrf-token')).toBe('csrf-boundary')
      expect(requestHeaders(mock.calls[1]!).get('known-command-id')).toBeTruthy()
    })

    it('lists followed collections on the generated route', async () => {
      const page: FollowedCollectionPage = { items: [], nextCursor: 'cursor-2' }
      const mock = installFetchMock(() => jsonResponse(page))
      restoreFetch = mock.restore
      await expect(canonicalProductClient.listFollowedCollections({ limit: 5 }, { maxRetries: 0 })).resolves.toEqual(page)
      const { pathname, searchParams } = requestPathAndSearch(mock.calls[0]!)
      expect(pathname).toBe('/api/v1/me/followed-collections')
      expect(searchParams.get('limit')).toBe('5')
    })

    it('records public collection insight events through the generated publishing insights client', async () => {
      const mock = installFetchMock(() => jsonResponse(null, { status: 204 }))
      restoreFetch = mock.restore
      await canonicalProductClient.recordPublicCollectionInsightEvent(
        { slug: 'research-notes', eventType: 'resource_open', nodeId: 'node-1' },
        {},
      )
      expect(mock.calls).toHaveLength(1)
      expect(requestMethod(mock.calls[0]!)).toBe('POST')
      expect(requestPathAndSearch(mock.calls[0]!).pathname).toBe('/api/v1/public-collections/research-notes/insight-events')
      expect(JSON.parse(String(mock.calls[0]!.init?.body))).toEqual({ eventType: 'resource_open', nodeId: 'node-1' })
    })
  })

  describe('architecture invariants that cannot be behaviour tested', () => {
    it('keeps transport construction private to the canonical client', () => {
      const transportImporters = Object.entries(apiModules)
        .filter(([, source]) => exactTransportImport.test(source))
        .map(([path]) => path)

      expect(transportImporters).toEqual(['./productClient.ts'])
      /* Anchor the singleton construction on the call, not on the formatting
         of the surrounding source. */
      expect(canonicalClientSource).toMatch(/const productTransport = createProductTransport\s*\(/u)
      expect(canonicalClientSource).toMatch(/Object\.freeze\(\{/u)
      /* No second entry point may be exported from the transport family. */
      expect(transportSources).not.toMatch(/export\s+(?:const|let|function|class|default)\s+.*\b(?:defaultClient|clientSingleton|getDefaultProductClient)\b/u)
      expect(Object.keys(apiModules)).not.toContain('./product-client.ts')
    })

    it('keeps the cursor-only continuation intent in the canonical client too', () => {
      /* Defence in depth, and the reason this one stays a source assertion:
         `transport.listOwnedCollections` already strips the filters whenever a
         cursor is present, so the client's own cursor-only continuation is not
         separately observable at the HTTP boundary — the behaviour test above
         only goes red when BOTH layers regress. This pins the nearer guard. */
      expect(clientSources).toMatch(/getOwnedCollectionsPage\(\{\s*cursor\s*\},\s*options\)/u)
    })

    it('uses the generated Product contract instead of copied schema types', () => {      /* Type aliases are erased at runtime: assert the derivation itself. */
      expect(typesSource).toMatch(/from\s+'\.\.\/generated\/product-v1'/u)
      expect(generatedBridgeSource).toMatch(/from\s+'@known\/product-v1'/u)
      expect(transportSources).toMatch(/from\s+'\.\/types'/u)
      expect(typesSource).toMatch(/export type OwnedCollectionPage = Schemas\['OwnedCollectionPage'\]/u)
    })

    it('routes every Phase 1 consumer through the public canonical entry point', () => {
      for (const [name, source] of Object.entries(phase1Consumers)) {
        // Depth-flexible: colocated modules (library-desk/) reach the entry via ../../api.
        expect(source, name).toMatch(/from ['"](?:\.\.\/)+api['"]/)
        /* The consumer must actually call a client method, not merely mention
           the identifier. */
        expect(source, name).toMatch(/\bproductClient\.\w+/)
        expect(source, name).not.toMatch(
          /from ['"](?:\.\.\/)+api\/(?:productClient|product-client|product-transport|types|errors|sessionStore)['"]/,
        )
        expect(source, name).not.toContain('../legacy-demo/')
      }
    })

    it('keeps legacy demo seeds outside Product API code', () => {
      expect(Object.keys(legacyDemoData)).toHaveLength(4)
      for (const [path, source] of Object.entries(legacyDemoData)) {
        expect(path).toContain('/legacy-demo/data/')
        expect(source, path).not.toMatch(/\/api\/v1|productClient|product-transport/)
      }
    })

    it('keeps collaboration and insight events on the generated runtime', () => {
      expect(clientSources).toContain('createProductPublishingInsightsClient')
      expect(clientSources).not.toMatch(/\bfetch\s*\([^)]*insight-events/u)
      expect(clientSources).toContain('createProductCollaborationClient')
      expect(clientSources).toContain('listCollectionMembers')
      expect(clientSources).toContain('listSharedCollections')
      expect(clientSources).toContain('listMyCollaborationInvites')
      expect(clientSources).toContain('acceptCollaborationInvite')
      expect(clientSources).toContain('declineCollaborationInvite')
      /* Invite decisions are not revision-guarded: no If-Match is threaded
         through their call sites. */
      expect(clientSources).not.toMatch(/\.acceptCollaborationInvite\([^)]*ifMatch/u)
      expect(clientSources).not.toMatch(/\.declineCollaborationInvite\([^)]*ifMatch/u)
      expect(collectionSource).toMatch(/from\s+'\.\.\/api'/u)
      expect(collectionSource).not.toContain('../legacy-demo/')
      expect(collectionSource).not.toContain('product-transport')
    })

    it('keeps the library-order bridge inside the api barrel, never in the desk surface', () => {
      expect(Object.isFrozen(canonicalProductClient)).toBe(true)
      expect(clientSources).toContain('createProductLibraryOrderClient')
      expect(clientSources).not.toMatch(/\bfetch\s*\([^)]*\/me\/library-order/u)
      expect(libraryCollectionSurface).toMatch(/\bgetMyLibraryOrder\b/u)
      expect(libraryCollectionSurface).toMatch(/\bupdateMyLibraryOrder\b/u)
      /* The desk surface must not construct the generated client itself. */
      expect(libraryCollectionSurface).not.toContain('@known/product-v1-client')
    })

    it('keeps the collection-follow bridge inside the api barrel, never in the desk surface', () => {
      expect(Object.isFrozen(canonicalProductClient)).toBe(true)
      expect(clientSources).toContain('createProductCollectionFollowClient')
      expect(clientSources).toContain('followCollection')
      expect(clientSources).toContain('unfollowCollection')
      expect(clientSources).toContain('getCollectionFollowState')
      /* The follow route is spelled only by the generated runtime. */
      expect(clientSources).not.toMatch(/['"`]\/api\/v1\/collections\/[^'"`]*\/follow/u)
      expect(collectionSource).toContain('CollectionFollowButton')
      expect(collectionSource).toContain('isCollectionFollowExposureEnabled')
      expect(collectionSource).toMatch(/from\s+'\.\.\/api'/u)
      expect(useFollowedCollectionsSource).toMatch(/\blistFollowedCollections\b/u)
      expect(useFollowedCollectionsSource).toMatch(/from\s+'\.\.\/api'/u)
      expect(useFollowedCollectionsSource).not.toContain('@known/product-v1-client')
      expect(libraryCollectionSource).toContain('useFollowedCollections')
      expect(libraryCollectionSource).toMatch(/from ['"](?:\.\.\/)+api['"]/)
      expect(libraryCollectionSource).not.toContain('@known/product-v1-client')
    })
  })
})
