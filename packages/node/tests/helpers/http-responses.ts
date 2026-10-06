/**
 * Builds a protocol JSON response. String values are treated as already
 * serialized JSON and are not quoted as they would be by Response.json().
 */
export function protocolJsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return new Response(body, { ...init, headers });
}

/**
 * Adds a stable default validator while preserving protocolJsonResponse's raw
 * string-body semantics; do not substitute this for Response.json() blindly.
 */
export function createProtocolJsonResponse(defaultEtag: string): (
  value: unknown,
  init?: ResponseInit,
) => Response {
  return (value, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has('etag')) headers.set('ETag', defaultEtag);
    return protocolJsonResponse(value, { ...init, headers });
  };
}

/** Builds a Problem Details response with its distinct registered media type. */
export function problemJsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/problem+json');
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return new Response(body, { ...init, headers });
}
