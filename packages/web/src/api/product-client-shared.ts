/**
 * Shared Product client helpers. Does not import the transport module.
 */
import {
  clearCommandId,
  getOrCreateCommandId,
  rotateCommandId,
} from './commandId'
import {
  ProductApiError,
  wrapProductError,
  parseProductError,
} from './errors'
import { getCsrfToken } from './sessionStore'
import { captureMutationSession } from './mutation-session'
import type { SessionView } from './types'

/* R15-12 retry budget. A brownout must not turn every page view into five
   near-synchronised reads, or keep a page on skeletons for minutes:
   - 5xx, transport and rate-limit errors get one retry, with full jitter;
   - a Retry-After above 5 s is not slept on: the error surfaces at once and
     the page shows its own "Try again";
   - timeouts (see requestTimeout.ts) are not retried at all.
   command_in_progress is different: the server is finishing this same
   mutation, so it keeps the longer same-command budget. */
const DEFAULT_MAX_RETRIES = 1
const COMMAND_IN_PROGRESS_MAX_RETRIES = 4
const MAX_RETRY_AFTER_SLEEP_MS = 5_000

export type MutationOptions = {
  /** Stable intent key; same key reuses Known-Command-Id across retries. */
  intentId: string
  /** Clear stored command id after success (default true). */
  clearIntentOnSuccess?: boolean
  /** Max automatic retries for same_request recovery (default 1). */
  maxRetries?: number
  signal?: AbortSignal
  /** Annotation conflict recovery keeps the old command allocation until explicit user action. */
  rotateCommandOnConflict?: boolean
}

export type ReadOptions = {
  signal?: AbortSignal
  maxRetries?: number
}

export type MutationCall = <T>(
  run: (csrf: string, commandIntentId: string) => Promise<T>,
  options: MutationOptions,
) => Promise<T>

export type SessionReader = (options?: ReadOptions) => Promise<SessionView>

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Delay before the next automatic attempt, or null to surface the error now. */
export function retryDelayMs(error: ProductApiError, attempt: number): number | null {
  if (error.retryAfterSeconds != null && error.retryAfterSeconds >= 0) {
    const requested = error.retryAfterSeconds * 1000
    if (error.code === 'command_in_progress') return Math.min(requested, 30_000)
    return requested > MAX_RETRY_AFTER_SLEEP_MS ? null : requested
  }
  // Full jitter spreads a crowd of clients instead of synchronising them.
  return Math.floor(Math.random() * Math.min(8_000, 500 * 2 ** attempt))
}

export function shouldAutoRetry(error: ProductApiError): boolean {
  if (error.code === 'command_in_progress') return true
  if (error.code === 'rate_limited') return true
  if (error.code === 'feature_temporarily_unavailable') return true
  if (error.code === 'internal_error') return true
  // A timed-out request is marked not retry-safe; other transport errors are.
  if (error.code === 'transport_error') return error.sameRequestRetrySafe
  if (
    error.sameRequestRetrySafe &&
    (error.status >= 500 || error.status === 0 || error.status === 429)
  ) {
    return true
  }
  return false
}

export async function withSameRequestRetry<T>(
  run: () => Promise<T>,
  opts: { maxRetries?: number; signal?: AbortSignal },
): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await run()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      const apiErr = wrapProductError(err)
      const maxRetries = opts.maxRetries
        ?? (apiErr.code === 'command_in_progress' ? COMMAND_IN_PROGRESS_MAX_RETRIES : DEFAULT_MAX_RETRIES)
      if (!shouldAutoRetry(apiErr) || attempt >= maxRetries) {
        throw apiErr
      }
      const delay = retryDelayMs(apiErr, attempt)
      if (delay === null) throw apiErr
      attempt += 1
      await sleep(delay, opts.signal)
    }
  }
}

export function invalidAnnotationCursor(message: string): ProductApiError {
  return new ProductApiError({
    status: 400,
    code: 'invalid_cursor',
    message,
    recovery: 'restart_from_first_page',
    sameRequestRetrySafe: false,
  })
}

export function createRequireCsrf(getSession: SessionReader): () => Promise<string> {
  return async function requireCsrf(): Promise<string> {
    let csrf = getCsrfToken()
    if (!csrf) {
      await getSession()
      csrf = getCsrfToken()
    }
    if (!csrf) {
      throw new ProductApiError(
        parseProductError(
          401,
          {
            error: {
              code: 'authentication_required',
              message: 'Not authenticated (missing CSRF token). Sign in again.',
              recovery: 'user_action',
              sameRequestRetrySafe: false,
            },
          },
          {},
        ),
      )
    }
    return csrf
  }
}

export function createMutationCall(
  getSession: SessionReader,
  requireCsrf: () => Promise<string>,
): MutationCall {
  return async function mutationCall<T>(
    run: (csrf: string, commandIntentId: string) => Promise<T>,
    options: MutationOptions,
  ): Promise<T> {
    const assertOriginalSession = captureMutationSession()
    const clearOnSuccess = options.clearIntentOnSuccess !== false
    getOrCreateCommandId(options.intentId)
    let refreshedSession = false
    const attempt = async (): Promise<T> => withSameRequestRetry(async () => {
      options.signal?.throwIfAborted()
      assertOriginalSession()
      const csrf = await requireCsrf()
      options.signal?.throwIfAborted()
      assertOriginalSession()
      try {
        const result = await run(csrf, options.intentId)
        assertOriginalSession()
        if (clearOnSuccess) clearCommandId(options.intentId)
        return result
      } catch (err) {
        const apiErr = wrapProductError(err)
        if (
          options.rotateCommandOnConflict !== false
          && (apiErr.isCommandIdReused || apiErr.isCommandResultExpired)
        ) {
          rotateCommandId(options.intentId)
        }
        throw apiErr
      }
    }, { maxRetries: options.maxRetries, signal: options.signal })
    try {
      return await attempt()
    } catch (error) {
      const apiError = wrapProductError(error)
      if (!refreshedSession && apiError.isAuthRequired && !options.signal?.aborted) {
        refreshedSession = true
        assertOriginalSession()
        await getSession({ signal: options.signal, maxRetries: 0 })
        assertOriginalSession()
        return attempt()
      }
      throw apiError
    }
  }
}

export function createAuthRetryRead(getSession: SessionReader) {
  return async function authRetryRead<T>(request: () => Promise<T>, options?: ReadOptions): Promise<T> {
    try { return await withSameRequestRetry(request, { maxRetries: options?.maxRetries, signal: options?.signal }) }
    catch (error) {
      const apiError = wrapProductError(error)
      if (!apiError.isAuthRequired || options?.signal?.aborted) throw apiError
      await getSession({ signal: options?.signal, maxRetries: 0 })
      return withSameRequestRetry(request, { maxRetries: options?.maxRetries, signal: options?.signal })
    }
  }
}

export type GeneratedFollowError = Error & {
  status?: number
  problem?: unknown
  headers?: Headers
}

export function wrapGeneratedFollowError(error: unknown): ProductApiError {
  const generated = error as GeneratedFollowError
  if (typeof generated?.status === 'number') {
    return new ProductApiError(parseProductError(
      generated.status,
      generated.problem,
      generated.headers ?? {},
    ))
  }
  return wrapProductError(error)
}

export type ProductClientHelpers = {
  mutationCall: MutationCall
  requireCsrf: () => Promise<string>
  withSameRequestRetry: typeof withSameRequestRetry
  authRetryRead: ReturnType<typeof createAuthRetryRead>
  getSession: SessionReader
}
