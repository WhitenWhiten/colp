/**
 * The fetch path every web API client shares: the Product transport, agents,
 * automations and auth. One deadline, one abort and failure mapping, one body
 * decoder and the Product error envelope, plus the headers a session mutation
 * carries.
 */
import { getApiBaseUrl } from './config'
import { parseProductError, ProductApiError, requestTimeoutError, transportError } from './errors'
import { fetchWithTimeout, isTimeoutError, REQUEST_TIMEOUT_MS } from './requestTimeout'
import { getCsrfToken } from './sessionStore'

export type JsonResponse = { readonly status: number; readonly headers: Headers; readonly body: unknown }

export type JsonRequestOptions = {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  /** Runs after the headers and again after the body; throw to drop an answer nobody waits for. */
  readonly assertCurrent?: () => void
  /** Rejects a successful body that is not JSON instead of returning it as `{ raw }`. */
  readonly strictJson?: () => ProductApiError
}

/** Resolves a 2xx answer (a 204 has a null body) and throws every failure as ProductApiError, except a caller's abort. */
export async function requestJson(url: string, init: RequestInit, options: JsonRequestOptions = {}): Promise<JsonResponse> {
  let response: Response
  let text: string
  try {
    response = await fetchWithTimeout(options.fetchImpl ?? globalThis.fetch, url, init, options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    options.assertCurrent?.()
    if (response.status === 204) return { status: 204, headers: response.headers, body: null }
    text = await response.text()
    options.assertCurrent?.()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw isTimeoutError(error) ? requestTimeoutError() : transportError()
  }
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      if (response.ok && options.strictJson) throw options.strictJson()
      body = { raw: text }
    }
  }
  if (!response.ok) throw parseProductError(response.status, body, response.headers)
  return { status: response.status, headers: response.headers, body }
}

/** The API origin, or the page origin when the API is same-origin; what a session mutation names in Origin. */
export function requestOrigin(baseUrl = getApiBaseUrl()): string | undefined {
  if (baseUrl) {
    try {
      return new URL(baseUrl).origin
    } catch {
      /* A relative base is same-origin. */
    }
  }
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return typeof origin === 'string' && origin && origin !== 'null' ? origin : undefined
}

/** The in-memory CSRF token a session mutation sends; without one the user must sign in again. */
export function requireCsrfToken(changing: string): string {
  const token = getCsrfToken()
  if (!token) {
    throw new ProductApiError({
      status: 401,
      code: 'authentication_required',
      message: `Sign in again before changing ${changing}.`,
      recovery: 'user_action',
    })
  }
  return token
}

export function invalidRequest(message: string): ProductApiError {
  return new ProductApiError({ status: 400, code: 'invalid_request', message, recovery: 'user_action' })
}

/** A 2xx answer this client cannot use; the same request may answer properly. */
export function badResponse(message: string): ProductApiError {
  return new ProductApiError({
    status: 502,
    code: 'invalid_document',
    message,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
  })
}
