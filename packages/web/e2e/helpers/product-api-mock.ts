import type { Page, Request, Route } from '@playwright/test'
import { fulfillPassiveFeatureRequest, installPassiveFeatureMocks } from './passive-feature-mocks'

export const MOCK_CSRF = 'e2e-csrf-token'
export const MOCK_COLLECTION_ID = 'col-e2e-1'
export const MOCK_ROOT_ID = 'root-e2e-1'

type MockNode = {
  id: string
  kind: 'folder' | 'bookmark'
  title: string
  url?: string
  etag: string
  parentId: string
}

export type MockState = {
  authenticated: boolean
  collectionTitle: string
  collectionEtag: string
  collectionVisibility: 'private' | 'protected' | 'unlisted' | 'public'
  publicationSlug: string | null
  publishedAt: string | null
  contentRevision: string
  contentEtag: string
  nodes: MockNode[]
  managePublication: boolean
}

type Outcome =
  | 'success'
  | 'precondition_failed'
  | 'snapshot_expired'
  | 'command_in_progress'
  | 'slug_conflict'
  | 'csrf_failed'

type AdmissionViolation = {
  message: string
  status: number
  code: string
  recovery: string
  extra?: Record<string, unknown>
}

export type ProductRequestExpectation = {
  method: string
  path: string
  query?: Record<string, string>
  outcome?: Outcome
  label?: string
  captureCommandAs?: string
  sameCommandAs?: string
  differentCommandFrom?: string
  body?: Record<string, unknown>
  ifMatch?: string
  csrfToken?: string
  editor?: { hasMore: boolean; nextCursor: string | null; nodes?: MockNode[] }
  optional?: boolean
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const ENTITY_TAG = /^"[^"\r\n]+"$/u
const MOCK_TIME = '2026-07-22T00:00:00.000Z'

function createMockState(partial?: Partial<MockState>): MockState {
  return {
    authenticated: true,
    collectionTitle: 'E2E Collection',
    collectionEtag: '"c-1"',
    collectionVisibility: 'private',
    publicationSlug: null,
    publishedAt: null,
    contentRevision: '1',
    contentEtag: '"cc-1"',
    nodes: [
      {
        id: 'n-bookmark-1',
        kind: 'bookmark',
        title: 'Example',
        url: 'https://example.com',
        etag: '"n-1"',
        parentId: MOCK_ROOT_ID,
      },
    ],
    managePublication: true,
    ...partial,
  }
}

function stableQuery(url: URL): Record<string, string> {
  return Object.fromEntries([...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function sameRecord(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return JSON.stringify(actual) === JSON.stringify(
    Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b))),
  )
}

function json(route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'private, no-store', 'X-Request-Id': 'e2e-request', ...headers },
    body: JSON.stringify(body),
  })
}

function productError(
  route: Route,
  status: number,
  code: string,
  recovery: string,
  extra: Record<string, unknown> = {},
) {
  return json(route, {
    error: {
      code,
      message: code,
      requestId: 'e2e-request',
      recovery,
      sameRequestRetrySafe: recovery === 'same_request',
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: null,
      fieldErrors: [],
      ...extra,
    },
  }, status)
}

function collectionView(state: MockState) {
  return {
    id: MOCK_COLLECTION_ID,
    kind: 'bookmarks',
    title: state.collectionTitle,
    summary: null,
    visibility: state.collectionVisibility,
    publicationSlug: state.publicationSlug,
    publishedAt: state.publishedAt,
    rootNodeId: MOCK_ROOT_ID,
    revision: '1',
    etag: state.collectionEtag,
    contentRevision: state.contentRevision,
    contentEtag: state.contentEtag,
    policyRevision: '1',
    policyEtag: '"p-1"',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
  }
}

