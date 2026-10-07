/**
 * App-facing Product API errors + recovery strategy for UI banners.
 * Transport parsing: product-error.ts (parseProductError / ProductClientError).
 */
import {
  parseProductError,
  ProductClientError,
  recoveryForCode,
  requestTimeoutError,
  type ClientRecovery,
} from './product-error'
import { isTimeoutError } from './requestTimeout'

export {
  parseProductError,
  ProductClientError,
  isProductClientError,
  recoveryForCode,
  type ClientRecovery,
} from './product-error'

/** R15-23: plain copy for server-side failures (5xx, non-envelope errors). */
export const SERVICE_TROUBLE = 'Know-N is having trouble right now. Try again in a minute.'

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
  readonly fieldErrors: ProductClientError['fieldErrors']

  constructor(
    source:
      | number
      | ProductClientError
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
          fieldErrors?: ProductClientError['fieldErrors']
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
      fieldErrors?: ProductClientError['fieldErrors']
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

    if (source instanceof ProductClientError) {
      super(source.message)
      this.status = source.status
      this.code = source.code
      this.requestId = source.requestId
      this.recovery = source.recovery
      this.sameRequestRetrySafe = source.sameRequestRetrySafe
      this.precondition = source.precondition
      this.currentEtag = source.currentEtag
      this.retryAfterSeconds = source.retryAfterSeconds
      this.fieldErrors = source.fieldErrors
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

export function wrapProductError(err: unknown): ProductApiError {
  if (err instanceof ProductApiError) return err
  if (err instanceof ProductClientError) return new ProductApiError(err)
  if (err instanceof DOMException && err.name === 'AbortError') throw err
  if (isTimeoutError(err)) return new ProductApiError(requestTimeoutError())
  return new ProductApiError(
    parseProductError(
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
    ),
  )
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
  fieldErrors?: ProductClientError['fieldErrors']
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
      ? (e.fieldErrors as ProductClientError['fieldErrors'])
      : [],
  }
}
