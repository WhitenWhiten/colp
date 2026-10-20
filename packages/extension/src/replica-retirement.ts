import { colpCredentialHeaders } from './auth-client.js';
import { digestJson } from './bookmark-event-codec.js';
import type { createCredentialStore } from './credential-store.js';
import type { SyncScope } from './sync-state-store.js';
import type { StoredCredential, StoredSession } from './types.js';

/** No access token, but the Session is sensitive installation proof. Never log or export this intent. */
export interface ReplicaRetirementIntent {
  readonly version: 1;
  readonly endpoint: string;
  readonly origin: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly reauthorization?: true;
  readonly confirmed?: true;
}
export interface ReplicaRetirementTransport {
  prepare(scope: SyncScope, generation: number): Promise<ReplicaRetirementIntent>;
  reconfirm(scope: SyncScope, intent: ReplicaRetirementIntent, generation: number): Promise<ReplicaRetirementIntent>;
  confirm(scope: SyncScope, intent: ReplicaRetirementIntent, generation: number): Promise<void>;
  restoreCredential(): Promise<StoredCredential>;
}

/** The server's 204 is the only proof. A lost response repeats the same Session/key/target. */
export function createReplicaRetirementTransport(deps: {
  readonly credentials: ReturnType<typeof createCredentialStore>;
  readonly currentScope: () => Promise<SyncScope>;
  readonly authority: () => Promise<{ readonly credential: StoredCredential; readonly session: StoredSession }>;
  readonly credential: () => Promise<StoredCredential>;
  readonly proof?: (scope: SyncScope) => Promise<string | undefined>;
  readonly endpoint: () => Promise<{ readonly href: string; readonly reauthorization?: true }>;
  readonly origin: () => string;
  readonly fetch?: typeof fetch;
}) : ReplicaRetirementTransport {
  async function current(scope: SyncScope, generation: number, credential: StoredCredential) {
    await deps.credentials.assertWritable(generation);
    const live = await deps.credentials.loadCredential();
    if (credential.subject !== scope.accountId || credential.serverOrigin !== scope.serverOrigin
      || live?.subject !== scope.accountId || live.serverOrigin !== scope.serverOrigin
      || digestJson({ ...await deps.currentScope() }) !== digestJson({ ...scope })) throw new Error('stale_ref');
  }
  return {
    restoreCredential: deps.credential,
    async prepare(scope, generation) {
      const credential = await deps.credential();
      await current(scope, generation, credential);
      const endpoint = await deps.endpoint();
      let sessionId = endpoint.reauthorization ? await deps.proof?.(scope) : undefined;
      if (!sessionId) {
        const authority = await deps.authority();
        await current(scope, generation, authority.credential);
        if (authority.session.collection.collectionId !== scope.collectionId) throw new Error('stale_ref');
        sessionId = authority.session.sessionId;
      }
      const intent: ReplicaRetirementIntent = { version: 1, endpoint: endpoint.href, origin: deps.origin(),
        sessionId, idempotencyKey: `rebuild-${crypto.randomUUID()}`,
        ...(endpoint.reauthorization ? { reauthorization: true } : {}) };
      validateReplicaRetirementIntent(intent, scope, deps.origin());
      await current(scope, generation, credential);
      return intent;
    },
    async reconfirm(scope, intent, generation) {
      validateReplicaRetirementIntent(intent, scope, deps.origin());
      if (intent.confirmed) return intent;
      const credential = await deps.credential();
      await current(scope, generation, credential);
      const endpoint = await deps.endpoint();
      if (endpoint.href !== intent.endpoint) throw new Error('retirement_target_changed');
      await current(scope, generation, credential);
      const { reauthorization: _old, ...pinned } = intent;
      return { ...pinned, ...(endpoint.reauthorization ? { reauthorization: true as const } : {}) };
    },
    async confirm(scope, intent, generation) {
      validateReplicaRetirementIntent(intent, scope, deps.origin());
      // Refresh only the account credential. Minting another old-replica Sync
      // Session would invalidate the pinned retirement identity after a restart.
      let credential: StoredCredential;
      try { credential = await deps.credential(); }
      catch { throw new Error('retirement_authentication_required'); }
      await current(scope, generation, credential);
      const context = await deps.credentials.fence.capture();
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15_000)]);
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(intent.endpoint, { method: 'DELETE', redirect: 'error',
          cache: 'no-store', credentials: 'omit', signal, headers: {
            ...colpCredentialHeaders(credential.accessToken), Origin: intent.origin,
            'Known-Sync-Session': intent.sessionId, 'Idempotency-Key': intent.idempotencyKey,
            ...(intent.reauthorization ? { 'Known-Sync-Replica-Proof': intent.sessionId } : {}),
          } });
      } catch {
        await deps.credentials.assertWritable(generation);
        throw new Error('retirement_pending');
      }
      await current(scope, generation, credential);
      if (response.status !== 204) {
        throw new Error([401, 403, 404].includes(response.status)
          ? intent.reauthorization ? response.status === 401 ? 'retirement_authentication_required'
            : 'retirement_authority_denied' : 'retirement_legacy_authority_required'
          : 'retirement_pending');
      }
    },
  };
}

export function validateReplicaRetirementIntent(intent: ReplicaRetirementIntent, scope: SyncScope, origin: string): void {
  const token = /^[A-Za-z0-9._~-]{1,512}$/u;
  let url: URL;
  try { url = new URL(intent.endpoint); } catch { throw new Error('retirement_invalid'); }
  if (intent.version !== 1 || url.origin !== scope.serverOrigin || url.username || url.password || url.search || url.hash
    || intent.origin !== origin || !token.test(intent.sessionId) || !token.test(intent.idempotencyKey)
    || (intent.confirmed !== undefined && intent.confirmed !== true)
    || (intent.reauthorization !== undefined && intent.reauthorization !== true)
    || Object.keys(intent).some(key => !['version', 'endpoint', 'origin', 'sessionId', 'idempotencyKey', 'reauthorization', 'confirmed'].includes(key))) {
    throw new Error('retirement_invalid');
  }
}