function editorPage(state: MockState, config?: ProductRequestExpectation['editor']) {
  const nodes = config?.nodes ?? state.nodes
  return {
    collection: collectionView(state),
    root: {
      id: MOCK_ROOT_ID,
      collectionId: MOCK_COLLECTION_ID,
      kind: 'folder',
      folderRole: 'root',
      parentId: null,
      position: null,
      title: 'Root',
      description: null,
      tags: [],
      visibility: 'inherit',
      revision: '1',
      etag: '"r-1"',
      readOnly: true,
      readOnlyReason: 'root_immutable',
      childrenRevision: '1',
      childrenEtag: '"ch-1"',
      createdAt: MOCK_TIME,
      updatedAt: MOCK_TIME,
    },
    nodes: nodes.map((node) => {
      const common = {
        id: node.id,
        collectionId: MOCK_COLLECTION_ID,
        parentId: node.parentId,
        position: node.id,
        title: node.title,
        description: null,
        tags: [],
        visibility: 'inherit',
        revision: '1',
        etag: node.etag,
        readOnly: false,
        readOnlyReason: null,
        createdAt: MOCK_TIME,
        updatedAt: MOCK_TIME,
      }
      return node.kind === 'folder'
        ? {
            ...common,
            kind: 'folder',
            folderRole: null,
            childrenRevision: '1',
            childrenEtag: '"ch-folder-1"',
          }
        : { ...common, kind: 'bookmark', url: node.url! }
    }),
    capabilities: {
      updateCollection: true,
      managePublication: state.managePublication,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: {
      snapshotId: 'snap-e2e',
      contentRevision: state.contentRevision,
      policyRevision: '1',
      comparatorVersion: 'v1',
      expiresAt: '2026-07-24T00:00:00.000Z',
      returnedCount: nodes.length,
      hasMore: config?.hasMore ?? false,
      nextCursor: config?.nextCursor ?? null,
    },
  }
}

class InvalidDocumentError extends Error {}

function bodyObject(request: Request): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(request.postData() ?? '') as unknown
  } catch {
    throw new Error('request body must be a JSON object')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidDocumentError('request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: string[], required: string[]): string | null {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) return `unexpected body fields: ${unknown.join(', ')}`
  const missing = required.filter((key) => !(key in value))
  return missing.length ? `missing body fields: ${missing.join(', ')}` : null
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && value.trim().length > 0
}

function validTags(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 64) return false
  const tags = value.filter((tag): tag is string =>
    typeof tag === 'string' && tag.length >= 1 && tag.length <= 64 && tag.trim().length > 0,
  )
  return tags.length === value.length && new Set(tags).size === tags.length
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096 || /\s/u.test(value)) return false
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
  } catch {
    return false
  }
}

export class ProductApiMock {
  readonly state: MockState
  private readonly expectations: ProductRequestExpectation[] = []
  private readonly failures: string[] = []
  private readonly commands = new Map<string, string>()
  private readonly commandFingerprints = new Map<string, string>()
  /** When true, GET /api/v1/collections returns this mock's collection instead of the empty passive list. */
  private serveOwnedCollectionList = false

  constructor(state?: Partial<MockState>) {
    this.state = createMockState(state)
  }

  private advanceContentFence(): void {
    const nextRevision = String(Number.parseInt(this.state.contentRevision, 10) + 1)
    this.state.contentRevision = nextRevision
    this.state.contentEtag = `"cc-${nextRevision}"`
  }

  expect(expectation: ProductRequestExpectation): this {
    this.expectations.push({ outcome: 'success', ...expectation, method: expectation.method.toUpperCase() })
    return this
  }

  expectBootstrap(authenticated = this.state.authenticated): this {
    this.expect({ method: 'GET', path: '/api/v1/session', label: 'session bootstrap' })
    this.expect({ method: 'GET', path: '/api/v1/session', label: 'StrictMode session bootstrap', optional: true })
    if (authenticated) {
      this.expect({ method: 'GET', path: '/api/v1/me', label: 'profile bootstrap' })
      this.expect({ method: 'GET', path: '/api/v1/me', label: 'StrictMode profile bootstrap', optional: true })
    }
    return this
  }

  expectEditor(expectation: Partial<ProductRequestExpectation> = {}): this {
    return this.expect({
      method: 'GET',
      path: `/api/v1/collections/${MOCK_COLLECTION_ID}/editor`,
      query: { limit: '200' },
      label: 'first editor page',
      ...expectation,
    })
  }

