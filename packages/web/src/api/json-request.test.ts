/* quality-02: one fetch path and one error type for every web API client.
 *
 * The Product transport, agents, automations and auth each used to wrap
 * fetch, decode bodies and map failures on their own, through two error
 * classes. Agent calls had no deadline at all. These cases drive the shared
 * path and each client through it; the boundary case keeps a client from
 * growing its own fetch again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentsSource from './agentsClient.ts?raw'
import authSource from './authClient.ts?raw'
import automationSource from './automationClient.ts?raw'
import transportSource from './product-transport-http.ts?raw'
import { listAgents } from './agentsClient'
import { authClient } from './authClient'
import { ProductApiError } from './errors'
import { requestJson } from './json-request'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})

describe('requestJson', () => {
  it('turns a lost connection, an error envelope and a bare 5xx into ProductApiError', async () => {
    await expect(requestJson('/api', {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch') } }))
      .rejects.toMatchObject({ name: 'ProductApiError', status: 0, code: 'transport_error',
        message: 'The server could not be reached.', sameRequestRetrySafe: true })
    const envelope = requestJson('/api', {}, { fetchImpl: async () => json({ error: {
      code: 'rate_limited', message: 'Slow down', recovery: 'same_request' } }, 429) })
    await expect(envelope).rejects.toBeInstanceOf(ProductApiError)
    await expect(envelope).rejects.toMatchObject({ status: 429, code: 'rate_limited', recovery: 'same_request' })
    await expect(requestJson('/api', {}, { fetchImpl: async () => new Response('<html>', { status: 503 }) }))
      .rejects.toMatchObject({ status: 503, code: 'internal_error' })
  })

  it('passes a caller abort through and reads a 204 without its body', async () => {
    const abort = new DOMException('stop', 'AbortError')
    await expect(requestJson('/api', {}, { fetchImpl: async () => { throw abort } })).rejects.toBe(abort)
    const text = vi.fn()
    const empty = new Response(null, { status: 204 })
    Object.defineProperty(empty, 'text', { value: text })
    expect(await requestJson('/api', {}, { fetchImpl: async () => empty })).toMatchObject({ status: 204, body: null })
    expect(text).not.toHaveBeenCalled()
  })

  it('keeps a non-JSON body as raw text unless the client requires JSON', async () => {
    const html = () => new Response('<p>ok</p>', { status: 200 })
    expect((await requestJson('/api', {}, { fetchImpl: async () => html() })).body).toEqual({ raw: '<p>ok</p>' })
    const strict = new ProductApiError({ status: 502, code: 'invalid_document', message: 'Not JSON.' })
    await expect(requestJson('/api', {}, { fetchImpl: async () => html(), strictJson: () => strict })).rejects.toBe(strict)
  })

  it('drops an answer once the caller no longer wants it', async () => {
    let current = true
    const pending = requestJson('/api', {}, {
      fetchImpl: async () => { current = false; return json({ ok: true }) },
      assertCurrent: () => { if (!current) throw new DOMException('Your session changed.', 'AbortError') },
    })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('every client shares the deadline and the error type', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  function stalled() {
    return vi.fn(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{')) } }), {
      headers: { 'content-type': 'application/json' },
    }))
  }

  it('times out an agent read that used to wait forever', async () => {
    const failure = expect(listAgents({ fetch: stalled() }))
      .rejects.toMatchObject({ name: 'ProductApiError', code: 'transport_error', message: 'The request timed out.' })
    await vi.advanceTimersByTimeAsync(15_000)
    await failure
  })

  it('times out an auth read and reports it as ProductApiError', async () => {
    vi.stubGlobal('fetch', stalled())
    const failure = expect(authClient.getRegistrationState())
      .rejects.toMatchObject({ name: 'ProductApiError', code: 'transport_error', sameRequestRetrySafe: false })
    await vi.advanceTimersByTimeAsync(15_000)
    await failure
  })

  it('leaves fetch, body decoding and error parsing to json-request', () => {
    for (const [name, source] of Object.entries({ agentsSource, authSource, automationSource, transportSource })) {
      expect(source, name).not.toMatch(/fetchWithTimeout|parseProductError|JSON\.parse\(|\.text\(\)/u)
      expect(source, name).toContain("from './json-request'")
    }
  })
})
