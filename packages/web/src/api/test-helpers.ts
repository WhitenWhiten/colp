/**
 * Shared pure test helpers for P1-13 product client unit tests.
 * Not production code.
 */
import { applySessionView, clearSession } from './sessionStore'

export type FetchCall = {
  input: RequestInfo | URL
  init?: RequestInit
}

export function createMemorySessionStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear() {
      map.clear()
    },
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null
    },
    key(index: number) {
      return [...map.keys()][index] ?? null
    },
    removeItem(key: string) {
      map.delete(key)
    },
    setItem(key: string, value: string) {
      map.set(String(key), String(value))
    },
  }
}

export function installSessionStorage(storage: Storage): () => void {
  const g = globalThis as typeof globalThis & { sessionStorage?: Storage }
  const previous = g.sessionStorage
  Object.defineProperty(g, 'sessionStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: storage,
  })
  return () => {
    if (previous === undefined) {
      Object.defineProperty(g, 'sessionStorage', {
        configurable: true,
        value: undefined,
      })
    } else {
      g.sessionStorage = previous
    }
  }
}

export function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init })
    return handler(input, init)
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous
    },
  }
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200
  const headers = new Headers({
    ...(status === 204 || body === null || body === undefined
      ? {}
      : { 'content-type': 'application/json' }),
    ...(init.headers ?? {}),
  })
  // 204 No Content cannot carry a body (undici/Node Response rejects it).
  if (status === 204 || body === null || body === undefined) {
    return new Response(null, {
      status: status === 204 ? 204 : status,
      headers,
    })
  }
  return new Response(JSON.stringify(body), {
    status,
    headers,
  })
}

export function productErrorBody(partial: {
  code: string
  message?: string
  requestId?: string
  recovery?: string
  sameRequestRetrySafe?: boolean
  precondition?: 'resource' | 'content' | null
  currentEtag?: string | null
  retryAfterSeconds?: number | null
  fieldErrors?: unknown[]
}) {
  return {
    error: {
      code: partial.code,
      message: partial.message ?? partial.code,
      requestId: partial.requestId ?? 'req-test',
      recovery: partial.recovery ?? 'user_action',
      sameRequestRetrySafe: partial.sameRequestRetrySafe ?? false,
      precondition: partial.precondition ?? null,
      currentEtag: partial.currentEtag ?? null,
      retryAfterSeconds: partial.retryAfterSeconds ?? null,
      fieldErrors: partial.fieldErrors ?? [],
    },
  }
}

export function requestUrl(call: FetchCall): string {
  if (typeof call.input === 'string') return call.input
  if (call.input instanceof URL) return call.input.href
  return call.input.url
}

export function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init?.headers)
}

export function requestMethod(call: FetchCall): string {
  return (call.init?.method ?? 'GET').toUpperCase()
}

export function requestPathAndSearch(call: FetchCall): { pathname: string; searchParams: URLSearchParams } {
  const raw = requestUrl(call)
  const url = new URL(raw, 'http://localhost')
  return { pathname: url.pathname, searchParams: url.searchParams }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value)
}

/** Seed in-memory session/CSRF for mutation tests. Never touches disk storage. */
export function seedAuthenticatedSession(csrfToken = 'csrf-write'): void {
  applySessionView({
    authenticated: true,
    csrfToken,
    idleExpiresAt: '2026-07-23T00:00:00.000Z',
    absoluteExpiresAt: '2026-07-24T00:00:00.000Z',
  })
}

export function resetProductSession(): void {
  clearSession()
}

export function editorPageBody(overrides: Record<string, unknown> = {}) {
  return {
    collection: {
      id: 'col-1',
      kind: 'bookmarks',
      title: 'Reading',
      summary: null,
      visibility: 'private',
      rootNodeId: 'root-1',
      revision: 1,
      etag: '"c-1"',
      contentRevision: 1,
      contentEtag: '"cc-1"',
      policyRevision: 1,
      policyEtag: '"p-1"',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    root: {
      id: 'root-1',
      kind: 'folder',
      folderRole: 'root',
      title: 'Root',
      description: null,
      tags: [],
      visibility: 'inherit',
      revision: 1,
      etag: '"r-1"',
      childrenRevision: 1,
    },
    nodes: [] as unknown[],
    capabilities: {
      updateCollection: true,
      managePublication: true,
      createNode: true,
      updateNode: true,
      moveNode: true,
      deleteNode: true,
    },
    page: {
      snapshotId: 'snap-1',
      contentRevision: 1,
      policyRevision: 1,
      comparatorVersion: 'v1',
      expiresAt: '2026-07-22T12:00:00.000Z',
      returnedCount: 0,
      hasMore: false,
      nextCursor: null as string | null,
    },
    ...overrides,
  }
}
