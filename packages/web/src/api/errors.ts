/**
 * The web client's one error type and its parsing.
 *
 * Every API client (Product transport, agents, automations, auth) throws
 * ProductApiError. parseProductError turns a Product error envelope, a
 * sign-up gate body or a bare status into one; recoveryStrategyFor maps it to
 * the UI recovery.
 *
 * Client recovery enum (UX-facing, normalized from server RecoveryAction):
 *   refresh_and_retry | same_request | user_action | reauthenticate
 *
 * Normalization vs server registry:
 * - restart_from_first_page (snapshot_expired / invalid_cursor) → refresh_and_retry
 * - authentication_required / csrf_failed (server: user_action) → reauthenticate
 * - Code-based recovery wins over a mismatched envelope recovery field
 */
import { isTimeoutError } from './requestTimeout'

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

/** R15-23: plain copy for server-side failures (5xx, non-envelope errors). */
export const SERVICE_TROUBLE = 'The server is having trouble right now. Try again in a minute.'

export class ProductApiError extends Error {
  readonly name = 'ProductApiError'
  readonly status: number
  readonly code: string
  readonly requestId: string | null
  readonly recovery: ClientRecovery
  readonly sameRequestRetrySafe: boolean
  readonly precondition: 'resource' | 'content' | null
  readonly currentEtag: string | null
  readonly retryAfterSeconds: number | null
  readonly fieldErrors: ProductErrorField[]

  constructor(
    source:
      | number
      | {
          status: number
          code: string
          message: string
          recovery?: ClientRecovery | string
          sameRequestRetrySafe?: boolean
          requestId?: string | null
          precondition?: 'resource' | 'content' | null
          currentEtag?: string | null
          retryAfterSeconds?: number | null
          fieldErrors?: ProductErrorField[]
        },
    /** Legacy second arg: error object when first arg is status */
    legacyError?: {
      code: string
      message: string
      recovery?: ClientRecovery | string
      sameRequestRetrySafe?: boolean
      requestId?: string | null
      precondition?: 'resource' | 'content' | null
      currentEtag?: string | null
      retryAfterSeconds?: number | null
      fieldErrors?: ProductErrorField[]
    } | null,
    legacyMessage?: string,
  ) {
    // Legacy: new ProductApiError(status, error, message?)
    if (typeof source === 'number') {
      const status = source
      const error = legacyError
      const message = error?.message || legacyMessage || `Product API error (${status})`
      super(message)
      this.status = status
      this.code = error?.code ?? (status === 0 ? 'transport_error' : 'unknown_error')
      this.requestId = error?.requestId ?? null
      this.recovery = (error?.recovery as ClientRecovery | undefined)
        ?? recoveryForCode(this.code)
      this.sameRequestRetrySafe =
        error?.sameRequestRetrySafe
        ?? (status >= 500 || status === 0 || status === 429)
      this.precondition = error?.precondition ?? null
      this.currentEtag = error?.currentEtag ?? null
      this.retryAfterSeconds = error?.retryAfterSeconds ?? null
      this.fieldErrors = error?.fieldErrors ?? []
      return
    }

    super(source.message)
    this.status = source.status
    this.code = source.code
    this.requestId = source.requestId ?? null
    this.recovery = (source.recovery as ClientRecovery | undefined)
      ?? recoveryForCode(source.code)
    this.sameRequestRetrySafe = source.sameRequestRetrySafe ?? false
    this.precondition = source.precondition ?? null
    this.currentEtag = source.currentEtag ?? null
    this.retryAfterSeconds = source.retryAfterSeconds ?? null
    this.fieldErrors = source.fieldErrors ?? []
  }

  get isAuthRequired(): boolean {
    if (this.code === 'verification_required') return false
    return this.code === 'authentication_required' || this.status === 401
  }

  get isVerificationRequired(): boolean {
    return this.code === 'verification_required'
  }

  get isCsrfFailed(): boolean {
    return this.code === 'csrf_failed'
  }

  get isPreconditionFailed(): boolean {
    return this.code === 'precondition_failed' || this.code === 'precondition_required'
  }

