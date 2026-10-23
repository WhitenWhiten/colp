/** Deadlines cover headers and the complete response body, including generated clients. */
export const REQUEST_TIMEOUT_MS = 15_000
export const TRANSFER_TIMEOUT_MS = 120_000

export function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError'
}

/** Preserve streaming/backpressure while retaining the deadline until EOF or cancellation. */
function deadlineResponse(response: Response, signal: AbortSignal, cleanup: () => void): Response {
  if (!response.body) { cleanup(); return response }
  const reader = response.body.getReader()
  let finished = false
  let onAbort: () => void
  const finish = () => {
    if (finished) return false
    finished = true
    cleanup()
    signal.removeEventListener('abort', onAbort)
    return true
  }
  const cancel = (reason: unknown) => {
    void reader.cancel(reason).finally(() => reader.releaseLock()).catch(() => {})
  }
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      onAbort = () => {
        if (!finish()) return
        stream.error(signal.reason)
        cancel(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    },
    async pull(stream) {
      try {
        const chunk = await reader.read()
        if (finished) return
        if (chunk.done) {
          finish(); reader.releaseLock(); stream.close()
        } else stream.enqueue(chunk.value)
      } catch (error) {
        if (finish()) { reader.releaseLock(); stream.error(signal.aborted ? signal.reason : error) }
      }
    },
    cancel(reason) { if (finish()) cancel(reason) },
  })
  const result = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const property of ['url', 'redirected', 'type'] as const) {
    Object.defineProperty(result, property, { value: response[property] })
  }
  return result
}

/** One deadline for fetch and body consumption; caller cancellation remains active after headers. */
export async function fetchWithTimeout(
  doFetch: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  ms = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const outer = init.signal ?? (input instanceof Request ? input.signal : undefined)
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), ms)
  const forward = () => controller.abort(outer?.reason)
  const cleanup = () => {
    globalThis.clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  }
  if (outer?.aborted) forward()
  else outer?.addEventListener('abort', forward, { once: true })
  try {
    controller.signal.throwIfAborted()
    const response = await doFetch(input, { ...init, signal: controller.signal })
    if (controller.signal.aborted) {
      void response.body?.cancel(controller.signal.reason).catch(() => {})
      controller.signal.throwIfAborted()
    }
    return deadlineResponse(response, controller.signal, cleanup)
  } catch (error) {
    cleanup()
    throw controller.signal.aborted ? controller.signal.reason : error
  }
}

export function timedFetch(signal?: AbortSignal, ms = REQUEST_TIMEOUT_MS): typeof globalThis.fetch {
  return (input, init) => fetchWithTimeout(globalThis.fetch, input, { ...init, ...(signal ? { signal } : {}) }, ms)
}