  pendingExpectationCount(): number {
    return this.expectations.filter((expectation) => !expectation.optional).length
  }

  expectEditorMount(expectation: Partial<ProductRequestExpectation> = {}): this {
    this.expectEditor(expectation)
    this.expectEditor({
      ...expectation,
      optional: true,
      label: `StrictMode ${expectation.label ?? 'first editor page'}`,
    })
    return this
  }

  /** Desk landing after create: owned list + editor snapshot (sidecars stay passive). */
  expectDeskMount(expectation: Partial<ProductRequestExpectation> = {}): this {
    this.serveOwnedCollectionList = true
    return this.expectEditorMount({
      label: 'desk editor snapshot',
      ...expectation,
    })
  }

  verify(): void {
    const unconsumed = this.expectations.filter((item) => !item.optional).map((item) =>
      `${item.label ?? 'request'}: ${item.method} ${item.path}`,
    )
    const problems = [
      ...this.failures,
      ...(unconsumed.length ? [`unconsumed Product API expectations:\n  ${unconsumed.join('\n  ')}`] : []),
    ]
    if (problems.length) throw new Error(`Product API mock verification failed:\n${problems.join('\n')}`)
  }

  acknowledgeExpectedViolations(...messages: RegExp[]): void {
    const observed = [
      ...this.failures,
      ...this.expectations.map((item) =>
        `unconsumed ${item.label ?? 'request'}: ${item.method} ${item.path}`,
      ),
    ]
    if (observed.length !== messages.length) {
      throw new Error(`expected ${messages.length} mock violations, received ${observed.length}: ${observed.join('; ')}`)
    }
    messages.forEach((pattern, index) => {
      if (!pattern.test(observed[index]!)) {
        throw new Error(`mock violation ${index + 1} did not match ${pattern}: ${observed[index]}`)
      }
    })
    this.failures.length = 0
    this.expectations.length = 0
  }