  get isSnapshotExpired(): boolean {
    return this.code === 'snapshot_expired' || this.code === 'invalid_cursor'
  }

  get isCommandInProgress(): boolean {
    return this.code === 'command_in_progress'
  }

  get isCommandResultExpired(): boolean {
    return this.code === 'command_result_expired'
  }

  get isCommandIdReused(): boolean {
    return this.code === 'command_id_reused'
  }

  get isFolderNotEmpty(): boolean {
    return this.code === 'folder_not_empty'
  }

  get recoveryHint(): string {
    switch (this.code) {
      case 'precondition_failed':
      case 'precondition_required':
      case 'revision_conflict':
      case 'position_context_stale':
        return 'This item changed. Refresh and try again.'
      case 'snapshot_expired':
      case 'invalid_cursor':
        /* Only surfaces after the automatic restart budget is spent, so this
           is a final failure — nothing is still reloading. 'Snapshot' stays:
           the same surfaces already say 'Refreshing the collection snapshot…'. */
        return 'The snapshot expired. Reload and try again.'
      case 'command_in_progress':
        /* The transport never auto-retries this code; by the time it reaches a
           catch the retry is manual, so do not claim one is in flight. */
        return 'Your previous request is still running. Try again in a moment.'
      case 'command_result_expired':
        return 'The result of that action expired. Refresh the current state and try again.'
      case 'command_id_reused':
        return 'This action conflicts with an earlier request. Refresh and try again.'
      case 'csrf_failed':
        return 'Session security token expired. Refresh the page and try again.'
      case 'authentication_required':
        return 'Sign in to continue.'
      case 'folder_not_empty':
        return 'Folder is not empty. Delete it together with everything inside.'
      case 'library_protected':
        return 'Your library and its browser folders are permanent. Create or edit a folder inside them.'
      case 'root_immutable':
        return 'The collection root cannot be modified or deleted.'
      case 'rate_limited':
      case 'feature_temporarily_unavailable':
        return this.retryAfterSeconds != null
          ? `Temporarily unavailable. Retry in ${this.retryAfterSeconds}s.`
          : 'Temporarily unavailable. Retry shortly.'
      case 'resource_not_found':
        return 'Resource not found or not accessible.'
      case 'invalid_document':
        return this.fieldErrors.length
          ? this.fieldErrors.map((f) => f.message).join('; ')
          : this.message
      case 'internal_error':
      case 'unknown_error':
        return SERVICE_TROUBLE
      case 'transport_error':
        /* Surfaced only after the transport's own retry budget is spent, so
           this is a final failure, not an in-flight retry status — match the
           auth surfaces' phrasing instead of describing a retry that is not
           running. */
        return 'Network error. Check your connection and try again.'
      default:
        // R15-23: never show "Product API error (503)" to a visitor.
        return this.status >= 500 ? SERVICE_TROUBLE : this.message
    }
  }
}

export function isProductApiError(err: unknown): err is ProductApiError {
  return err instanceof ProductApiError
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

const SIGN_UP_GATE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  setup_token_required: 'That setup token does not match this server. Copy it again.',
  registration_closed: 'Registration is closed on this server.',
})

