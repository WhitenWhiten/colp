export interface PublicationJsonRequestOptions {
  /** Actual streamed bytes, not a trusted Content-Length. Default: 8 MiB. */
  readonly maxBytes?: number;
  /** Whole body-read deadline. Default: 30 seconds; maximum: 2^31-1 ms. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Internal bounded body reader shared by the public JSON receive helper. */
export async function readPublicationRequestBytes(
  request: Request,
  options: PublicationJsonRequestOptions = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Publication body limits must be positive safe integers within the supported timer range.');
  }
  const signals = options.signal === undefined ? [request.signal] : [request.signal, options.signal];
  for (const signal of signals) signal.throwIfAborted();
  const tooLarge = () => new RangeError(`Publication request body exceeds ${maxBytes} bytes.`);
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    void request.body?.cancel(tooLarge()).catch(() => undefined);
    throw tooLarge();
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const controller = new AbortController();
  const listeners = signals.map(signal => {
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener('abort', listener, { once: true });
    return { signal, listener };
  });
  const timer = setTimeout(() => controller.abort(
    new DOMException('Publication request body read timed out.', 'TimeoutError'),
  ), timeoutMs);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void reader.cancel(controller.signal.reason).catch(() => undefined);
      reject(controller.signal.reason);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const consume = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Publication body chunks must be bytes.');
      total += value.byteLength;
      if (total > maxBytes) throw tooLarge();
      chunks.push(value.slice());
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  try {
    return await Promise.race([consume(), aborted]);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    controller.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