  private async fulfillOwnedCollectionList(route: Route): Promise<boolean> {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() !== 'GET' || path !== '/api/v1/collections') return false
    const snapshot = editorPage(this.state)
    await json(route, {
      items: [{
        collection: snapshot.collection,
        capabilities: snapshot.capabilities,
        bookmarkCount: this.state.nodes.filter((node) => node.kind === 'bookmark').length,
      }],
      page: { returnedCount: 1, hasMore: false, nextCursor: null },
    })
    return true
  }

  async handle(route: Route): Promise<void> {
    if (this.serveOwnedCollectionList && await this.fulfillOwnedCollectionList(route)) return
    if (await fulfillPassiveFeatureRequest(route)) return
    const request = route.request()
    const url = new URL(request.url())
    const actual = `${request.method()} ${url.pathname}${url.search}`

    let expected = this.expectations.shift()
    if (!expected) return this.reject(route, `unexpected Product API request: ${actual}`)

    const expectedQuery = expected.query ?? {}
    const matchesExpected = () => request.method() === expected!.method
      && url.pathname === expected!.path
      && sameRecord(stableQuery(url), expected!.query ?? {})
    while (!matchesExpected() && expected.optional) {
      expected = this.expectations.shift()
      if (!expected) return this.reject(route, `unexpected Product API request: ${actual}`)
    }
    if (
      !matchesExpected()
    ) {
      return this.reject(
        route,
        `wrong Product API sequence: expected ${expected.label ?? 'request'} ` +
          `${expected.method} ${expected.path} query=${JSON.stringify(expected.query ?? expectedQuery)}, received ${actual}`,
      )
    }

    let validation: AdmissionViolation | null
    try {
      validation = this.validateRequest(request, url)
    } catch (error) {
      validation = {
        message: error instanceof Error ? error.message : String(error),
        status: error instanceof InvalidDocumentError ? 422 : 400,
        code: error instanceof InvalidDocumentError ? 'invalid_document' : 'invalid_json',
        recovery: 'user_action',
      }
    }
    if (validation) {
      const message = `${actual}: ${validation.message}`
      this.failures.push(message)
      return void await productError(
        route,
        validation.status,
        validation.code,
        validation.recovery,
        validation.extra,
      )
    }

    const commandId = request.headers()['known-command-id']
    if (commandId) {
      const fingerprint = JSON.stringify({
        method: request.method(),
        path: url.pathname,
        query: stableQuery(url),
        body: request.postData() ?? null,
        ifMatch: request.headers()['if-match'] ?? null,
        ifContentMatch: request.headers()['if-content-match'] ?? null,
      })
      const previous = this.commandFingerprints.get(commandId)
      if (previous && previous !== fingerprint) {
        const message = `${actual}: Known-Command-Id was reused for a different request`
        this.failures.push(message)
        return void await productError(route, 409, 'command_id_reused', 'user_action')
      }
      this.commandFingerprints.set(commandId, fingerprint)
    }
    if (expected.captureCommandAs && commandId) this.commands.set(expected.captureCommandAs, commandId)
    if (expected.sameCommandAs && commandId !== this.commands.get(expected.sameCommandAs)) {
      return this.reject(route, `${actual}: retry did not reuse Known-Command-Id captured as ${expected.sameCommandAs}`)
    }

    if (expected.body && request.postData() !== JSON.stringify(expected.body)) {
      return this.reject(route, `${actual}: body did not match ${JSON.stringify(expected.body)}`)
    }
    if (expected.ifMatch && request.headers()['if-match'] !== expected.ifMatch) {
      return this.reject(route, `${actual}: If-Match did not match ${expected.ifMatch}`)
    }
    if (expected.csrfToken && request.headers()['x-csrf-token'] !== expected.csrfToken) {
      return this.reject(route, `${actual}: X-CSRF-Token did not match expected value`)
    }
    if (expected.differentCommandFrom && commandId === this.commands.get(expected.differentCommandFrom)) {
      return this.reject(route, `${actual}: new user intent reused Known-Command-Id captured as ${expected.differentCommandFrom}`)
    }

    if (expected.outcome === 'snapshot_expired') {
      return void await productError(route, 409, 'snapshot_expired', 'restart_from_first_page')
    }
    if (expected.outcome === 'precondition_failed') {
      if (url.pathname === `/api/v1/collections/${MOCK_COLLECTION_ID}`) {
        this.state.collectionEtag = '"c-server"'
      }
      return void await productError(route, 412, 'precondition_failed', 'refresh_and_retry', {
        precondition: 'resource',
        currentEtag: '"c-server"',
      })
    }
    if (expected.outcome === 'command_in_progress') {
      return void await productError(route, 409, 'command_in_progress', 'same_request', {
        retryAfterSeconds: 0,
      })
    }
    if (expected.outcome === 'slug_conflict') {
      return void await productError(route, 422, 'invalid_document', 'user_action', {
        fieldErrors: [{
          path: '/publicationSlug',
          code: 'publication_slug_conflict',
          message: 'This slug is already in use.',
        }],
      })
    }
    if (expected.outcome === 'csrf_failed') {
      return void await productError(route, 403, 'csrf_failed', 'user_action')
    }
    await this.respond(route, request, url, expected)
  }

  private reject(route: Route, message: string) {
    this.failures.push(message)
    return json(route, { error: { code: 'mock_contract_violation', message } }, 599)
  }

  private validateRequest(request: Request, url: URL): AdmissionViolation | null {
    const violation = (
      message: string,
      status = 400,
      code = 'invalid_request',
      recovery = 'user_action',
      extra?: Record<string, unknown>,
    ): AdmissionViolation => ({ message, status, code, recovery, extra })
    const method = request.method()
    const headers = request.headers()
    // Auth endpoints follow the auth contract (D1 authClient): same-origin
    // POSTs carry Origin and the in-memory CSRF when one exists, but never
    // Known-Command-Id, If-Match, or merge-patch semantics. Exempt them from
    // the product mutation admission rules.
    const mutation = ['POST', 'PATCH', 'DELETE'].includes(method)
      && !url.pathname.startsWith('/api/v1/auth/')
    if (!mutation) return null
    if (headers.origin !== url.origin) {
      return violation(`Origin must be exactly ${url.origin}`, 403, 'csrf_failed')
    }
    if (headers['x-csrf-token'] !== MOCK_CSRF) {
      return violation('missing or invalid X-CSRF-Token', 403, 'csrf_failed')
    }
    if (method === 'DELETE' && url.pathname === '/api/v1/session') {
      return headers['known-command-id']
        ? violation('logout must not send Known-Command-Id')
        : null
    }
    const commandId = headers['known-command-id']
    if (!commandId || !UUID_V4.test(commandId)) {
      return violation('Known-Command-Id must be a canonical lowercase UUID v4')
    }

    const isPatch = method === 'PATCH'
    const hasBody = request.postData() !== null && request.postData() !== ''
    if (hasBody) {
      const wanted = isPatch ? 'application/merge-patch+json' : 'application/json'
      const mediaType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (method === 'DELETE' || mediaType !== wanted) {
        return violation(`Content-Type must be ${wanted}`, 415, 'unsupported_media_type')
      }
    }
    if ((isPatch || /\/nodes\/[^/]+(?:\/move)?$/u.test(url.pathname)) && !headers['if-match']) {
      return violation('missing If-Match', 428, 'precondition_required', 'user_action', {
        precondition: 'resource',
      })
    }
    if (headers['if-match'] && !ENTITY_TAG.test(headers['if-match'])) {
      return violation('If-Match must contain one strong entity tag')
    }
    if (method === 'DELETE' && url.searchParams.get('recursive') === 'true' && !headers['if-content-match']) {
      return violation('recursive delete requires If-Content-Match', 428, 'precondition_required', 'user_action', {
        precondition: 'content',
      })
    }
    if (method === 'DELETE' && url.searchParams.get('recursive') !== 'true' && headers['if-content-match']) {
      return violation('non-recursive delete must omit If-Content-Match')
    }
    if (headers['if-content-match'] && !ENTITY_TAG.test(headers['if-content-match'])) {
      return violation('If-Content-Match must contain one strong entity tag')
    }
    if (headers['if-content-match'] && headers['if-content-match'] !== this.state.contentEtag) {
      return violation('If-Content-Match is stale', 412, 'precondition_failed', 'refresh_and_retry', {
        precondition: 'content',
        currentEtag: this.state.contentEtag,
      })
    }
    const nodeMatch = url.pathname.match(/\/nodes\/([^/]+)(?:\/move)?$/u)
    const currentResourceEtag = url.pathname === `/api/v1/collections/${MOCK_COLLECTION_ID}`
      ? this.state.collectionEtag
      : nodeMatch
        ? this.state.nodes.find((node) => node.id === nodeMatch[1])?.etag
        : undefined
    if (headers['if-match'] && currentResourceEtag && headers['if-match'] !== currentResourceEtag) {
      return violation('If-Match is stale', 412, 'precondition_failed', 'refresh_and_retry', {
        precondition: 'resource',
        currentEtag: currentResourceEtag,
      })
    }

    const invalidDocument = (message: string) => violation(message, 422, 'invalid_document')

    if (method === 'POST' && url.pathname === '/api/v1/collections') {
      const body = bodyObject(request)
      const problem = exactKeys(body, ['kind', 'title', 'summary'], ['kind', 'title', 'summary'])
      if (problem) return invalidDocument(problem)
      if (!['bookmarks', 'reading_path', 'knowledge_collection', 'mixed'].includes(String(body.kind))) {
        return invalidDocument('kind must be a supported collection kind')
      }
      if (!validTitle(body.title)) return invalidDocument('title must be a non-empty string of at most 512 characters')
      if (!isNullableString(body.summary) || (body.summary?.length ?? 0) > 2000) {
        return invalidDocument('summary must be null or a string of at most 2000 characters')
      }
      return null
    }
    if (isPatch && url.pathname === `/api/v1/collections/${MOCK_COLLECTION_ID}`) {
      const body = bodyObject(request)
      const problem = exactKeys(body, ['title', 'summary', 'visibility', 'publicationSlug'], [])
      if (problem) return invalidDocument(problem)
      if (!Object.keys(body).length) return invalidDocument('merge patch must not be empty')
      if ('title' in body && !validTitle(body.title)) return invalidDocument('title must be a valid non-null string')
      if ('summary' in body && (!isNullableString(body.summary) || (body.summary?.length ?? 0) > 2000)) {
        return invalidDocument('summary must be null or a string of at most 2000 characters')
      }
      if ('visibility' in body && !['private', 'unlisted', 'public'].includes(String(body.visibility))) {
        return invalidDocument('visibility must be private, unlisted, or public')
      }
      if ('publicationSlug' in body) {
        if (typeof body.publicationSlug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u.test(body.publicationSlug)) {
          return invalidDocument('publicationSlug must be a lowercase slug of 3 to 63 characters')
        }
        if (this.state.publicationSlug && body.publicationSlug !== this.state.publicationSlug) {
          return invalidDocument('publicationSlug is immutable')
        }
      }
      return null
    }
    if (method === 'POST' && url.pathname.endsWith('/nodes')) {
      const body = bodyObject(request)
      const problem = exactKeys(body, ['parentId', 'afterId', 'beforeId', 'node'], ['parentId', 'afterId', 'beforeId', 'node'])
      if (problem) return invalidDocument(problem)
      if (typeof body.parentId !== 'string' || !body.parentId.trim()) return invalidDocument('parentId must be a non-empty string')
      if (!isNullableNonEmptyString(body.afterId) || !isNullableNonEmptyString(body.beforeId)) {
        return invalidDocument('node anchors must be null or non-empty strings')
      }
      const node = body.node
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return invalidDocument('node must be an object')
      }
      const input = node as Record<string, unknown>
      if (input.kind !== 'folder' && input.kind !== 'bookmark') return invalidDocument('node.kind must be folder or bookmark')
      const allowed = input.kind === 'folder'
        ? ['kind', 'title', 'description', 'tags', 'visibility']
        : ['kind', 'title', 'url', 'description', 'tags', 'visibility']
      const nestedProblem = exactKeys(input, allowed, allowed)
      if (nestedProblem) return invalidDocument(`node ${nestedProblem}`)
      if (!validTitle(input.title)) return invalidDocument('node.title must be a valid string')
      if (input.kind === 'bookmark' && !validUrl(input.url)) return invalidDocument('node.url must be an absolute http(s) URL without userinfo')
      if (!isNullableString(input.description) || (input.description?.length ?? 0) > 20_000) return invalidDocument('node.description is invalid')
      if (!validTags(input.tags)) return invalidDocument('node.tags is invalid')
      if (!['inherit', 'protected', 'private'].includes(String(input.visibility))) return invalidDocument('node.visibility is invalid')
      return null
    }
    if (isPatch && /\/nodes\/[^/]+$/u.test(url.pathname)) {
      const problem = exactKeys(
        bodyObject(request),
        ['title', 'url', 'description', 'tags', 'visibility'],
        [],
      )
      const body = bodyObject(request)
      if (problem) return invalidDocument(problem)
      if (!Object.keys(body).length) return invalidDocument('merge patch must not be empty')
      if ('title' in body && !validTitle(body.title)) return invalidDocument('title must be a valid non-null string')
      if ('url' in body && !validUrl(body.url)) return invalidDocument('url must be an absolute http(s) URL without userinfo')
      if ('description' in body && (!isNullableString(body.description) || (body.description?.length ?? 0) > 20_000)) return invalidDocument('description is invalid')
      if ('tags' in body && body.tags !== null && !validTags(body.tags)) return invalidDocument('tags must be a valid array or null')
      if ('visibility' in body && body.visibility !== null && !['inherit', 'protected', 'private'].includes(String(body.visibility))) return invalidDocument('visibility is invalid')
      return null
    }
    if (method === 'POST' && url.pathname.endsWith('/move')) {
      const body = bodyObject(request)
      const problem = exactKeys(
        body,
        [
          'newParentId',
          'afterId',
          'beforeId',
          'baseSourceParentRevision',
          'baseTargetParentRevision',
        ],
        [
          'newParentId',
          'afterId',
          'beforeId',
          'baseSourceParentRevision',
          'baseTargetParentRevision',
        ],
      )
      if (problem) return invalidDocument(problem)
      if (typeof body.newParentId !== 'string' || !body.newParentId.trim()) return invalidDocument('newParentId must be a non-empty string')
      if (!isNullableNonEmptyString(body.afterId) || !isNullableNonEmptyString(body.beforeId)) {
        return invalidDocument('move anchors must be null or non-empty strings')
      }
      if (typeof body.baseSourceParentRevision !== 'string' || !body.baseSourceParentRevision.trim()) {
        return invalidDocument('baseSourceParentRevision must be a non-empty string')
      }
      if (typeof body.baseTargetParentRevision !== 'string' || !body.baseTargetParentRevision.trim()) {
        return invalidDocument('baseTargetParentRevision must be a non-empty string')
      }
      return null
    }
    return null
  }

  private async respond(
    route: Route,
    request: Request,
    url: URL,
    expected: ProductRequestExpectation,
  ): Promise<void> {
    const method = request.method()
    const path = url.pathname
    if (method === 'GET' && path === '/api/v1/auth/oidc/start') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body data-testid="oidc-start-mock">OIDC start mock</body></html>',
      })
      return
    }
    if (method === 'POST' && path === '/api/v1/auth/sign-in/social') {
      // authClient.startOAuth posts Better Auth /sign-in/social with
      // provider + safe callback URLs; the server answers with the
      // authorization URL.
      await json(route, { url: '/library', redirect: false })
      return
    }
    if (method === 'GET' && path === '/api/v1/session') {
      await json(route, this.state.authenticated ? {
        authenticated: true,
        csrfToken: MOCK_CSRF,
        idleExpiresAt: '2026-07-23T23:00:00.000Z',
        absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
      } : { authenticated: false })
      return
    }
    if (method === 'GET' && path === '/api/v1/me') {
      await json(route, {
        account: { id: 'acc-e2e', email: 'e2e@known.test' },
        profile: { id: 'prof-e2e', handle: 'e2e', displayName: 'E2E User', avatarUrl: null, about: '' },
      })
      return
    }
    if (method === 'DELETE' && path === '/api/v1/session') {
      this.state.authenticated = false
      await route.fulfill({ status: 204, body: '' })
      return
    }
    if (method === 'POST' && path === '/api/v1/collections') {
      const body = bodyObject(request)
      this.state.collectionTitle = String(body.title)
      await json(route, { collection: collectionView(this.state), root: editorPage(this.state).root }, 201, {
        Location: `/api/v1/collections/${MOCK_COLLECTION_ID}`,
        ETag: this.state.collectionEtag,
      })
      return
    }
    if (method === 'GET' && path === `/api/v1/collections/${MOCK_COLLECTION_ID}/editor`) {
      await json(route, editorPage(this.state, expected.editor))
      return
    }
    if (method === 'PATCH' && path === `/api/v1/collections/${MOCK_COLLECTION_ID}`) {
      const body = bodyObject(request)
      if (typeof body.title === 'string') this.state.collectionTitle = body.title
      if (body.visibility === 'private' || body.visibility === 'unlisted' || body.visibility === 'public') {
        this.state.collectionVisibility = body.visibility
        if (body.visibility !== 'private') this.state.publishedAt ??= MOCK_TIME
      }
      if (typeof body.publicationSlug === 'string' && !this.state.publicationSlug) {
        this.state.publicationSlug = body.publicationSlug
      }
      this.state.collectionEtag = '"c-2"'
      this.advanceContentFence()
      await json(route, { collection: { ...collectionView(this.state), revision: '2' } }, 200, {
        ETag: this.state.collectionEtag,
      })
      return
    }

    const nodeMatch = path.match(new RegExp(`^/api/v1/collections/${MOCK_COLLECTION_ID}/nodes(?:/([^/]+))?(?:/(move))?$`))
    if (nodeMatch && method === 'POST' && !nodeMatch[1]) {
      const body = bodyObject(request)
      const input = body.node as Record<string, unknown>
      const node: MockNode = {
        id: `n-new-${this.state.nodes.length + 1}`,
        kind: input.kind === 'folder' ? 'folder' : 'bookmark',
        title: String(input.title),
        url: typeof input.url === 'string' ? input.url : undefined,
        etag: '"n-new"',
        parentId: String(body.parentId),
      }
      this.state.nodes.push(node)
      this.advanceContentFence()
      const view = editorPage(this.state).nodes.find((item) => item.id === node.id)
      await json(route, {
        node: view,
        parent: { id: node.parentId, childrenRevision: '2', childrenEtag: '"ch-2"' },
        fence: {
          contentRevision: this.state.contentRevision,
          contentEtag: this.state.contentEtag,
          policyRevision: '1',
          policyEtag: '"p-1"',
        },
      }, 201, { Location: `/api/v1/collections/${MOCK_COLLECTION_ID}/nodes/${node.id}`, ETag: node.etag })
      return
    }
    if (nodeMatch && method === 'PATCH' && nodeMatch[1]) {
      const target = this.state.nodes.find((node) => node.id === nodeMatch[1])
      if (!target) {
        await productError(route, 404, 'resource_not_found', 'none')
        return
      }
      const body = bodyObject(request)
      if (typeof body.title === 'string') target.title = body.title
      if (target.kind === 'bookmark' && typeof body.url === 'string') target.url = body.url
      target.etag = '"n-2"'
      this.advanceContentFence()
      await json(route, {
        node: editorPage(this.state).nodes.find((item) => item.id === target.id),
        fence: {
          contentRevision: this.state.contentRevision,
          contentEtag: this.state.contentEtag,
          policyRevision: '1',
          policyEtag: '"p-1"',
        },
      }, 200, { ETag: target.etag })
      return
    }
    if (nodeMatch && method === 'POST' && nodeMatch[1] && nodeMatch[2] === 'move') {
      const target = this.state.nodes.find((node) => node.id === nodeMatch[1])
      if (!target) {
        await productError(route, 404, 'resource_not_found', 'none')
        return
      }
      const body = bodyObject(request)
      const sourceParentId = target.parentId
      target.parentId = String(body.newParentId)
      target.etag = '"n-moved"'
      this.advanceContentFence()
      await json(route, {
        node: editorPage(this.state).nodes.find((item) => item.id === target.id),
        sourceParent: { id: sourceParentId, childrenRevision: '2', childrenEtag: '"ch-source-2"' },
        targetParent: { id: target.parentId, childrenRevision: '2', childrenEtag: '"ch-target-2"' },
        fence: {
          contentRevision: this.state.contentRevision,
          contentEtag: this.state.contentEtag,
          policyRevision: '1',
          policyEtag: '"p-1"',
        },
      }, 200, { ETag: target.etag })
      return
    }
    if (nodeMatch && method === 'DELETE' && nodeMatch[1]) {
      const targetId = nodeMatch[1]
      this.state.nodes = this.state.nodes.filter((node) => node.id !== targetId && node.parentId !== targetId)
      this.advanceContentFence()
      await json(route, {
        receipt: {
          resourceType: 'node',
          targetId,
          collectionId: MOCK_COLLECTION_ID,
          scope: url.searchParams.get('recursive') === 'true' ? 'subtree' : 'single',
          deletedAt: MOCK_TIME,
          deleteRevision: '2',
          operationId: 'op-e2e',
          affectedCount: 1,
          purgeAfter: '2026-08-22T00:00:00.000Z',
        },
        parent: { id: MOCK_ROOT_ID, childrenRevision: '2', childrenEtag: '"ch-2"' },
        fence: {
          contentRevision: this.state.contentRevision,
          contentEtag: this.state.contentEtag,
          policyRevision: '1',
          policyEtag: '"p-1"',
        },
      })
      return
    }
    await this.reject(route, `expected route has no responder: ${method} ${path}`)
  }
}

export async function installProductApiMocks(
  page: Page,
  initial?: Partial<MockState>,
): Promise<ProductApiMock> {
  const mock = new ProductApiMock(initial)
  await page.route('**/api/v1/**', (route) => mock.handle(route))
  await installPassiveFeatureMocks(page)
  return mock
}
