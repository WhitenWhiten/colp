import { describe, expect, it, vi } from 'vitest';
import { readPublicationJsonRequest } from '../../src/server/publication-http-utf8.js';
import { readPublicationRequestBytes } from '../../src/server/publication-request-body.js';

type RequestOptions = NonNullable<ConstructorParameters<typeof Request>[1]>;
function request(body: NonNullable<RequestOptions['body']>, headers?: RequestOptions['headers']): Request {
  return new Request('https://example.test/', { method: 'POST', body, duplex: 'half',
    ...(headers === undefined ? {} : { headers }) } as RequestOptions);
}

describe('Publication request body budgets', () => {
  it('accepts an exact byte boundary and rejects one extra byte', async () => {
    await expect(readPublicationJsonRequest(request('null'), { maxBytes: 4 })).resolves.toBeNull();
    await expect(readPublicationJsonRequest(request('null '), { maxBytes: 4 })).rejects.toBeInstanceOf(RangeError);
  });
  it('counts actual chunks even when Content-Length is absent or under-reports', async () => {
    for (const headers of [undefined, { 'content-length': '1' }]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel,
      });
      await expect(readPublicationRequestBytes(request(body, headers), { maxBytes: 4 })).rejects.toThrow('exceeds');
      expect(cancel).toHaveBeenCalled();
    }
  });
  it('rejects an oversized declaration before reading and cancels the body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(readPublicationRequestBytes(request(body, { 'content-length': '5' }), { maxBytes: 4 })).rejects.toThrow('exceeds');
    expect(cancel).toHaveBeenCalled();
  });
  it('does not wait forever for an unfinished stream', async () => {
    await expect(readPublicationRequestBytes(request(new ReadableStream()), { timeoutMs: 10 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('preserves a caller cancellation reason', async () => {
    const controller = new AbortController();
    const reason = new Error('revoked');
    const result = readPublicationRequestBytes(request(new ReadableStream()), { signal: controller.signal });
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });
  it('retains fatal UTF-8 decoding', async () => {
    await expect(readPublicationJsonRequest(request(new Uint8Array([0xff])))).rejects.toThrow();
  });
});
