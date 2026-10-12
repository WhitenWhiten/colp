export interface JsonResponseReadOptions {
  readonly timeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

/** Bound the entire body read, including peers that send headers and then stop. */
export async function readBoundedJson(response: Response, maxBytes: number, errorCode: string,
  options: JsonResponseReadOptions = {}): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(errorCode);
  let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const abort = () => rejectStopped(options.signal?.reason ?? new DOMException('Body read aborted', 'AbortError'));
  const timeout = setTimeout(() => rejectStopped(new DOMException('Response body timed out', 'AbortError')),
    options.timeoutMilliseconds ?? 15_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return await Promise.race([stopped, readBody(reader, response, maxBytes, errorCode)]);
  } catch (error) {
    // Cancellation itself can wait on a stalled source (especially a cloned
    // response). It must not extend the deadline or hide a byte-limit failure.
    void reader.cancel().catch(() => undefined);
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(errorCode);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

async function readBody(reader: ReadableStreamDefaultReader<Uint8Array>, response: Response,
  maxBytes: number, errorCode: string): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error(errorCode);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) throw new Error(errorCode);
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
