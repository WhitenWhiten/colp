/**
 * Product error envelope parsing and client recovery mapping.
 *
 * Client recovery enum (UX-facing, normalized from server RecoveryAction):
 *   refresh_and_retry | same_request | user_action | reauthenticate
 *
 * Normalization vs server registry:
 * - restart_from_first_page (snapshot_expired / invalid_cursor) → refresh_and_retry
 * - authentication_required / csrf_failed (server: user_action) → reauthenticate
 * - Code-based recovery wins over a mismatched envelope recovery field
 */

export type ClientRecovery =
  | 'refresh_and_retry'
  | 'same_request'
  | 'user_action'
  | 'reauthenticate'

export type ProductErrorField = {
  path: string
  code: string
  message: string
}

export class ProductClientError extends Error {
  readonly name = 'ProductClientError'
  readonly status: number
  readonly code: string
  readonly recovery: ClientRecovery
  readonly sameRequestRetrySafe: boolean
  readonly requestId: string | null
  readonly message: string
  readonly precondition: 'resource' | 'content' | null
  readonly currentEtag: string | null
  readonly retryAfterSeconds: number | null
  readonly fieldErrors: ProductErrorField[]

  constructor(init: {
    status: number
    code: string
    recovery: ClientRecovery
    message: string
    sameRequestRetrySafe?: boolean
    requestId?: string | null
    precondition?: 'resource' | 'content' | null
    currentEtag?: string | null
    retryAfterSeconds?: number | null
    fieldErrors?: ProductErrorField[]
  }) {
    super(init.message)
    this.status = init.status
    this.code = init.code
    this.recovery = init.recovery
    this.sameRequestRetrySafe = init.sameRequestRetrySafe ?? false
    this.requestId = init.requestId ?? null
    this.message = init.message
    this.precondition = init.precondition ?? null
    this.currentEtag = init.currentEtag ?? null
    this.retryAfterSeconds = init.retryAfterSeconds ?? null
    this.fieldErrors = init.fieldErrors ?? []
  }
}

export function isProductClientError(err: unknown): err is ProductClientError {
  return err instanceof ProductClientError
}

/** Map known Product error codes to client recovery (code wins over envelope). */
export function recoveryForCode(code: string, envelopeRecovery?: string): ClientRecovery {
  switch (code) {
    case 'precondition_failed':
    case 'precondition_required':
    case 'revision_conflict':
    case 'position_context_stale':
    case 'snapshot_expired':
    case 'invalid_cursor':
      return 'refresh_and_retry'
    case 'command_in_progress':
    case 'rate_limited':
    case 'internal_error':
    case 'feature_temporarily_unavailable':
    case 'transport_error':
      return 'same_request'
    case 'authentication_required':
    case 'csrf_failed':
      return 'reauthenticate'
    case 'command_result_expired':
    case 'command_id_reused':
      return 'user_action'
    default:
      break
  }

  // Normalize server-only recovery values
  if (envelopeRecovery === 'restart_from_first_page') return 'refresh_and_retry'
  if (envelopeRecovery === 'same_request') return 'same_request'
  if (envelopeRecovery === 'refresh_and_retry') return 'refresh_and_retry'
  if (envelopeRecovery === 'reauthenticate') return 'reauthenticate'
  if (envelopeRecovery === 'user_action' || envelopeRecovery === 'none') return 'user_action'

  return 'user_action'
}

function headerMap(headers: Headers | Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>()
  if (!headers) return map
  if (headers instanceof Headers) {
    headers.forEach((v, k) => map.set(k.toLowerCase(), v))
    return map
  }
  for (const [k, v] of Object.entries(headers)) {
    map.set(k.toLowerCase(), v)
  }
  return map
}

function parseRetryAfter(
  bodySeconds: unknown,
  headers: Map<string, string>,
): number | null {
  if (typeof bodySeconds === 'number' && Number.isFinite(bodySeconds) && bodySeconds >= 0) {
    return bodySeconds
  }
  const raw = headers.get('retry-after')
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Parse a Product error envelope (or non-envelope body) into ProductClientError.
 */
export function parseProductError(
  status: number,
  body: unknown,
  headers: Headers | Record<string, string> = {},
): ProductClientError {
  const hdrs = headerMap(headers)

  if (body && typeof body === 'object' && 'error' in body) {
    const env = body as { error?: Record<string, unknown> }
    const error = env.error
    if (error && typeof error === 'object' && typeof error.code === 'string') {
      const code = error.code
      const envelopeRecovery =
        typeof error.recovery === 'string' ? error.recovery : undefined
      const recovery = recoveryForCode(code, envelopeRecovery)
      const message =
        typeof error.message === 'string' && error.message
          ? error.message
          : code
      const sameRequestRetrySafe =
        typeof error.sameRequestRetrySafe === 'boolean'
          ? error.sameRequestRetrySafe
          : recovery === 'same_request'
      const precondition =
        error.precondition === 'resource' || error.precondition === 'content'
          ? error.precondition
          : null
      const currentEtag =
        typeof error.currentEtag === 'string' ? error.currentEtag : null
      const requestId =
        typeof error.requestId === 'string' ? error.requestId : null
      const fieldErrors = Array.isArray(error.fieldErrors)
        ? (error.fieldErrors as ProductErrorField[]).filter(
            (f) => f && typeof f === 'object' && typeof f.message === 'string',
          )
        : []
      const retryAfterSeconds = parseRetryAfter(error.retryAfterSeconds, hdrs)

      return new ProductClientError({
        status,
        code,
        recovery,
        message,
        sameRequestRetrySafe,
        requestId,
        precondition,
        currentEtag,
        retryAfterSeconds,
        fieldErrors,
      })
    }
  }

  // A bare 403 is not CSRF evidence: proxy/policy refusals must never trigger
  // session recovery and automatic mutation replay.
  // Non-envelope / transport fallback
  const code =
    status === 0
      ? 'transport_error'
      : status >= 500
        ? 'internal_error'
        : status === 401
          ? 'authentication_required'
          : 'unknown_error'
  const recovery = recoveryForCode(code)
  return new ProductClientError({
    status,
    code,
    recovery,
    message: `Product API error (${status})`,
    sameRequestRetrySafe: recovery === 'same_request',
    retryAfterSeconds: parseRetryAfter(null, hdrs),
  })
}

/** A request that hit the client deadline (R15-12). Not retried: the reader
    already waited, so the page shows its error and "Try again" instead. */
export function requestTimeoutError(): ProductClientError {
  return new ProductClientError({
    status: 0,
    code: 'transport_error',
    recovery: 'same_request',
    message: 'The request timed out.',
    sameRequestRetrySafe: false,
  })
}
