import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError, parseProductError, wrapProductError } from './errors'
import { retryDelayMs, withSameRequestRetry } from './product-client-shared'
import { createProductTransportHttp } from './product-transport-http'
import { productClient } from './productClient'
import { REQUEST_TIMEOUT_MS } from './requestTimeout'

/* R15-12: a brownout must surface an error quickly, and must not multiply
   read traffic. */

function unavailable(retryAfter?: string): ProductApiError {
  // A non-JSON 5xx (nginx or Cloudflare page) classifies as internal_error.
  return new ProductApiError(parseProductError(503, null, retryAfter ? { 'retry-after': retryAfter } : {}))
}

function commandInProgress(): ProductApiError {
  return new ProductApiError(parseProductError(409, {
    error: { code: 'command_in_progress', message: 'busy', recovery: 'same_request', sameRequestRetrySafe: true },
  }, { 'retry-after': '1' }))
}

describe('Product read retry budget', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('rejects a 503 with Retry-After: 30 at once, without sleeping or retrying', async () => {
    const run = vi.fn(async () => { throw unavailable('30') })
    const result = withSameRequestRetry(run, {})
    await expect(result).rejects.toMatchObject({ status: 503, code: 'internal_error' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('attempts a failing read at most twice', async () => {
    const run = vi.fn(async () => { throw unavailable() })
    const result = withSameRequestRetry(run, {})
    const settled = expect(result).rejects.toMatchObject({ status: 503 })
    await vi.runAllTimersAsync()
    await settled
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('sleeps on a short Retry-After and uses full jitter otherwise', () => {
    expect(retryDelayMs(unavailable('3'), 0)).toBe(3_000)
    expect(retryDelayMs(unavailable('6'), 0)).toBeNull()
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    expect(retryDelayMs(unavailable(), 0)).toBeLessThan(500)
    expect(retryDelayMs(unavailable(), 10)).toBeLessThan(8_000)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(retryDelayMs(unavailable(), 3)).toBe(0)
  })

  it('keeps the longer same-command budget for command_in_progress', async () => {
    const run = vi.fn(async () => { throw commandInProgress() })
    const result = withSameRequestRetry(run, {})
    const settled = expect(result).rejects.toMatchObject({ code: 'command_in_progress' })
    await vi.runAllTimersAsync()
    await settled
    expect(run).toHaveBeenCalledTimes(5)
  })
})

describe('Product request timeout', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const hungFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }))

  it('rejects a hung fetch at 15 s as a transport error that is not retried', async () => {
    hungFetch.mockClear()
    const transport = createProductTransportHttp({ baseUrl: 'https://api.test', fetchImpl: hungFetch })
    const result = withSameRequestRetry(() => transport.request({ method: 'GET', path: '/api/v1/explore' }), {})
    const settled = expect(result).rejects.toMatchObject({ status: 0, code: 'transport_error', message: 'The request timed out.' })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1)
    expect(hungFetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    await vi.runAllTimersAsync()
    expect(hungFetch).toHaveBeenCalledTimes(1)
  })

  it('still rejects with AbortError when the caller aborts', async () => {
    const transport = createProductTransportHttp({ baseUrl: 'https://api.test', fetchImpl: hungFetch })
    const controller = new AbortController()
    const result = transport.request({ method: 'GET', path: '/api/v1/explore', signal: controller.signal })
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('maps a raw TimeoutError from generated clients to the same non-retried error', () => {
    const error = wrapProductError(new DOMException('The request timed out.', 'TimeoutError'))
    expect(error).toMatchObject({ code: 'transport_error', sameRequestRetrySafe: false })
  })

  // Generated clients now get a derived signal; aborting the caller must
  // still abort the in-flight fetch.
  it('aborts a generated-client fetch when the caller aborts', async () => {
    const seen: AbortSignal[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!
      seen.push(signal)
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const controller = new AbortController()
    const result = productClient.getFeedPage({ kind: 'collection_change', limit: 12 }, { maxRetries: 0, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toBe(controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(seen[0]!.aborted).toBe(true)
    fetchMock.mockRestore()
  })

  it('times out a hung generated-client fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const result = productClient.getFeedPage({ kind: 'collection_change', limit: 12 }, {})
    const settled = expect(result).rejects.toMatchObject({ code: 'transport_error', message: 'The request timed out.' })
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    await settled
    await vi.runAllTimersAsync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockRestore()
  })
})
