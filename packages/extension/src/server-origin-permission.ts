/** Match pattern for one saved server origin. Optional host permissions cover any https or http host; the request is this origin only. */
export function serverOriginPermissionPattern(origin: string): string {
  return `${new URL(origin).origin}/*`;
}

/** Starts the optional-host prompt. Call it in the save gesture, before any await. */
export function requestServerOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [serverOriginPermissionPattern(origin)] });
}

/** Drops the optional grant for one server origin. Disconnect (D7) calls this. Required Know-N host permissions are not removed. */
export function releaseServerOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.remove({ origins: [serverOriginPermissionPattern(origin)] });
}

/**
 * Sign-in already uses this when the server address cannot be used.
 * The options page tells the user to check the address and allow access.
 */
export const SERVER_HOST_PERMISSION_ERROR = 'server_configuration_failed';

/**
 * Whether this extension may already talk to `origin`.
 *
 * `chrome.permissions.contains` is true for a host granted at runtime and for a
 * host listed in the build's `host_permissions`, so a built-in server is not
 * treated as optional. Managed storage does not skip this check.
 * Unit tests that never install `chrome.permissions` are not an extension worker.
 */
export async function serverOriginCredentialGranted(origin: string): Promise<boolean> {
  const contains = globalThis.chrome?.permissions?.contains;
  if (typeof contains !== 'function') return true;
  try {
    return (await contains({ origins: [serverOriginPermissionPattern(origin)] })) === true;
  } catch {
    return false;
  }
}

/** Stop a password, cookie, or bearer from leaving for an origin this extension cannot access. */
export async function assertCredentialHostPermission(input: RequestInfo | URL, init?: RequestInit): Promise<void> {
  if (!carriesCredential(input, init)) return;
  let origin: string;
  try { origin = requestOrigin(input); }
  catch { throw new Error(SERVER_HOST_PERMISSION_ERROR); }
  if (!await serverOriginCredentialGranted(origin)) throw new Error(SERVER_HOST_PERMISSION_ERROR);
}

/** Fetch wrapper for worker calls that may attach a password, cookie, or bearer. */
export function credentialGatedFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    await assertCredentialHostPermission(input, init);
    return inner(input, init);
  };
}

function carriesCredential(input: RequestInfo | URL, init?: RequestInit): boolean {
  const headers = requestHeaders(input, init);
  if (headers.has('authorization') || headers.has('cookie')) return true;
  const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
  if (credentials === 'include') return true;
  return typeof init?.body === 'string' && /"password"\s*:/u.test(init.body);
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => { headers.set(key, value); });
  return headers;
}

function requestOrigin(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(raw).origin;
}
