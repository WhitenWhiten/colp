/** Connection probes must obey the same 64 KiB response ceiling as classification. */
export const CLASSIFICATION_PROBE_MAX_RESPONSE_BYTES = 65_536;

export async function readClassificationProbeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  const declared = Number(response.headers.get('content-length'));
  const tooLarge = () => new RangeError('classification probe response exceeds the size limit');
  if (Number.isFinite(declared) && declared > CLASSIFICATION_PROBE_MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) throw new TypeError('classification probe response is empty');
  const reader = response.body.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
      void reader.cancel(reason).catch(() => undefined);
      reject(reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const consume = async (): Promise<unknown> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > CLASSIFICATION_PROBE_MAX_RESPONSE_BYTES) throw tooLarge();
      chunks.push(next.value.slice());
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  };
  try {
    return await Promise.race([consume(), aborted]);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
