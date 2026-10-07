/**
 * Request timeouts (R15-12). No Product or auth fetch may hang for nginx's
 * 60 s upstream wait: a request that has not answered in 15 s rejects with a
 * `TimeoutError`, which the error layer maps to a non-retried
 * `transport_error`, so pages reach their error state instead of skeletons.
 */
export const REQUEST_TIMEOUT_MS = 15_000
/** Uploads and export downloads move real bytes; give them longer. */
export const TRANSFER_TIMEOUT_MS = 120_000

export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

/**
 * Runs one fetch under a deadline. The caller's own signal still aborts it
 * (rejecting with AbortError as before); only the deadline yields
 * `TimeoutError`. The timer is cleared once the response headers arrive.
 */
export async function fetchWithTimeout(
  doFetch: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  ms = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const outer = init.signal ?? undefined
  const controller = new AbortController()
  let timedOut = false
  const timer = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  const forward = () => controller.abort(outer?.reason)
  if (outer?.aborted) forward()
  else outer?.addEventListener('abort', forward, { once: true })
  try {
    return await doFetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut && !outer?.aborted) throw new DOMException('The request timed out.', 'TimeoutError')
    throw error
  } finally {
    globalThis.clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  }
}

/** A `fetch` for generated clients: the caller's signal plus the deadline. */
export function timedFetch(signal?: AbortSignal, ms = REQUEST_TIMEOUT_MS): typeof globalThis.fetch {
  return (input, init) =>
    fetchWithTimeout(globalThis.fetch, input, { ...init, ...(signal ? { signal } : {}) }, ms)
}
