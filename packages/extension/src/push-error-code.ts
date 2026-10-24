/** Stable codes only: never persist exception prose, URLs or credentials. */
export function reasonCode(error: unknown, fallback: string): string {
  const structured = error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
  for (const value of [structured, error instanceof Error ? error.message : undefined]) {
    if (typeof value === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/.test(value)) return value;
  }
  return fallback;
}

/** A fetch or body-read failure of the transport itself (offline, reset, timeout), not of the data. */
export function isTransportError(error: unknown): boolean {
  return error instanceof TypeError || error instanceof DOMException
    && ['AbortError', 'NetworkError', 'TimeoutError'].includes(error.name);
}

/**
 * The reason recorded for an answer with no usable Problem body. A server that cannot answer
 * right now (5xx, 408, 425, 429) is a wait, not an unreadable answer that needs a person.
 */
export function unrecognizedStatusReason(status: number): string {
  if (status === 429) return 'rate_limited';
  return status >= 500 || status === 408 || status === 425 ? 'push_server_unavailable' : 'push_response_unrecognized';
}
