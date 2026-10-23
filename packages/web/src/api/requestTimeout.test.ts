import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchWithTimeout } from './requestTimeout'
import { createProductTransportHttp } from './product-transport-http'
import { createAutomationApi } from './automationClient'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function stalled() {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')) }, cancel }), {
    headers: { 'content-type': 'application/json' },
  })
  return { cancel, fetch: vi.fn(async () => response) }
}
it('times out a stalled response body and cancels its source after headers', async () => {
  const f = stalled(), response = await fetchWithTimeout(f.fetch, '/api', {}, 100)
  const body = response.text(), failure = expect(body).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(100)
  await failure; expect(f.cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
})
it('forwards caller cancellation after headers', async () => {
  const f = stalled(), controller = new AbortController()
  const response = await fetchWithTimeout(f.fetch, '/api', { signal: controller.signal })
  const failure = expect(response.text()).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort(); await failure; expect(f.cancel).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
})
it('releases the deadline after EOF or explicit cancellation and preserves response metadata', async () => {
  const original = Response.json({ ok: true }, { status: 201, headers: { etag: '"v1"' } })
  Object.defineProperty(original, 'url', { value: 'https://example.test/api' })
  const response = await fetchWithTimeout(async () => original, '/api')
  expect(response.url).toBe(original.url); expect(response.status).toBe(201); expect(response.headers.get('etag')).toBe('"v1"')
  expect(await response.json()).toEqual({ ok: true }); expect(vi.getTimerCount()).toBe(0)
  const f = stalled(), unused = await fetchWithTimeout(f.fetch, '/api')
  await unused.body!.cancel(); expect(vi.getTimerCount()).toBe(0); expect(f.cancel).toHaveBeenCalledOnce()
})
it('maps body deadlines to the Product transport timeout error', async () => {
  const f = stalled(), transport = createProductTransportHttp({ fetchImpl: f.fetch })
  const failure = expect(transport.request({ method: 'GET', path: '/api', timeoutMs: 100 }))
    .rejects.toMatchObject({ code: 'transport_error', sameRequestRetrySafe: false })
  await vi.advanceTimersByTimeAsync(100); await failure
})
it('applies the same deadline to automation reads', async () => {
  const f = stalled(), failure = expect(createAutomationApi(f.fetch).listRules()).rejects.toMatchObject({ code: 'transport_error', sameRequestRetrySafe: false })
  await vi.advanceTimersByTimeAsync(15000); await failure
})
