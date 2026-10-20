import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { digestJson } from '../src/bookmark-event-codec.js';
import { createCredentialStore, MemoryStorageArea } from '../src/credential-store.js';
import { createMetadataSyncPolicyStore } from '../src/metadata-sync-policy.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { createReplicaRebuilder, REPLICA_REBUILD_JOURNAL, type ReplicaRebuildDeps,
  type ReplicaRebuildRequest } from '../src/replica-rebuild.js';
import { createReplicaRetirementTransport } from '../src/replica-retirement.js';
import { createSyncEffectAuthority } from '../src/sync-effect-authority.js';
import { createSyncStateStore, type JsonObject, type SyncScope } from '../src/sync-state-store.js';
import type { StoredCredential, StoredSession } from '../src/types.js';
import { endpoints } from './outbound-push-worker-harness.js';

/** Real worker, metadata gate, authority fence, queue/receipts/archive and journal.
 * Only account/Session issuance and HTTP are external ports. Old-build enqueue
 * is explicit, with schema-valid operations and their real canonical digests. */
export async function setupRetirement(reauthorization = true) {
  const authStorage = new MemoryStorageArea(), journal = new MemoryStorageArea();
  const credentials = createCredentialStore(authStorage);
  const credential: StoredCredential = { accessToken: 'controlled-credential-old', tokenType: 'Bearer',
    expiresAt: Date.now() + 600_000, scope: ['known.sync'], issuer: 'https://known.example',
    audience: 'https://known.example', clientId: 'extension', serverOrigin: 'https://known.example', subject: 'account-retire' };
  await credentials.saveCredential(credential); const context = await credentials.fence.capture();
  const binding = await credentials.getOrCreateBinding(context.generation);
  const scope: SyncScope = { environment: 'production', serverId: credential.serverOrigin, serverOrigin: credential.serverOrigin,
    accountId: credential.subject!, browserProfileId: binding.browserProfileId, replicaId: binding.replicaId,
    generation: 1, collectionId: 'collection-retire' };
  const session: StoredSession = { sessionId: 'controlled-old-session-proof', credentialAuthorityDigest: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
    collection: { collectionId: scope.collectionId, serverCursor: 'cursor-0', serverRevision: 'revision-0' },
    replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' } };
  await credentials.saveSession(session);
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  const registration = { ...scope, lifecycle: 'active' as const, lease: { leaseId: 'lease', expiresAt: Date.now() + 600_000 },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: ['root'], rootStatus: 'ready' as const };
  await store.registerScope(registration);
  await store.putMapping(scope, { nativeId: 'native', colpId: 'bookmark', rootNativeId: 'root', nodeKind: 'bookmark',
    projection: { revision: 'revision-0', digest: digestJson({ title: 'Kept' }), content: { title: 'Kept', url: 'https://example.test/kept' } } });
  for (const sequence of [1, 2]) {
    const payload: JsonObject = { opId: `retained-${sequence}`, replicaId: scope.replicaId, sequence,
      collectionId: scope.collectionId, type: 'update_node_content', targetId: 'bookmark', baseRevision: 'revision-0',
      occurredAt: '2026-10-20T00:00:00.000Z', dependencies: [], payload: sequence === 1
        ? { base: { tags: [] }, value: { tags: ['private-metadata'] } } : { base: { title: 'Kept' }, value: { title: 'Later' } } };
    await store.allocateSequenceAndEnqueue(scope, { opId: `retained-${sequence}`, batchId: `retained-${sequence}`,
      idempotencyKey: `retained-${sequence}`, digest: digestJson(payload), endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'revision-0', operationRevision: `local-${sequence}`,
      status: 'pending', retry: { attempt: 0, notBefore: 0 }, payload }, { allowUnstamped: true });
  }
  const policy = createMetadataSyncPolicyStore(new MemoryStorageArea()); await policy.write(scope, true);
  let pushCalls = 0, authorityCalls = 0, restorations = 0, clock = Date.now(), offlineRegistration = false;
  const effects = createSyncEffectAuthority({ scope,
    api: {} as Parameters<typeof createSyncEffectAuthority>[0]['api'], context, metadataPolicy: policy,
    currentScope: async () => scope, assertWritable: async () => { await credentials.assertWritable(context.generation); },
    fetch: async () => { pushCalls++; throw new Error('response_lost'); } });
  const worker = createOutboundPushWorker({ scope, store, endpoints: async () => endpoints,
    sessions: { get: async () => ({ credential, session }) }, fetch: effects.fetch, now: () => clock,
    random: () => 0, ownerId: () => 'retirement-test', schedule: () => undefined, allowRecoveryFrozenPush: () => true });
  assert.equal((await worker.drain()).outcome, 'unknown');
  const attempted = (await store.listQueue(scope))[0]!;
  await policy.write(scope, false); clock = attempted.retry.notBefore;
  assert.equal((await worker.drain()).outcome, 'recovery');
  const original = await store.listQueue(scope);
  assert.equal(original[0]!.status, 'blocked'); assert.deepEqual(original[0]!.attempt, attempted.attempt);
  assert.equal(original[1]!.status, 'pending'); assert.equal(pushCalls, 1);
  let endpoint = { href: endpoints.syncRetire as string, ...(reauthorization ? { reauthorization: true as const } : {}) };
  let restore: StoredCredential | null = { ...credential, accessToken: 'controlled-credential-refreshed' };
  let response: (init: RequestInit) => Promise<Response> = async () => new Response(null, { status: 204 });
  const requests: { url: string; init: RequestInit }[] = [];
  async function currentScope(): Promise<SyncScope> {
    const current = await credentials.loadCredential(), currentBinding = await credentials.loadBinding();
    if (!current?.subject || !currentBinding) throw new Error('not_connected');
    return { ...scope, accountId: current.subject, serverOrigin: current.serverOrigin,
      browserProfileId: currentBinding.browserProfileId, replicaId: currentBinding.replicaId, generation: Number(currentBinding.generation) };
  }
  const transport = createReplicaRetirementTransport({ credentials, currentScope,
    proof: scope => credentials.loadReplicaReportProof(scope),
    authority: async () => {
      authorityCalls++; const liveCredential = await credentials.loadCredential(), liveSession = await credentials.loadSession();
      if (!liveCredential || !liveSession) throw new Error('no_old_session'); return { credential: liveCredential, session: liveSession };
    }, credential: async () => {
      const current = await credentials.loadCredential(); if (current) return current;
      restorations++; if (!restore) throw new Error('signed_out'); await credentials.saveCredential(restore); return restore;
    }, endpoint: async () => endpoint, origin: () => 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    fetch: async (url, init) => {
      assert.ok(init); assert.ok((await journal.get(REPLICA_REBUILD_JOURNAL))[REPLICA_REBUILD_JOURNAL]);
      requests.push({ url: String(url), init }); return response(init);
    } });
  const deps: ReplicaRebuildDeps = { store, credentials, journal, serverRetirement: transport, currentScope,
    resetRuntime() {}, ensureScope: async () => {
      if (offlineRegistration) throw new Error('offline');
      const next = await currentScope();
      if (!await store.getScope(next)) await store.registerScope({ ...registration, ...next, firstRun: 'none', selectedRoots: [] });
      return next;
    } };
  const rebuilder = createReplicaRebuilder(deps);
  async function request() {
    const result = await rebuilder.handle({ kind: 'known.scope.rebuild.preview' });
    assert.ok(result.ok && 'preview' in result);
    const { replicaId, generation, revision, targetFence } = result.preview;
    return { kind: 'known.scope.rebuild.confirm', userGesture: true, replicaId, generation, revision, targetFence } satisfies ReplicaRebuildRequest;
  }
  return { scope, store, credentials, credential, binding, session, journal, policy, original, worker, deps, transport, rebuilder,
    request, requests, currentScope, get pushCalls() { return pushCalls; }, get authorityCalls() { return authorityCalls; },
    get restorations() { return restorations; }, setResponse(value: typeof response) { response = value; },
    setRestore(value: StoredCredential | null) { restore = value; }, setEndpoint(value: typeof endpoint) { endpoint = value; },
    setOfflineRegistration(value: boolean) { offlineRegistration = value; },
    close() { store.close(); } };
}

export async function seedNativeUnknown(f: Pick<Awaited<ReturnType<typeof setupRetirement>>, 'scope' | 'store'>) {
  await f.store.stagePullPage(f.scope, { pageId: 'native-page', previousCursor: 'cursor-0', nextCursor: 'cursor-1',
    collectionRevision: 'revision-1', pageDigest: 'sha256:page', effectPages: [], events: [{ eventId: 'native-event',
      cursor: 'cursor-1', operationId: 'native-op', effectId: 'native-effect', effectDigest: 'sha256:effect',
      operationDigest: 'sha256:operation', kind: 'node_content_updated', payload: {} }] });
  await f.store.preparePullIntent(f.scope, 'native-event', { intentId: 'native-intent', correlationId: 'native-corr',
    operationId: 'native-op', eventId: 'native-event', effectId: 'native-effect', state: 'intent_prepared',
    expected: { kind: 'change', nativeId: 'native' }, expiresAt: Date.now() + 60_000,
    preStateDigest: digestJson({ title: 'Kept' }), apiPhase: 'intent_prepared', nativeEventEvidence: null, apiResultEvidence: null });
  await f.store.persistApplyIntentFacts(f.scope, 'native-intent', { eventState: 'authority_committed' });
  await f.store.completePullPage(f.scope, 'native-page');
  await f.store.persistApplyIntentFacts(f.scope, 'native-intent', { nativeResult: 'result_unknown',
    waitReason: 'native_result_unknown', replayState: 'awaiting_receipt', nativeResultConfirmation: { kind: 'unknown', code: 'nwr:retirement' },
    eventState: 'awaiting_confirmation' });
}
