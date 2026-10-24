import { colpCredentialHeaders } from '../auth-client.js';
import type { ReplicaFenceOutcome } from '../replica-rebuild.js';
import { assertCredentialHostPermission } from '../server-origin-permission.js';

/**
 * K3 / B-13: retires this browser's replica on the server (the protocol's own `DELETE` on the Sync
 * retire endpoint). After the server commits, no upload of the old replica can land, so archiving
 * an upload whose outcome is unsettled loses nothing and cannot duplicate it later.
 *
 * Throws a stable code when it cannot: `offline` (no connection), `fence_unauthorized`,
 * `rate_limited`, `server_unavailable`, `fence_session_unavailable` (no Session could be had),
 * `fence_refused`. A replica the server already retired counts as fenced.
 */
export interface ReplicaFenceDeps {
  /** A live Sync Session and its credential; `true` asks for a freshly minted Session. */
  readonly authority: (forceRefresh: boolean) => Promise<{
    readonly credential: { readonly accessToken: string };
    readonly session: { readonly sessionId: string };
  }>;
  /** The Sync retire endpoint of the server. */
  readonly endpoint: () => Promise<string>;
  readonly fetch: typeof fetch;
  readonly origin: string;
  readonly timeoutMilliseconds?: number;
  readonly assertHost?: (url: string, init: RequestInit) => Promise<void>;
}

const code = (error: unknown) => error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
  ? (error as { code: string }).code : error instanceof Error ? error.message : '';
const NETWORK = /^(?:offline|network_unavailable)$|fetch|network|abort|timeout/iu;

export async function fenceReplicaOnServer(deps: ReplicaFenceDeps): Promise<ReplicaFenceOutcome> {
  const url = await deps.endpoint().catch((error: unknown) => { throw new Error(NETWORK.test(code(error)) ? 'offline' : 'fence_session_unavailable'); });
  // The stored Session may be unknown to the server (expired, replaced): one attempt with a freshly minted one.
  for (const refresh of [false, true]) {
    let authority: Awaited<ReturnType<ReplicaFenceDeps['authority']>>;
    try { authority = await deps.authority(refresh); }
    catch (error) {
      if (code(error) === 'replica_retired') return 'already_retired';
      throw new Error(NETWORK.test(code(error)) ? 'offline' : code(error) === 'rate_limited' ? 'rate_limited' : 'fence_session_unavailable');
    }
    const init: RequestInit = { method: 'DELETE', redirect: 'error', credentials: 'omit', headers: {
      ...colpCredentialHeaders(authority.credential.accessToken), Origin: deps.origin,
      'Known-Sync-Session': authority.session.sessionId, 'Idempotency-Key': crypto.randomUUID() },
    signal: AbortSignal.timeout(deps.timeoutMilliseconds ?? 10_000) };
    await (deps.assertHost ?? assertCredentialHostPermission)(url, init);
    let response: Response;
    try { response = await deps.fetch(url, init); } catch { throw new Error('offline'); }
    if (response.status === 204) return 'fenced';
    if (response.status === 410) return 'already_retired';
    if (response.status === 404 && !refresh) continue;
    throw new Error(response.status === 401 || response.status === 403 ? 'fence_unauthorized'
      : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'server_unavailable' : 'fence_refused');
  }
  throw new Error('fence_refused');
}
