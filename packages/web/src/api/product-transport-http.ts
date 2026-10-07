import { publishLibraryMutation } from '../lib/libraryInvalidation'
import { privateSessionIdentity } from './sessionStore'
import { productRequestCredentials } from './product-credentials'
/**
 * Product HTTP request + session/CSRF internals for createProductTransport.
 * Domain transport modules receive this instance; they do not call fetch themselves.
 */
import { allocateCommandId } from './command-intent'
import { parseProductError, requestTimeoutError } from './product-error'
import { fetchWithTimeout, isTimeoutError, REQUEST_TIMEOUT_MS, TRANSFER_TIMEOUT_MS } from './requestTimeout'
import type { MutationCallOptions, ProductTransportOptions } from './product-transport-types'

export type ProductRequestInit = {
  method: string
  path: string
  /** Session probes explicitly include cookies even before the product actor is known. */
  credentials?: RequestCredentials
  query?: Record<string, string | number | boolean | readonly string[] | undefined | null>
  headers?: Record<string, string>
  body?: unknown
  rawBody?: BodyInit
  contentType?: string
  signal?: AbortSignal
  /** Client deadline; uploads (rawBody) default to the transfer budget. */
  timeoutMs?: number
  emptyOk?: boolean
  includeEtag?: boolean
}

export type ProductTransportHttp = {
  origin: string | undefined
  fetchImpl: typeof fetch | undefined
  request: <T>(init: ProductRequestInit) => Promise<T>
  mutationHeaders: (opts: MutationCallOptions, extra?: Record<string, string>) => Record<string, string>
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit != null && explicit !== '') {
    return explicit.replace(/\/$/, '')
  }
  try {
    const env =
      typeof import.meta !== 'undefined'
        ? (import.meta as ImportMeta & { env?: { VITE_API_ORIGIN?: string } }).env
            ?.VITE_API_ORIGIN
        : undefined
    if (env && String(env).trim()) return String(env).replace(/\/$/, '')
  } catch {
    /* non-vite */
  }
  return ''
}

function joinUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | readonly string[] | undefined | null>): string {
  const pathPart = path.startsWith('/') ? path : `/${path}`
  let href: string
  if (baseUrl) {
    href = `${baseUrl}${pathPart}`
  } else {
    href = pathPart
  }
  if (query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue
      if (Array.isArray(v)) {
        for (const item of v) qs.append(k, item)
      } else {
        qs.set(k, String(v))
      }
    }
    const s = qs.toString()
    if (s) href += (href.includes('?') ? '&' : '?') + s
  }
  // When base is absolute, return absolute; when relative, keep path+query as-is
  if (baseUrl) {
    try {
      return new URL(href).href
    } catch {
      return href
    }
  }
  return href
}

function resolveOrigin(baseUrl: string): string | undefined {
  if (baseUrl) {
    try {
      return new URL(baseUrl).origin
    } catch {
      /* fall through */
    }
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  return undefined
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

function headersToRecord(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    out[k] = v
  })
  return out
}

const STRONG_ENTITY_TAG = /^"[^"\r\n]+"$/

/**
 * Origin emits a single strong entity-tag. nginx gzip (since 1.7.3) and
 * Cloudflare brotli/gzip rewrite that header to `W/"..."` after they change
 * the on-the-wire bytes. `fetch()` has already decompressed the body, so the
 * inner quoted tag is still the validator for the JSON we parsed. Strip one
 * RFC 9110 `W/` prefix (case-sensitive) and keep only a single strong tag.
 */
function asStrongEntityTag(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const candidate = trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed
  return STRONG_ENTITY_TAG.test(candidate) ? candidate : null
}

export function createProductTransportHttp(
  options: ProductTransportOptions = {},
): ProductTransportHttp {
  const baseUrl = resolveBaseUrl(options.baseUrl)
  // Resolve fetch at call time so test mocks replacing globalThis.fetch take effect.
  // Do not bind globalThis.fetch at construction — bind freezes the pre-mock function.
  const fetchImpl = options.fetchImpl
  const origin = resolveOrigin(baseUrl)

  async function request<T>(init: ProductRequestInit): Promise<T> {
    const identity = privateSessionIdentity()
    const invalidate = () => { if (!['GET', 'HEAD', 'OPTIONS'].includes(init.method)) publishLibraryMutation(init.path, identity) }
    const headers = new Headers(init.headers)
    if (init.body !== undefined && init.contentType && !headers.has('Content-Type')) {
      headers.set('Content-Type', init.contentType)
    }

    const url = joinUrl(baseUrl, init.path, init.query)
    let res: Response
    try {
      const doFetch = fetchImpl ?? globalThis.fetch
      const timeoutMs = init.timeoutMs ?? (init.rawBody !== undefined ? TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
      res = await fetchWithTimeout(doFetch, url, {
        method: init.method,
        credentials: init.credentials ?? productRequestCredentials(init.method),
        headers,
        body:
          init.rawBody !== undefined
            ? init.rawBody
            : init.body === undefined
              ? undefined
              : typeof init.body === 'string'
                ? init.body
                : JSON.stringify(init.body),
        signal: init.signal,
      }, timeoutMs)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      if (isTimeoutError(err)) throw requestTimeoutError()
      throw parseProductError(
        0,
        {
          error: {
            code: 'transport_error',
            message: err instanceof Error ? err.message : 'Network error',
            recovery: 'same_request',
            sameRequestRetrySafe: true,
          },
        },
        {},
      )
    }

    if (res.status === 204 || (init.emptyOk && res.status === 204)) {
      invalidate()
      return undefined as T
    }

    const body = await readBody(res)
    if (!res.ok) {
      throw parseProductError(res.status, body, headersToRecord(res))
    }

    invalidate()
    if (init.includeEtag) {
      const etag = asStrongEntityTag(res.headers.get('etag') ?? '')
      if (!etag || !body || typeof body !== 'object') {
        throw parseProductError(0, { error: { code: 'transport_error', message: 'Reading Progress response omitted its strong ETag.', recovery: 'same_request', sameRequestRetrySafe: true } }, {})
      }
      return { ...(body as object), etag } as T
    }
    return body as T
  }

  function mutationHeaders(opts: MutationCallOptions, extra?: Record<string, string>): Record<string, string> {
    const commandId = allocateCommandId(opts.commandIntentId)
    const headers: Record<string, string> = {
      'X-CSRF-Token': opts.csrfToken,
      'Known-Command-Id': commandId,
      ...extra,
    }
    if (origin) headers.Origin = origin
    if (opts.ifMatch) headers['If-Match'] = asStrongEntityTag(opts.ifMatch) ?? opts.ifMatch
    if (opts.ifContentMatch) headers['If-Content-Match'] = opts.ifContentMatch
    return headers
  }

  return { origin, fetchImpl, request, mutationHeaders }
}