/** Parse a Product error envelope (or non-envelope body) into ProductApiError. */
export function parseProductError(
  status: number,
  body: unknown,
  headers: Headers | Record<string, string> = {},
): ProductApiError {
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

      return new ProductApiError({
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

  // The server's sign-up gates (G2 owner gate, D27 first-run token) answer
  // 403 with a bare `{ code }` body, not the product envelope. Keep their
  // codes so the register form can point at the right field; the copy is
  // fixed here, never the server's message.
  const gateCode = body && typeof body === 'object' && 'code' in body
    ? (body as { code?: unknown }).code
    : undefined
  if (status === 403 && typeof gateCode === 'string' && Object.hasOwn(SIGN_UP_GATE_MESSAGES, gateCode)) {
    return new ProductApiError({
      status,
      code: gateCode,
      recovery: 'user_action',
      message: SIGN_UP_GATE_MESSAGES[gateCode]!,
      sameRequestRetrySafe: false,
    })
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
  return new ProductApiError({
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
export function requestTimeoutError(): ProductApiError {
  return new ProductApiError({
    status: 0,
    code: 'transport_error',
    recovery: 'same_request',
    message: 'The request timed out.',
    sameRequestRetrySafe: false,
  })
}

/** No answer arrived; the same request is safe to send again. */
export function transportError(message = 'The server could not be reached.'): ProductApiError {
  return new ProductApiError({
    status: 0,
    code: 'transport_error',
    message,
    recovery: 'same_request',
    sameRequestRetrySafe: true,
  })
}

export function wrapProductError(err: unknown): ProductApiError {
  if (err instanceof ProductApiError) return err
  if (err instanceof DOMException && err.name === 'AbortError') throw err
  if (isTimeoutError(err)) return requestTimeoutError()
  return transportError(err instanceof Error ? err.message : 'Network error')
}

/** A generated client rejects with the response status, problem body and headers. */
export function wrapGeneratedClientError(error: unknown): ProductApiError {
  const generated = error as { status?: number; problem?: unknown; headers?: Headers }
  if (typeof generated?.status === 'number') {
    return parseProductError(generated.status, generated.problem, generated.headers ?? {})
  }
  return wrapProductError(error)
}

export type RecoveryStrategy =
  | 'retry_same_command'
  | 'refresh_and_retry'
  | 'restart_editor_from_first_page'
  | 'rebootstrap_session'
  | 'require_login'
  | 'new_user_intent'
  | 'user_confirm_recursive'
  | 'show_message'
  | 'none'

export function recoveryStrategyFor(error: ProductApiError): RecoveryStrategy {
  switch (error.code) {
    case 'command_in_progress':
    case 'rate_limited':
    case 'internal_error':
    case 'feature_temporarily_unavailable':
    case 'transport_error':
      return 'retry_same_command'
    case 'precondition_failed':
    case 'precondition_required':
    case 'revision_conflict':
    case 'position_context_stale':
      return 'refresh_and_retry'
    case 'snapshot_expired':
    case 'invalid_cursor':
      return 'restart_editor_from_first_page'
    case 'csrf_failed':
      return 'rebootstrap_session'
    case 'authentication_required':
      return 'require_login'
    case 'command_id_reused':
    case 'command_result_expired':
      return 'new_user_intent'
    case 'folder_not_empty':
      return 'user_confirm_recursive'
    case 'root_immutable':
    case 'resource_not_found':
      return 'none'
    default:
      return 'show_message'
  }
}

/**
 * Parse Product error envelope body → error object for ProductApiError construction.
 * Prefer parseProductError for status+headers-aware client recovery.
 */
export function parseProductErrorEnvelope(data: unknown): {
  code: string
  message: string
  requestId?: string | null
  recovery?: ClientRecovery | string
  sameRequestRetrySafe?: boolean
  precondition?: 'resource' | 'content' | null
  currentEtag?: string | null
  retryAfterSeconds?: number | null
  fieldErrors?: ProductErrorField[]
} | null {
  if (!data || typeof data !== 'object') return null
  const env = data as { error?: unknown }
  const error = env.error
  if (!error || typeof error !== 'object') return null
  const e = error as Record<string, unknown>
  if (typeof e.code !== 'string' || typeof e.message !== 'string') return null
  return {
    code: e.code,
    message: e.message,
    requestId: typeof e.requestId === 'string' ? e.requestId : null,
    recovery: typeof e.recovery === 'string' ? e.recovery : undefined,
    sameRequestRetrySafe: typeof e.sameRequestRetrySafe === 'boolean' ? e.sameRequestRetrySafe : undefined,
    precondition:
      e.precondition === 'resource' || e.precondition === 'content' || e.precondition === null
        ? e.precondition
        : null,
    currentEtag: typeof e.currentEtag === 'string' ? e.currentEtag : null,
    retryAfterSeconds: typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : null,
    fieldErrors: Array.isArray(e.fieldErrors)
      ? (e.fieldErrors as ProductErrorField[])
      : [],
  }
}
