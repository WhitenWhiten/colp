import { abortable, ColpClientLimitError } from './request-budget.js';

interface BodyResult {
  readonly source: string;
  readonly bytes: number;
  readonly validUtf8: boolean;
}

export function cancelResponseBody(response: Response, reason: unknown): void {
  if (response.body !== null && !response.body.locked) {
    void response.body.cancel(reason).catch(() => undefined);
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  void reader.cancel(reason).catch(() => undefined);
}

export async function readResponseBody(
  response: Response,
  maxBytes: number | undefined,
  signal: AbortSignal | undefined,
): Promise<BodyResult> {
  const declaredLength = response.headers.get('content-length');
  if (maxBytes !== undefined && declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(maxBytes)) {
      cancelResponseBody(response, new ColpClientLimitError('Response Content-Length exceeds the response byte limit.'));
      throw new ColpClientLimitError(`Response body exceeds the response byte limit of ${maxBytes}.`);
    }
  }

  if (response.body === null) return { source: '', bytes: 0, validUtf8: true };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const validatingDecoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  let validUtf8 = true;
  const onAbort = (): void => cancelReader(reader, signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      if (maxBytes !== undefined && bytes > maxBytes) {
        const error = new ColpClientLimitError(
          `Response body exceeds the response byte limit of ${maxBytes}.`,
        );
        cancelReader(reader, error);
        throw error;
      }
      parts.push(decoder.decode(result.value, { stream: true }));
      if (validUtf8) {
        try {
          validatingDecoder.decode(result.value, { stream: true });
        } catch {
          validUtf8 = false;
        }
      }
    }
    parts.push(decoder.decode());
    if (validUtf8) {
      try {
        validatingDecoder.decode();
      } catch {
        validUtf8 = false;
      }
    }
    return { source: parts.join(''), bytes, validUtf8 };
  } catch (error) {
    cancelReader(reader, error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

