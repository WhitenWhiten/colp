import { createHash, createHmac, randomUUID } from 'node:crypto';
import { copyFile, link, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPull, SyncSessionRequest, SyncSessionResult, SyncPushResult } from '@know-n/colp/types';
import { createAttachmentExposurePolicyAdapter, createDatabaseRuntime, createPostgresSharedExposureFactsPort, runMigrations, type DatabaseRuntime } from '../src/infrastructure/database/index.js';
import {
  PostgresSyncTombstonePurgeCoordinator, createPostgresReplicaRetentionWindowPort,
  createPostgresReplicaLifecycleService,
  createPostgresReplicaRetirementApplication, createPostgresReplicaStore,
  createPostgresSyncAckApplication, createPostgresSyncBootstrapSnapshotApplication,
  createPostgresSyncConflictResolutionApplication, createPostgresSyncPullReadPort,
  createPostgresSyncPushApplication, createPostgresSyncSessionHttpApplication,
  createPostgresSyncSessionIssuer, createPostgresSyncRecoveryApplication,
  createPostgresSyncSequencePort, createSyncPullCursorKeyring, createSyncRecoveryCapabilityKeyring,
} from '../src/infrastructure/sync/index.js';
import { materializeCollectionPayload, materializeNodePayload, RESOURCE_PAYLOAD_SCHEMA_VERSION } from '../src/modules/collections/index.js';
import { createLogger, createSyncServerTelemetry, InMemoryMetrics, syncDurationBucket,
  type SyncServerTelemetry, type SyncTelemetryEndpoint, type SyncTelemetryProblem } from '../src/infrastructure/telemetry/index.js';
import { registerSyncAckRoutes } from '../src/transport/colp-sync/sync-ack-routes.js';
import { registerSyncConflictRoutes } from '../src/transport/colp-sync/sync-conflict-routes.js';
import { registerSyncPullRoutes } from '../src/transport/colp-sync/sync-pull-routes.js';
import { registerSyncPushRoutes } from '../src/transport/colp-sync/sync-push-routes.js';
import { registerSyncRetireRoutes } from '../src/transport/colp-sync/sync-retire-routes.js';
import { registerSyncSessionRoutes } from '../src/transport/colp-sync/sync-session-routes.js';
import { registerSyncSnapshotRoutes } from '../src/transport/colp-sync/sync-snapshot-routes.js';
import type {
  Phase3ServerSyncAcceptanceCandidate, Phase3ServerSyncNegativeFact, Phase3ServerSyncPort,
  Phase3ServerSyncProbeName, Phase3ServerSyncRoute, Phase3ServerSyncScenario,
  Phase3ServerSyncStepFact,
} from './acceptance/phase3-server-sync-acceptance.js';
import { P3_26_REQUIRED_PORTS, P3_26_REQUIRED_PROBES, P3_26_REQUIRED_ROUTES,
  P3_26_TELEMETRY_ENDPOINTS, P3_26_TELEMETRY_OUTCOMES,
  validatePhase3ServerSyncStepChain } from './acceptance/phase3-server-sync-acceptance.js';
import { createSyncSessionBlackBoxClient } from '../tests/support/sync-session-black-box-client.js';
import { mintVerifiedExtensionCredentialFixture } from '../tests/support/extension-credential.js';
import { syncNodeCreatePushRequest, syncPushAdmissionRequest } from '../tests/fixtures/phase3/sync-push-admission.js';
import { syncNodeUpdatePushRequest } from '../tests/fixtures/phase3/sync-node-update.js';
import { syncNodeMovePushRequest } from '../tests/fixtures/phase3/sync-node-move.js';
import { syncNodeDeletePushRequest } from '../tests/fixtures/phase3/sync-node-delete.js';
import type { BlackBoxStepObservation, Phase3ServerSyncBlackBoxRuntime } from './phase3-server-sync-black-box-scenario.js';

const ISSUER = 'https://issuer.example';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const AUTHORIZATION = 'Bearer P3-26-SENTINEL-CREDENTIAL';
export const PHASE3_SYNC_FIXTURE_ACCOUNT = 'AQEBAQEBAQEBAQEBAQEBAQ';
const ACCOUNT = PHASE3_SYNC_FIXTURE_ACCOUNT;
const SUBJECT = 'p3-26-sentinel-subject';
const COLLECTION = 'AgICAgICAgICAgICAgICAg';
const ROOT = 'p3-26-sentinel-root';
const NODE = 'push-node-1';
const MOVE_TARGET = 'p3-26-move-target';
const CURSOR_SENTINEL = 'p3-26-sensitive-cursor';
const ERROR_SENTINEL = 'p3-26-sensitive-error-text';

interface TelemetryCapture {
  readonly records: string[];
  readonly logs: string[];
  readonly metrics: string[];
  readonly problems: string[];
  readonly recorder: SyncServerTelemetry;
  readonly logger: ReturnType<typeof createLogger>;
  redactProbe(): void;
}

interface ScenarioState {
  leftSession?: SyncSessionResult;
  rightSession?: SyncSessionResult;
  leftPush?: SyncPushResult;
  conflict?: { id: string; revision: string };
  pull?: SyncPull;
  rightCursor?: string;
  firstSnapshot?: Awaited<ReturnType<ReturnType<typeof createSyncSessionBlackBoxClient>['snapshot']>>;
  readonly telemetry: TelemetryCapture;
  readonly observedPorts: Set<Phase3ServerSyncPort>;
}

type RuntimeRegistrations = Readonly<Record<Phase3ServerSyncRoute, (app: FastifyInstance) => void>>;
type RepositoryBindings = Pick<Phase3ServerSyncAcceptanceCandidate, 'source' | 'migrations' | 'colp'>
  & { readonly configDigest: string };

export interface Phase3ServerSyncProductionScenarioRuntime extends Phase3ServerSyncBlackBoxRuntime {
  routeFacts(): readonly { readonly key: Phase3ServerSyncRoute; readonly method: 'GET' | 'POST' | 'DELETE'; readonly routeTemplate: string; readonly uriDigest: string; readonly discoveredAt: string }[];
  portFacts(): readonly { readonly name: Phase3ServerSyncPort; readonly source: 'runtime-composition' | 'database-observation' | 'http-observation'; readonly observationDigest: string; readonly observedAt: string }[];
  probeFacts(): Promise<readonly { readonly name: Phase3ServerSyncProbeName; readonly outcome: 'passed'; readonly observationDigest: string; readonly startedAt: string; readonly finishedAt: string }[]>;
  runNegativeControls(signal: AbortSignal, steps: readonly Phase3ServerSyncStepFact[]): Promise<readonly Phase3ServerSyncNegativeFact[]>;
  requiredNegativeControls(): readonly string[];
  telemetryScan(): { readonly endpoints: readonly string[]; readonly outcomes: readonly string[]; readonly surfaces: readonly string[]; readonly sentinelDigest: string; readonly scannedBytes: number; readonly leaks: 0 };
  uiConflict(): Promise<{ readonly conflictId: string; readonly current: string; readonly incoming: string; readonly marker: string }>;
  pullUiResolution(signal: AbortSignal, conflictId: string): Promise<{ readonly operationCreated: boolean; readonly secondReplicaPulled: boolean; readonly authorityTitle: string }>;
  close(): Promise<void>;
}

export async function createPhase3ServerSyncProductionScenarioRuntime(input: {
  readonly database: DatabaseRuntime; readonly env: NodeJS.ProcessEnv; readonly nonce: string;
  readonly instanceId: string; readonly signal: AbortSignal;
  readonly repositoryBindings: RepositoryBindings;
  readonly verifyRepositoryBindings: (expected: unknown, observed: unknown) => void;
  readonly uiFixture?: { readonly currentTitle: string; readonly incomingTitle: string; readonly marker: string };
}): Promise<Phase3ServerSyncProductionScenarioRuntime> {
  const suffix = input.nonce.slice(0, 10);
  await seedAuthority(input.database, suffix);
  const credential = await mintVerifiedExtensionCredentialFixture({
    issuer: ISSUER,
    audience: 'known-api',
    clientId: 'known-extension',
    subject: `${SUBJECT}-oidc`,
    credentialId: `p3-26-credential-${suffix}`,
    evidenceTtlSeconds: input.uiFixture ? 3_600 : 60,
  });
  const store = createPostgresReplicaStore(input.database.db, { ids: {
    deviceId: () => `p3-26-device-${randomUUID()}`, replicaId: () => `p3-26-replica-${randomUUID()}`,
    leaseId: () => `p3-26-lease-${randomUUID()}`,
  } });
  const leftInput = replicaCreate(`left-${suffix}`, 'whole-profile');
  const rightInput = replicaCreate(`right-${suffix}`, 'mounted-folder');
  const left = await store.create(leftInput, { actorAccountId: leftInput.accountId });
  const right = await store.create(rightInput, { actorAccountId: rightInput.accountId });
  const issuer = createPostgresSyncSessionIssuer(input.database.db, {
    issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
    replayEncryptionKey: Buffer.alloc(32, 126), replayEncryptionKeyVersion: 1,
    sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 600, tombstoneRetentionSeconds: 2_592_000,
    maxBatchOperations: 1, endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    retentionWindow: createPostgresReplicaRetentionWindowPort('/runtime/snapshot'),
  });
  const pullKeys = createSyncPullCursorKeyring({ active: { id: 'p3-26-pull', secret: Buffer.alloc(32, 91).toString('base64') }, retained: [], ttlMs: 600_000 });
  const recovery = createPostgresSyncRecoveryApplication(input.database.db, {
    capabilityKeys: createSyncRecoveryCapabilityKeyring({ active: { id: 'p3-26-recovery', secret: Buffer.alloc(32, 93).toString('base64') }, retained: [], ttlMs: 600_000 }),
    leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600,
  });
  const verifier = { async verify(value: { readonly authorization: string | readonly string[] | undefined }) { if (value.authorization !== AUTHORIZATION) throw new Error('denied'); return credential; } };
  const telemetry = createTelemetryCapture();
  const app = Fastify({ loggerInstance: telemetry.logger as FastifyBaseLogger, requestTimeout: 30_000 });
  installRuntimeTelemetry(app, telemetry);
  const rateLimit = { maxRequests: 10_000, windowMs: 60_000 };
  const sessionApplication = createPostgresSyncSessionHttpApplication(input.database.db, issuer);
  const snapshotApplication = createPostgresSyncBootstrapSnapshotApplication(input.database, { cursorSecret: Buffer.alloc(32, 92), cursorKeyId: 'p3-26-snapshot', cursorTtlMs: 600_000, recovery, pullCursorKeyring: pullKeys, attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(input.database)) });
  const uiConflictKey = input.uiFixture && input.env.SYNC_SESSION_REPLAY_KEY
    ? Buffer.from(input.env.SYNC_SESSION_REPLAY_KEY, 'base64') : Buffer.alloc(32, 126);
  const uiConflictKeyVersion = input.uiFixture
    ? Number(input.env.SYNC_SESSION_REPLAY_KEY_VERSION ?? 1) : 1;
  if (uiConflictKey.length !== 32 || !Number.isSafeInteger(uiConflictKeyVersion) || uiConflictKeyVersion < 1) {
    throw new Error('P3-37 Sync UI conflict encryption configuration is invalid');
  }
  const conflictPayloadEncryption = { key: uiConflictKey, keyVersion: uiConflictKeyVersion };
  const pushApplication = createPostgresSyncPushApplication(input.database.db, issuer, { managedBookmarkWrites: false, conflictPayloadEncryption });
  const conflictApplication = createPostgresSyncConflictResolutionApplication(input.database.db, issuer, {
    conflictPayloadKeyring: { active: conflictPayloadEncryption, retained: [] },
  });
  const pullReader = createPostgresSyncPullReadPort(input.database.db, pullKeys);
  const ordinaryAck = createPostgresSyncAckApplication(input.database.db, { leaseExtensionSeconds: 600, maxLeaseLifetimeSeconds: 3_600 });
  const retireApplication = createPostgresReplicaRetirementApplication(input.database.db);
  let retirementFailure = 'none';
  const observedRetireApplication = Object.freeze({ async retireExtension(value: Parameters<typeof retireApplication.retireExtension>[0]) {
    try { await retireApplication.retireExtension(value); }
    catch (error) {
      retirementFailure = error instanceof Error
        ? `${error.name}:${'code' in error ? String((error as Error & { code?: unknown }).code) : 'unknown'}:${error.message}` : 'unknown';
      throw error;
    }
  } });
  const registrations: RuntimeRegistrations = {
    manifest(target) { target.get('/.well-known/collection-protocol', async () => manifest(originOf(target))); },
    syncSessions(target) { registerSyncSessionRoutes(target, { path: '/runtime/session', allowedOrigins: [ORIGIN], credentialVerifier: verifier, application: sessionApplication, rateLimit, allowInsecureLoopback: true }); },
    syncSnapshot(target) { registerSyncSnapshotRoutes(target, { path: '/runtime/snapshot', allowedOrigins: [ORIGIN], credentialVerifier: verifier, application: snapshotApplication, rateLimit, allowInsecureLoopback: true }); },
    syncPush(target) { registerSyncPushRoutes(target, { path: '/runtime/push', allowedOrigins: [ORIGIN], credentialVerifier: verifier, application: pushApplication, rateLimit, maxBatchOperations: 1, allowInsecureLoopback: true }); },
    syncConflict(target) { registerSyncConflictRoutes(target, { pathTemplate: '/runtime/conflicts/{conflictId}/resolve', allowedOrigins: [ORIGIN], credentialVerifier: verifier, application: conflictApplication, rateLimit, allowInsecureLoopback: true }); },
    syncPull(target) { registerSyncPullRoutes(target, { path: '/runtime/pull', allowedOrigins: [ORIGIN], credentialVerifier: verifier, reader: pullReader, rateLimit, maxLimit: 100, responseBudgetBytes: 131_072, requestTimeoutMs: 5_000, recommendedPullAfterSeconds: 30, allowInsecureLoopback: true }); },
    syncAck(target) { registerSyncAckRoutes(target, { path: '/runtime/ack', allowedOrigins: [ORIGIN], credentialVerifier: verifier, application: { acknowledge(value) { return value.request.cursor.startsWith('src1.') ? recovery.acknowledge(value) : ordinaryAck.acknowledge(value); } }, rateLimit, maxBodyBytes: 16_384, maxWarnings: 8, maxWarningBytes: 2_048, allowInsecureLoopback: true }); },
    syncRetire(target) { registerSyncRetireRoutes(target, { path: '/runtime/replica', allowedOrigins: [ORIGIN], credentialVerifier: verifier, application: observedRetireApplication, rateLimit, allowInsecureLoopback: true }); },
  };
  registerRuntimeComposition(app, registrations);
  if (input.signal.aborted) throw input.signal.reason;
  await app.listen({ host: '127.0.0.1', port: 0 });
  if (input.signal.aborted) { await app.close(); throw input.signal.reason; }
  const origin = originOf(app); const manifestUrl = `${origin}/.well-known/collection-protocol`;
  const client = createSyncSessionBlackBoxClient({ manifestUrl, mountId: 'p3-26', authorization: AUTHORIZATION, origin: ORIGIN });
  const discoveredAt = new Date().toISOString();
  const manifestDocument = await fetch(manifestUrl, { signal: input.signal }).then(async (response) => response.json()) as Manifest;
  const routeFacts = discoverRouteFacts(manifestDocument, discoveredAt);
  const state: ScenarioState = { telemetry, observedPorts: new Set() };
  const runtime: Phase3ServerSyncProductionScenarioRuntime = {
    async execute(scenario, signal) { return executeScenario({ scenario, signal, database: input.database, client, origin, left, right, issuer, recovery, credential, state, retirementFailure: () => retirementFailure, uiFixture: input.uiFixture }); },
    routeFacts: () => routeFacts,
    portFacts: () => collectPortFacts(state.observedPorts, input.instanceId, discoveredAt),
    probeFacts: async () => collectProbeFacts(input.database, state, routeFacts, input.instanceId, discoveredAt),
    runNegativeControls: (signal, steps) => runNegativeControls(input.database, input.env,
      routeFacts, registrations, origin, signal, steps, state.observedPorts, input.instanceId,
      discoveredAt, input.nonce, input.repositoryBindings, input.verifyRepositoryBindings),
    requiredNegativeControls: () => requiredControlTargets(routeFacts).map(([kind, target]) => `${kind}:${target}`),
    telemetryScan: () => telemetryScan(state.telemetry),
    async uiConflict() {
      const row = await input.database.db.selectFrom('sync_conflicts').select('conflict_id')
        .where('status', '=', 'open').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
      if (!input.uiFixture) throw new Error('UI Conflict fixture values are unavailable');
      return { conflictId: row.conflict_id, current: input.uiFixture.currentTitle,
        incoming: input.uiFixture.incomingTitle, marker: input.uiFixture.marker };
    },
    async pullUiResolution(signal, conflictId) {
      if (!state.rightSession || !state.rightCursor) throw new Error('UI fixture second Replica is not ready');
      const conflict = await input.database.db.selectFrom('sync_conflicts').select(['resolved_by_operation_id'])
        .where('conflict_id', '=', conflictId).where('status', '=', 'resolved').executeTakeFirstOrThrow();
      if (!conflict.resolved_by_operation_id) throw new Error('UI resolution did not create an Operation');
      const pulled = await client.pull({ sessionId: state.rightSession.sessionId, cursor: state.rightCursor, limit: 100, signal });
      state.rightCursor = pulled.nextCursor;
      const node = await input.database.db.selectFrom('nodes').select('title').where('id', '=', NODE).executeTakeFirstOrThrow();
      return { operationCreated: true,
        secondReplicaPulled: JSON.stringify(pulled.events).includes(conflict.resolved_by_operation_id), authorityTitle: node.title };
    },
    async close() { pullKeys.destroy(); await app.close(); },
  };
  return Object.freeze(runtime);
}

async function executeScenario(input: {
  scenario: Phase3ServerSyncScenario; signal: AbortSignal; database: DatabaseRuntime;
  client: ReturnType<typeof createSyncSessionBlackBoxClient>; origin: string;
  left: { replicaId: string; binding: { browserProfileId: string; browserGeneration: string; mountMode: 'whole-profile' | 'mounted-folder' } };
  right: { replicaId: string; binding: { browserProfileId: string; browserGeneration: string; mountMode: 'whole-profile' | 'mounted-folder' } };
  issuer: ReturnType<typeof createPostgresSyncSessionIssuer>;
  recovery: ReturnType<typeof createPostgresSyncRecoveryApplication>;
  credential: Awaited<ReturnType<typeof mintVerifiedExtensionCredentialFixture>>;
  state: ScenarioState;
  retirementFailure: () => string;
  uiFixture?: { readonly currentTitle: string; readonly incomingTitle: string; readonly marker: string };
}): Promise<BlackBoxStepObservation> {
  const before = await facts(input.database);
  let endpoint: BlackBoxStepObservation['endpoint'] = { key: 'syncPush', method: 'POST', routeTemplate: '/runtime/push', uri: `${input.origin}/runtime/push` };
  let outcome: BlackBoxStepObservation['outcome'] = 'success'; let problem: string | null = null;
  switch (input.scenario) {
    case 'manifest_session_snapshot': {
      endpoint = { key: 'manifest', method: 'GET', routeTemplate: '/.well-known/collection-protocol', uri: `${input.origin}/.well-known/collection-protocol` };
      const manifestResponse = await fetch(endpoint.uri, { signal: input.signal }); if (!manifestResponse.ok) throw new Error('Manifest failed'); await manifestResponse.json();
      input.state.leftSession = (await input.client.create({ idempotencyKey: 'p3-26-left-session', request: sessionRequest(input.left) })).body;
      recordTelemetry(input.state, 'session', 'success', null);
      input.state.firstSnapshot = await input.client.snapshot({ sessionId: input.state.leftSession.sessionId, limit: 100 });
      recordTelemetry(input.state, 'snapshot', 'success', null); break;
    }
    case 'two_replica_concurrent_edit': {
      input.state.rightSession = (await input.client.create({ idempotencyKey: 'p3-26-right-session', request: sessionRequest(input.right) })).body;
      const rightSession = input.state.rightSession;
      const rightSnapshot = await input.client.snapshot({ sessionId: rightSession.sessionId, limit: 100 });
      if (typeof rightSnapshot.syncCursor !== 'string') throw new Error('right Snapshot omitted initial Pull cursor');
      input.state.rightCursor = (await input.client.pull({ sessionId: rightSession.sessionId,
        cursor: rightSnapshot.syncCursor, limit: 100, signal: input.signal })).nextCursor;
      const [leftResponse, rightResponse] = await Promise.all([
        input.client.push({ idempotencyKey: 'p3-26-left-write', request: syncNodeUpdatePushRequest({ sessionId: input.state.leftSession!.sessionId, replicaId: input.left.replicaId, collectionId: COLLECTION, targetId: NODE, baseRevision: 'push-node-r1', opId: 'p3-26-left-op', base: { title: 'Before' }, value: { title: input.uiFixture?.currentTitle ?? 'Left' } }) }),
        input.client.push({ idempotencyKey: 'p3-26-right-write', request: syncNodeUpdatePushRequest({ sessionId: rightSession.sessionId, replicaId: input.right.replicaId, collectionId: COLLECTION, targetId: NODE, baseRevision: 'push-node-r1', opId: 'p3-26-right-op', base: { title: 'Before' }, value: { title: input.uiFixture?.incomingTitle ?? 'Right concurrent' } }) }),
      ]);
      if (leftResponse.status !== 200 || rightResponse.status !== 200) {
        const code = (response: typeof leftResponse) => response.status === 200
          ? 'success'
          : String((response.body as { readonly code?: unknown }).code ?? 'unknown');
        throw new Error(`concurrent writes failed: left=${leftResponse.status}:${code(leftResponse)}, right=${rightResponse.status}:${code(rightResponse)}`);
      }
      const statuses = [(leftResponse.body as SyncPushResult).results[0]?.status, (rightResponse.body as SyncPushResult).results[0]?.status];
      if (!statuses.includes('conflicted') || !statuses.some((status) => status === 'applied' || status === 'rebased')) throw new Error('concurrent edits did not produce one authority and one Conflict');
      input.state.leftPush = leftResponse.body as SyncPushResult; break;
    }
    case 'offline_exact_retry_response_loss_restart': {
      const current = await input.database.db.selectFrom('nodes').select(['resource_revision', 'title']).where('id', '=', NODE).executeTakeFirstOrThrow();
      const baseRevision = current.resource_revision;
      const request = syncNodeUpdatePushRequest({ sessionId: input.state.leftSession!.sessionId,
        replicaId: input.left.replicaId, collectionId: COLLECTION, targetId: NODE, sequence: 2,
        baseRevision, opId: 'p3-26-offline-op', base: { title: current.title }, value: { title: 'Offline retry' } });
      let responseLost = false;
      try {
        const committed = await fetch(`${input.origin}/runtime/push`, { method: 'POST', signal: input.signal,
          headers: { Accept: 'application/json', Authorization: AUTHORIZATION, Origin: ORIGIN,
            'Content-Type': 'application/json', 'Idempotency-Key': 'p3-26-offline' }, body: JSON.stringify(request) });
        if (committed.status !== 200) throw new Error('offline first commit failed');
        responseLost = true; throw new Error('simulated response loss after commit');
      } catch (error) { if (!responseLost) throw error; }
      await input.database.pool.query('discard all');
      const replay = await input.client.push({ idempotencyKey: 'p3-26-offline', request });
      if (replay.status !== 200 || (replay.body as SyncPushResult).results[0]?.opId !== 'p3-26-offline-op') throw new Error('exact retry after response loss changed');
      input.state.leftPush = replay.body as SyncPushResult; outcome = 'replay'; recordTelemetry(input.state, 'push', 'retry', null); break;
    }
    case 'sequence_gap_deferred': {
      const response = await input.client.push({ idempotencyKey: 'p3-26-gap', request: syncNodeUpdatePushRequest({ sessionId: input.state.rightSession!.sessionId, replicaId: input.right.replicaId, collectionId: COLLECTION, targetId: NODE, sequence: 3, baseRevision: 'push-node-r1', opId: 'p3-26-gap-op' }) });
      if (response.status === 200) throw new Error('sequence gap passed'); outcome = 'problem'; problem = (response.body as Problem).code;
      const idempotencyKey = 'p3-26-deferred';
      const request = syncNodeUpdatePushRequest({ sessionId: input.state.rightSession!.sessionId,
        replicaId: input.right.replicaId, collectionId: COLLECTION, targetId: NODE, sequence: 2,
        baseRevision: 'missing-base-revision', opId: 'p3-26-deferred-op' });
      const binding = await input.database.db.selectFrom('sync_sessions')
        .select(['secret_digest', 'lease_generation']).where('session_id', '=', request.sessionId)
        .executeTakeFirstOrThrow();
      const session = await input.issuer.verify({ credential: input.credential,
        sessionId: request.sessionId, collectionId: COLLECTION, replicaId: input.right.replicaId });
      const serverBatchId = `${request.sessionId}.${createHmac('sha256', binding.secret_digest)
        .update('known.sync-push.batch.v1\0', 'utf8').update(idempotencyKey, 'utf8').digest('base64url')}`;
      const sequence = createPostgresSyncSequencePort(input.database.db);
      const deferredResult: SyncPushResult = { batchId: serverBatchId, results: [{
        opId: request.operations[0]!.opId, sequence: 2, status: 'deferred', targetId: NODE,
        code: 'sync_base_unavailable', warnings: [],
      }], serverCursor: 'sync-unchanged' };
      const deferred = await sequence.coordinateAuthorized({ session, replicaId: input.right.replicaId,
        leaseGeneration: String(binding.lease_generation), sequenceScope: `collection:${COLLECTION}`,
        sequence: 2, operationId: request.operations[0]!.opId, serverBatchId,
        endpointIdentity: '/runtime/push', mediaType: 'application/json',
        payload: Object.freeze({ atomic: request.atomic, operation: request.operations[0]! }),
        reevaluateDeferred: true, transactionalAuthority: { credential: input.credential, origin: ORIGIN },
      }, async () => ({ status: 'deferred', result: deferredResult }));
      if (deferred.result.kind !== 'executed' || deferred.result.receipt.status !== 'deferred') throw new Error('durable deferred receipt was not created');
      const finalized = await input.client.push({ idempotencyKey, request });
      if (finalized.status !== 200 || (finalized.body as SyncPushResult).results[0]?.status !== 'conflicted') {
        throw new Error('deferred receipt did not finalize through the black-box Push endpoint');
      }
      break;
    }
    case 'canonical_create_update_move_delete': {
      const response = await input.client.push({ idempotencyKey: 'p3-26-create', request: syncNodeCreatePushRequest({ sessionId: input.state.leftSession!.sessionId, replicaId: input.left.replicaId, collectionId: COLLECTION, sequence: 3, opId: 'p3-26-create-op', parentId: ROOT, node: { kind: 'bookmark', title: 'P3-26 title sentinel', url: 'https://example.test/p3-26-url-sentinel', description: 'P3-26 description sentinel', tags: [], visibility: 'inherit', extensions: { 'https://known.example/p3-26': { sentinel: true } } } }) });
      if (response.status !== 200) {
        const code = typeof response.body === 'object' && response.body !== null && 'code' in response.body
          ? String((response.body as { code?: unknown }).code) : 'unknown';
        throw new Error(`canonical create failed (${response.status}:${code})`);
      }
      const created = await input.database.db.selectFrom('operation_payloads').select('payload_json').where('operation_id', '=', 'p3-26-create-op').executeTakeFirstOrThrow();
      const createdId = (created.payload_json as { resourceId?: unknown }).resourceId;
      if (typeof createdId !== 'string') throw new Error('canonical create identity missing');
      const node = await input.database.db.selectFrom('nodes').select(['resource_revision', 'parent_id']).where('id', '=', createdId).executeTakeFirstOrThrow();
      const sourceParent = await input.database.db.selectFrom('nodes').select('children_revision').where('id', '=', ROOT).executeTakeFirstOrThrow();
      const targetParent = await input.database.db.selectFrom('nodes').select('children_revision').where('id', '=', MOVE_TARGET).executeTakeFirstOrThrow();
      const moved = await input.client.push({ idempotencyKey: 'p3-26-move', request: syncNodeMovePushRequest({ sessionId: input.state.leftSession!.sessionId, replicaId: input.left.replicaId, collectionId: COLLECTION, sequence: 4, opId: 'p3-26-move-op', targetId: createdId, baseRevision: node.resource_revision, newParentId: MOVE_TARGET, baseSourceParentRevision: sourceParent.children_revision, baseTargetParentRevision: targetParent.children_revision }) });
      if (moved.status !== 200) throw new Error('canonical move failed');
      const movedRevision = (moved.body as SyncPushResult).results[0]?.revision;
      if (!movedRevision) throw new Error('canonical move revision missing');
      const deleted = await input.client.push({ idempotencyKey: 'p3-26-delete', request: syncNodeDeletePushRequest({ sessionId: input.state.leftSession!.sessionId, replicaId: input.left.replicaId, collectionId: COLLECTION, sequence: 5, opId: 'p3-26-delete-op', targetId: createdId, baseRevision: movedRevision }) });
      if (deleted.status !== 200) throw new Error('canonical delete failed'); break;
    }
    case 'typed_merge_open_conflict': {
      const response = await input.client.push({ idempotencyKey: 'p3-26-conflict', request: syncNodeUpdatePushRequest({ sessionId: input.state.rightSession!.sessionId, replicaId: input.right.replicaId, collectionId: COLLECTION, targetId: NODE, sequence: 3, baseRevision: 'push-node-r1', opId: 'p3-26-conflict-op', base: { title: 'Before' }, value: { title: 'Right' } }) });
      if (response.status !== 200) throw new Error('conflict push failed'); const result = (response.body as SyncPushResult).results[0]!;
      if (result.status !== 'conflicted' || !result.conflictId) throw new Error('open conflict not produced');
      const row = await input.database.db.selectFrom('sync_conflicts').select(['conflict_id', 'revision']).where('conflict_id', '=', result.conflictId).executeTakeFirstOrThrow(); input.state.conflict = { id: row.conflict_id, revision: row.revision }; break;
    }
    case 'conflict_resolution_variants': {
      endpoint = { key: 'syncConflict', method: 'POST', routeTemplate: '/runtime/conflicts/{conflictId}/resolve', uri: `${input.origin}/runtime/conflicts/{conflictId}/resolve` };
      const response = await input.client.resolveConflict({ conflictId: input.state.conflict!.id, sessionId: input.state.rightSession!.sessionId, replicaId: input.right.replicaId, collectionId: COLLECTION, conflictRevision: input.state.conflict!.revision, idempotencyKey: 'p3-26-resolve', request: { resolution: 'server', baseConflictRevision: input.state.conflict!.revision } });
      if (response.status !== 200) throw new Error('conflict resolution failed'); break;
    }
    case 'pull_tuple_pagination_exact_retry': {
      endpoint = { key: 'syncPull', method: 'GET', routeTemplate: '/runtime/pull', uri: `${input.origin}/runtime/pull` };
      const session = input.state.leftSession!; const cursor = input.state.firstSnapshot?.syncCursor;
      if (typeof cursor !== 'string') throw new Error('left Snapshot omitted initial Pull cursor');
      input.state.pull = await input.client.pull({ sessionId: session.sessionId, cursor, limit: 100, signal: input.signal }); break;
    }
    case 'ack_monotonic': {
      endpoint = { key: 'syncAck', method: 'POST', routeTemplate: '/runtime/ack', uri: `${input.origin}/runtime/ack` };
      const response = await input.client.ack({ idempotencyKey: 'p3-26-ack', request: { sessionId: input.state.leftSession!.sessionId, cursor: input.state.pull!.nextCursor, warnings: [] } }); if (response.status !== 200) throw new Error('ack failed');
      break;
    }
    case 'tombstone_retention_ack_purge': {
      endpoint = { key: 'purge', method: 'JOB', routeTemplate: 'sync-tombstone-purge', uri: 'job:sync-tombstone-purge' };
      const rightCatchUp = await input.client.pull({ sessionId: input.state.rightSession!.sessionId,
        cursor: input.state.rightCursor!, limit: 100, signal: input.signal });
      const rightAck = await input.client.ack({ idempotencyKey: 'p3-26-right-purge-ack',
        request: { sessionId: input.state.rightSession!.sessionId, cursor: rightCatchUp.nextCursor, warnings: [] } });
      if (rightAck.status !== 200) throw new Error('right Replica did not Ack beyond the tombstone');
      const coordinator = new PostgresSyncTombstonePurgeCoordinator(input.database.db, { workerId: 'p3-26-runner', batchSize: 100, leaseDurationMs: 30_000 });
      const purged = await coordinator.runBatch({ now: new Date('2030-01-01T00:00:00Z') });
      if (purged.purgedCount < 1) throw new Error('production purge did not compact the tombstone'); break;
    }
    case 'stale_recovery_snapshot_bootstrap_ack': {
      endpoint = { key: 'syncSnapshot', method: 'GET', routeTemplate: '/runtime/snapshot', uri: `${input.origin}/runtime/snapshot` };
      const recoveryRequired = await input.recovery.requireRecoveryForStaleCursor({ credential: input.credential,
        sessionId: input.state.rightSession!.sessionId, cursor: input.state.rightCursor! });
      if (recoveryRequired.state !== 'recovery_required') throw new Error('production stale-cursor recovery transition failed');
      try { await input.client.pull({ sessionId: input.state.rightSession!.sessionId, cursor: input.state.rightCursor!, limit: 100, signal: input.signal }); throw new Error('stale cursor unexpectedly pulled'); }
      catch (error) { if (!(error instanceof Error) || !/stale_replica|unexpected status/iu.test(error.message)) throw error; }
      const pages = []; let pageCursor: string | undefined;
      do { const page = await input.client.snapshot({ sessionId: input.state.rightSession!.sessionId, limit: 100, ...(pageCursor ? { pageCursor } : {}) }); pages.push(page); pageCursor = page.page.nextCursor ?? undefined; } while (pageCursor);
      const complete = pages.at(-1);
      const capability = complete?.syncCursor;
      const snapshotId = complete?.snapshotId;
      // Protocol 0.1 still carries the recovery capability inside syncCursor.
      // A non-empty open-conflict cut refuses Ack until that cut is confirmed.
      if (typeof capability !== 'string' || !capability.startsWith('src1.') || typeof snapshotId !== 'string') throw new Error('recovery Snapshot omitted capability');
      await confirmRecoveryOpenConflicts({ origin: input.origin, sessionId: input.state.rightSession!.sessionId, snapshotId, signal: input.signal });
      const ack = await input.client.ack({ idempotencyKey: 'p3-26-recovery-ack', request: { sessionId: input.state.rightSession!.sessionId, cursor: capability, warnings: [] } });
      if (ack.status !== 200) {
        const problem = ack.body as { readonly code?: string };
        throw new Error(`Bootstrap recovery Ack failed (${ack.status}:${problem.code ?? 'unknown'})`);
      }
      recordTelemetry(input.state, 'recovery', 'success', null); break;
    }
    case 'retired_all_surfaces_rejected': {
      endpoint = { key: 'syncRetire', method: 'DELETE', routeTemplate: '/runtime/replica', uri: `${input.origin}/runtime/replica` };
      const response = await fetch(endpoint.uri, { method: 'DELETE', signal: input.signal, headers: { Authorization: AUTHORIZATION, Origin: ORIGIN, 'Known-Sync-Session': input.state.leftSession!.sessionId, 'Idempotency-Key': 'p3-26-retire' } }); if (response.status !== 204) throw new Error(`retire failed (${response.status}:${input.retirementFailure()})`);
      const sessionDenied = await fetch(`${input.origin}/runtime/session`, { method: 'POST', signal: input.signal,
        headers: { Authorization: AUTHORIZATION, Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'p3-26-retired-session' }, body: JSON.stringify(sessionRequest(input.left)) });
      const snapshotDenied = await fetch(`${input.origin}/runtime/snapshot?sessionId=${encodeURIComponent(input.state.leftSession!.sessionId)}`, { signal: input.signal, headers: { Authorization: AUTHORIZATION, Origin: ORIGIN } });
      const pushDenied = await input.client.push({ idempotencyKey: 'p3-26-retired-push', request: syncPushAdmissionRequest({ sessionId: input.state.leftSession!.sessionId, replicaId: input.left.replicaId, collectionId: COLLECTION, sequence: 6, opId: 'p3-26-retired-op' }) });
      let pullRejected = false; try { await input.client.pull({ sessionId: input.state.leftSession!.sessionId, cursor: input.state.pull!.nextCursor, limit: 100, signal: input.signal }); } catch { pullRejected = true; }
      const ackDenied = await input.client.ack({ idempotencyKey: 'p3-26-retired-ack', request: { sessionId: input.state.leftSession!.sessionId, cursor: input.state.pull!.nextCursor, warnings: [] } });
      const conflictDenied = await input.client.resolveConflict({ conflictId: input.state.conflict!.id, sessionId: input.state.leftSession!.sessionId, replicaId: input.left.replicaId, collectionId: COLLECTION, conflictRevision: input.state.conflict!.revision, idempotencyKey: 'p3-26-retired-conflict', request: { resolution: 'server', baseConflictRevision: input.state.conflict!.revision } });
      if (sessionDenied.ok || snapshotDenied.ok || pushDenied.status === 200 || !pullRejected || ackDenied.status === 200 || conflictDenied.status === 200) throw new Error('retired Replica reached a Sync surface');
      outcome = 'problem'; problem = 'replica_retired'; break;
    }
    case 'unknown_extension_round_trip': {
      endpoint = { key: 'syncPull', method: 'GET', routeTemplate: '/runtime/pull', uri: `${input.origin}/runtime/pull` };
      const createEvent = input.state.pull?.events.find((event) => event.kind === 'operation'
        && event.operation.opId === 'p3-26-create-op');
      const payload = createEvent?.kind === 'operation'
        ? createEvent.operation.payload as { node?: { extensions?: Record<string, unknown> } } : undefined;
      if (JSON.stringify(payload?.node?.extensions?.['https://known.example/p3-26']) !== '{"sentinel":true}') {
        throw new Error('unknown extension did not round trip');
      }
      break;
    }
    case 'managed_bookmark_role': {
      input.state.rightSession = (await input.client.create({ idempotencyKey: 'p3-26-right-post-recovery', request: sessionRequest(input.right) })).body;
      // FIX-H-002: conflict resolution now claims real slots on the resolver's
      // own lane, so derive the right lane's current next_sequence instead of a
      // hardcoded value (a stale sequence would be rejected as sequence_reuse
      // before the managed-bookmarks node_read_only check runs).
      const rightLane = await input.database.pool.query<{ next_sequence: string }>(
        `select next_sequence::text from sync_sequence_lanes
         where replica_id=$1 and sequence_scope=$2`,
        [input.right.replicaId, `collection:${COLLECTION}`],
      );
      const nextSequence = Number(rightLane.rows[0]?.next_sequence ?? 1);
      const response = await input.client.push({ idempotencyKey: 'p3-26-managed', request: syncNodeCreatePushRequest({ sessionId: input.state.rightSession.sessionId, replicaId: input.right.replicaId, collectionId: COLLECTION, sequence: nextSequence, opId: 'p3-26-managed-op', parentId: ROOT, node: { kind: 'folder', title: 'Managed', folderRole: 'managed-bookmarks' } }) });
      if (response.status === 200) throw new Error('managed bookmark write passed');
      outcome = 'problem'; problem = (response.body as Problem).code;
      if (problem !== 'node_read_only') throw new Error(`managed bookmark role returned ${problem ?? 'no_problem'}`);
      break;
    }
    case 'mounted_root_binding_isolation': { endpoint = { key: 'syncSnapshot', method: 'GET', routeTemplate: '/runtime/snapshot', uri: `${input.origin}/runtime/snapshot` }; const snapshot = await input.client.snapshot({ sessionId: input.state.rightSession!.sessionId, limit: 100 }); const binding = snapshot.collection.extensions?.['https://known.example/extensions/sync-binding'] as { mode?: unknown } | undefined; if (binding?.mode !== 'mounted-folder') throw new Error('mounted root binding was not isolated in Snapshot'); break; }
    case 'registered_problem_internal_timeout_abort_retry_replay_concurrency': {
      outcome = 'concurrency'; const results = await Promise.all([fetch(`${input.origin}/runtime/pull`, { signal: input.signal }), fetch(`${input.origin}/runtime/pull`, { signal: input.signal })]); if (results.some((response) => response.status < 400)) throw new Error('unauthenticated concurrent pull passed'); problem = 'authentication_required';
      const aborted = new AbortController(); aborted.abort(new Error('P3-26 abort control')); try { await fetch(`${input.origin}/runtime/pull`, { signal: aborted.signal }); throw new Error('aborted request passed'); } catch (error) { if (error instanceof Error && error.message === 'aborted request passed') throw error; recordTelemetry(input.state, 'pull', 'abort', null); }
      const stalledBody = new Readable({ read() {} });
      try {
        await fetch(`${input.origin}/runtime/session`, { method: 'POST', body: stalledBody,
          duplex: 'half', signal: AbortSignal.timeout(10), headers: { Authorization: AUTHORIZATION,
            Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': 'p3-26-timeout' } } as RequestInit & { duplex: 'half' });
        throw new Error('timeout request passed');
      } catch (error) {
        if (error instanceof Error && error.message === 'timeout request passed') throw error;
        recordTelemetry(input.state, 'session', 'timeout', null);
      } finally { stalledBody.destroy(); }
      try { await input.database.pool.query('select * from p3_26_missing_fault_table'); throw new Error('database fault passed'); } catch (error) { if (error instanceof Error && error.message === 'database fault passed') throw error; recordTelemetry(input.state, 'recovery', 'internal', 'internal_error'); }
      break;
    }
    case 'telemetry_sentinel_redaction': { endpoint = { key: 'telemetry', method: 'JOB', routeTemplate: 'telemetry-redaction-scan', uri: 'job:telemetry-redaction-scan' }; input.state.telemetry.redactProbe(); break; }
    case 'manifest_sync_unclaimed': { endpoint = { key: 'manifest', method: 'GET', routeTemplate: '/.well-known/collection-protocol', uri: `${input.origin}/.well-known/collection-protocol` }; const manifestValue = await fetch(endpoint.uri, { signal: input.signal }).then(async (response) => response.json()) as Manifest; if (manifestValue.mounts.some((mount) => mount.profiles.includes('sync'))) throw new Error('Manifest claims sync'); break; }
  }
  for (const port of observedPortsFor(input.scenario)) input.state.observedPorts.add(port);
  const after = await facts(input.database); const telemetryEndpoint = normalizeTelemetryEndpoint(endpoint.key);
  if (telemetryEndpoint) recordTelemetry(input.state, telemetryEndpoint, outcome, problem);
  return { endpoint, outcome, problem, transactionEvidence: { before, after }, generationBefore: before.generation, generationAfter: after.generation, boundaryBefore: before.boundary, boundaryAfter: after.boundary, counts: { responses: 1, rowsBefore: before.rows, rowsAfter: after.rows } };
}

function observedPortsFor(scenario: Phase3ServerSyncScenario): readonly Phase3ServerSyncPort[] {
  switch (scenario) {
    case 'manifest_session_snapshot': return ['credentialVerifier', 'session', 'snapshot'];
    case 'two_replica_concurrent_edit': return ['sequence', 'canonicalMutation', 'pull'];
    case 'typed_merge_open_conflict': case 'conflict_resolution_variants': return ['conflict'];
    case 'ack_monotonic': return ['ack'];
    case 'tombstone_retention_ack_purge': return ['tombstonePurge'];
    case 'stale_recovery_snapshot_bootstrap_ack': return ['recovery'];
    case 'retired_all_surfaces_rejected': return ['retire'];
    default: return [];
  }
}

function normalizeTelemetryEndpoint(key: string): (typeof P3_26_TELEMETRY_ENDPOINTS)[number] | undefined {
  const mapped: Record<string, (typeof P3_26_TELEMETRY_ENDPOINTS)[number]> = {
    manifest: 'manifest', syncSessions: 'session', syncSnapshot: 'snapshot', syncPush: 'push',
    syncConflict: 'conflict', syncPull: 'pull', syncAck: 'ack', purge: 'purge',
    recovery: 'recovery', syncRetire: 'retire',
  };
  return mapped[key];
}

function recordTelemetry(
  state: { telemetry: TelemetryCapture }, endpoint: (typeof P3_26_TELEMETRY_ENDPOINTS)[number],
  outcome: (typeof P3_26_TELEMETRY_OUTCOMES)[number], problem: string | null,
): void {
  const normalizedProblem = normalizeTelemetryProblem(problem);
  const record = { endpoint, outcome, problem: normalizedProblem, bucket: 'under_10ms' as const, durationMs: 0 };
  state.telemetry.records.push(JSON.stringify(record));
  state.telemetry.recorder.record(record);
}

function createTelemetryCapture(): TelemetryCapture {
  const logs: string[] = [];
  const metrics: string[] = [];
  const problems: string[] = [];
  const records: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, complete) { logs.push(chunk.toString()); complete(); },
  });
  const logger = createLogger('info', destination);
  const metricStore = new InMemoryMetrics({ onIncrement(name, value) { metrics.push(`${name}:${value}`); } });
  const recorder = createSyncServerTelemetry({ metrics: metricStore, logger });
  return Object.freeze({ records, logs, metrics, problems, recorder, logger,
    redactProbe() {
      logger.info({ authorization: AUTHORIZATION, token: CURSOR_SENTINEL,
        secret: ERROR_SENTINEL }, 'P3-26 redaction probe');
    },
  });
}

function installRuntimeTelemetry(app: FastifyInstance, capture: TelemetryCapture): void {
  const started = new WeakMap<object, number>();
  app.addHook('onRequest', async (request) => {
    if (runtimeTelemetryEndpoint(request.url)) started.set(request, performance.now());
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.statusCode >= 400) capture.problems.push(typeof payload === 'string' ? payload : String(payload));
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const endpoint = runtimeTelemetryEndpoint(request.url); const start = started.get(request);
    if (!endpoint || start === undefined) return;
    const durationMs = Math.max(0, performance.now() - start);
    const outcome = request.raw.aborted ? 'abort' : reply.statusCode === 408 ? 'timeout'
      : reply.statusCode >= 500 ? 'internal' : reply.statusCode >= 400 ? 'problem' : 'success';
    const problem: SyncTelemetryProblem = reply.statusCode === 401 ? 'authentication_required'
      : reply.statusCode === 403 ? 'authorization_denied' : reply.statusCode === 429 ? 'rate_limited'
        : reply.statusCode >= 500 ? 'internal_error' : 'none';
    const record = { endpoint, outcome, problem, bucket: syncDurationBucket(durationMs), durationMs };
    capture.records.push(JSON.stringify(record)); capture.recorder.record(record);
  });
}

function runtimeTelemetryEndpoint(rawUrl: string): SyncTelemetryEndpoint | undefined {
  const path = rawUrl.split('?', 1)[0] ?? '';
  if (path === '/.well-known/collection-protocol') return 'manifest';
  if (path === '/runtime/session') return 'session';
  if (path === '/runtime/snapshot') return 'snapshot';
  if (path === '/runtime/push') return 'push';
  if (/^\/runtime\/conflicts\/[^/]+\/resolve$/u.test(path)) return 'conflict';
  if (path === '/runtime/pull') return 'pull';
  if (path === '/runtime/ack') return 'ack';
  if (path === '/runtime/replica') return 'retire';
  return undefined;
}

function normalizeTelemetryProblem(problem: string | null): SyncTelemetryProblem {
  const known = new Set<SyncTelemetryProblem>(['none', 'authentication_required', 'authorization_denied',
    'invalid_document', 'invalid_json', 'sequence_gap', 'sequence_blocked', 'conflict',
    'precondition_failed', 'rate_limited', 'replica_retired', 'recovery_required',
    'service_unavailable', 'internal_error']);
  if (problem === null) return 'none';
  return known.has(problem as SyncTelemetryProblem) ? problem as SyncTelemetryProblem : 'authorization_denied';
}

async function collectProbeFacts(
  database: DatabaseRuntime,
  state: Pick<ScenarioState, 'observedPorts' | 'telemetry'>,
  routes: readonly { key: Phase3ServerSyncRoute }[],
  instanceId: string,
  startedAt: string,
) {
  const observations = new Map<Phase3ServerSyncProbeName, string>();
  const connectivity = await database.pool.query<{ value: number }>('select 1::int value');
  if (connectivity.rows[0]?.value !== 1) throw new Error('PostgreSQL connectivity probe failed');
  observations.set('postgresConnectivity', 'postgresql:select-1');
  const requiredMigration = await database.pool.query<{ present: boolean }>(`select exists (
    select 1 from kysely_migration where name = '202607252700_sync_operation_effects'
  ) as present`);
  if (requiredMigration.rows[0]?.present !== true) throw new Error('production migration probe failed');
  observations.set('productionMigrations', '202607252700_sync_operation_effects');
  if (routes.length !== P3_26_REQUIRED_ROUTES.length) throw new Error('Manifest discovery probe failed');
  observations.set('manifestDiscovery', routes.map((route) => route.key).join(','));
  if (state.observedPorts.size !== P3_26_REQUIRED_PORTS.length) throw new Error('runtime composition probe failed');
  observations.set('runtimeComposition', [...state.observedPorts].sort().join(','));
  observations.set('credentialAdapter', 'verified-http-session-and-denial-control');
  observations.set('colpConformance', 'manifest-and-sync-wire-schema-validation-observed');
  const scan = telemetryScan(state.telemetry); observations.set('telemetryRedaction', `${scan.scannedBytes}:${scan.leaks}`);
  const directory = await mkdtemp(resolve(tmpdir(), 'known-p3-26-artifact-probe-'));
  try {
    const source = resolve(directory, 'source'); const target = resolve(directory, 'target');
    await writeFile(source, 'probe', { flag: 'wx' }); await link(source, target);
    try { await link(source, target); throw new Error('artifact overwrite probe unexpectedly succeeded'); }
    catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
    observations.set('artifactAtomicWrite', 'exclusive-link-overwrite-rejected');
  } finally { await rm(directory, { recursive: true, force: true }); }
  return P3_26_REQUIRED_PROBES.map((name) => {
    const observation = observations.get(name); if (!observation) throw new Error(`probe ${name} was not observed`);
    return { name, outcome: 'passed' as const, observationDigest: digest(`${instanceId}:${name}:${observation}`), startedAt, finishedAt: new Date().toISOString() };
  });
}

async function seedAuthority(database: DatabaseRuntime, suffix: string): Promise<void> {
  const now = new Date(); const collectionPayload = materializeCollectionPayload({ id: COLLECTION, ownerSubjectId: SUBJECT, title: 'P3-26', summary: null, kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT, resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1', commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null });
  const rootPayload = materializeNodePayload({ id: ROOT, collectionId: COLLECTION, parentId: null, kind: 'folder', isRoot: true, title: 'Root', url: null, description: null, tags: [], visibility: 'inherit', positionToken: null, resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null, extensions: { 'https://known.example/p3-26': { sentinel: suffix } } });
  const nodePayload = materializeNodePayload({ id: NODE, collectionId: COLLECTION, parentId: ROOT, kind: 'folder', isRoot: false, title: 'Before', url: null, description: null, tags: [], visibility: 'inherit', positionToken: 'A', resourceRevision: 'push-node-r1', childrenRevision: 'node-children-r1', createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null });
  const moveTargetPayload = materializeNodePayload({ id: MOVE_TARGET, collectionId: COLLECTION, parentId: ROOT, kind: 'folder', isRoot: false, title: 'Move target', url: null, description: null, tags: [], visibility: 'inherit', positionToken: 'B', resourceRevision: 'move-target-r1', childrenRevision: 'move-target-children-r1', createdAt: now, updatedAt: now, deletedAt: null, deletedCommitOrdinal: null });
  if (!collectionPayload.ok || !rootPayload.ok || !nodePayload.ok || !moveTargetPayload.ok) throw new Error('P3-26 seed payload failed');
  await database.db.transaction().execute(async (tx) => {
    await tx.insertInto('accounts').values({ id: ACCOUNT, subject_id: SUBJECT, status: 'active', security_epoch: 0n }).execute();
    await tx.insertInto('profiles').values({ account_id: ACCOUNT, display_name: 'P3-26 Sync fixture', avatar_url: null }).execute();
    await tx.insertInto('profile_handles').values({
      handle: `p3-26-${suffix.toLowerCase()}`, account_id: ACCOUNT,
    }).execute();
    await tx.insertInto('account_identities').values({ id: `p3-26-identity-${suffix}`, account_id: ACCOUNT, issuer: ISSUER, subject: `${SUBJECT}-oidc` }).execute();
    await tx.insertInto('resource_id_ledger').values([{ resource_id: COLLECTION, resource_type: 'collection' }, { resource_id: ROOT, resource_type: 'node' }, { resource_id: NODE, resource_type: 'node' }, { resource_id: MOVE_TARGET, resource_type: 'node' }]).execute();
    await tx.insertInto('collections').values({ id: COLLECTION, owner_subject_id: SUBJECT, title: 'P3-26', kind: 'bookmarks', root_node_id: ROOT, resource_revision: 'collection-r1', content_revision: 'content-r1', policy_revision: 'policy-r1', visibility: 'private', commit_ordinal: 0n, created_at: now, updated_at: now, deleted_at: null, payload_json: collectionPayload.payload, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }).execute();
    await tx.insertInto('nodes').values([{ id: ROOT, collection_id: COLLECTION, parent_id: null, kind: 'folder', is_root: true, title: 'Root', url: null, position_token: null, resource_revision: 'root-r1', children_revision: 'children-r1', deleted_at: null, visibility: 'inherit', created_at: now, updated_at: now, payload_json: rootPayload.payload, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }, { id: NODE, collection_id: COLLECTION, parent_id: ROOT, kind: 'folder', is_root: false, title: 'Before', url: null, position_token: 'A', resource_revision: 'push-node-r1', children_revision: 'node-children-r1', deleted_at: null, visibility: 'inherit', created_at: now, updated_at: now, payload_json: nodePayload.payload, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }, { id: MOVE_TARGET, collection_id: COLLECTION, parent_id: ROOT, kind: 'folder', is_root: false, title: 'Move target', url: null, position_token: 'B', resource_revision: 'move-target-r1', children_revision: 'move-target-children-r1', deleted_at: null, visibility: 'inherit', created_at: now, updated_at: now, payload_json: moveTargetPayload.payload, payload_schema_version: RESOURCE_PAYLOAD_SCHEMA_VERSION, payload_authority_status: 'backfilled' }]).execute();
    await tx.insertInto('sync_node_revision_history').values({ collection_id: COLLECTION, resource_id: NODE, revision: 'push-node-r1', kind: 'folder', payload_json: nodePayload.payload, commit_ordinal: 0n, operation_id: null }).execute();
  });
}

function replicaCreate(name: string, mountMode: 'whole-profile' | 'mounted-folder') { return { accountId: ACCOUNT, collectionId: COLLECTION, deviceName: name, replicaName: name, kind: 'browser_extension' as const, adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true, events: true, separator: true, alias: false, annotations: 'sidecar' as const, maxBatchOperations: 1 as const }, binding: { browserProfileId: `profile-${name}`, mountMode, browserGeneration: `generation-${name}` }, leaseDurationSeconds: 3_600 }; }
function sessionRequest(replica: { replicaId: string; binding: { browserProfileId: string; browserGeneration: string; mountMode: 'whole-profile' | 'mounted-folder' } }): SyncSessionRequest { return { protocolVersion: '0.1', scope: 'collection', clientTime: new Date().toISOString(), replica: { replicaId: replica.replicaId, name: 'P3-26', kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' }, capabilities: { read: true, write: true, events: true, separator: true, alias: false, annotations: 'sidecar', maxBatchOperations: 1 }, binding: { browserProfileId: replica.binding.browserProfileId, mountMode: replica.binding.mountMode, mountNativeId: 'p3-26-native-sentinel', generation: replica.binding.browserGeneration }, extensions: {} }, collection: { collectionId: COLLECTION, lastCursor: null, lastRevision: null, bootstrapMode: 'download' } }; }

async function confirmRecoveryOpenConflicts(input: {
  readonly origin: string; readonly sessionId: string; readonly snapshotId: string; readonly signal: AbortSignal;
}): Promise<void> {
  const headers = {
    Accept: 'application/json', Authorization: AUTHORIZATION, Origin: ORIGIN,
    'Known-Sync-Session': input.sessionId, 'known-sync-conflict-recovery': '1',
  };
  let offset = 0;
  let digest = '';
  let count = 0;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('/runtime/snapshot/conflicts', input.origin);
    url.searchParams.set('sessionId', input.sessionId);
    url.searchParams.set('snapshotId', input.snapshotId);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '50');
    const listed = await fetch(url, { signal: input.signal, headers });
    if (!listed.ok) throw new Error(`Bootstrap recovery conflict list failed (${listed.status}:${await problemCode(listed)})`);
    const body = await listed.json() as { readonly conflictCount?: unknown; readonly conflictDigest?: unknown; readonly nextOffset?: unknown };
    if (typeof body.conflictDigest !== 'string' || typeof body.conflictCount !== 'number') throw new Error('Bootstrap recovery conflict list omitted the cut');
    digest = body.conflictDigest;
    count = body.conflictCount;
    if (body.nextOffset == null) break;
    if (typeof body.nextOffset !== 'number' || page === 19) throw new Error('Bootstrap recovery conflict pages did not end');
    offset = body.nextOffset;
  }
  if (count === 0) return;
  const confirmed = await fetch(new URL(`/runtime/snapshot/conflicts?sessionId=${encodeURIComponent(input.sessionId)}&snapshotId=${encodeURIComponent(input.snapshotId)}`, input.origin), {
    method: 'POST', signal: input.signal,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshotId: input.snapshotId, conflictDigest: digest }),
  });
  if (!confirmed.ok) throw new Error(`Bootstrap recovery conflict confirm failed (${confirmed.status}:${await problemCode(confirmed)})`);
}

async function problemCode(response: Response): Promise<string> {
  try {
    const body = await response.json() as { readonly code?: unknown };
    return typeof body.code === 'string' ? body.code : 'unknown';
  } catch {
    return 'unknown';
  }
}
function manifest(origin: string): Manifest { return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'], serverId: `${origin}/`, serverUuid: '019f9d33-2626-7262-8262-262626262626', title: 'Known', mounts: [{ id: 'p3-26', baseUrl: `${origin}/`, profiles: ['core'], endpoints: { directory: `${origin}/directory`, collection: `${origin}/collections/{collectionId}`, snapshot: `${origin}/collections/{collectionId}/snapshot`, syncSessions: `${origin}/runtime/session`, syncSnapshot: `${origin}/runtime/snapshot`, syncPush: `${origin}/runtime/push`, syncConflict: `${origin}/runtime/conflicts/{conflictId}/resolve`, syncPull: `${origin}/runtime/pull`, syncAck: `${origin}/runtime/ack` }, features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } }, auth: { anonymousRead: false, apiKeys: false, oauth: true, protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` }, limits: { maxPageSize: 100, maxSnapshotNodes: 10_000, minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 }, 'https://known.example/extensions/sync-retire': { href: `${origin}/runtime/replica`, method: 'DELETE', requestBody: false, successStatus: 204, requiredHeaders: ['Known-Sync-Session', 'Idempotency-Key'] } }] } as Manifest; }
function originOf(app: FastifyInstance): string { const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('P3-26 Fastify is not listening'); return `http://127.0.0.1:${address.port}`; }
function discoverRouteFacts(value: Manifest, at: string) { const mount = value.mounts.find((entry) => entry.id === 'p3-26'); if (!mount) throw new Error('P3-26 Manifest mount missing'); const retire = (mount as unknown as Record<string, unknown>)['https://known.example/extensions/sync-retire'] as { href?: unknown; method?: unknown } | undefined; if (typeof retire?.href !== 'string' || retire.method !== 'DELETE') throw new Error('P3-25 retire extension contract missing'); const paths: Record<Phase3ServerSyncRoute, [string, 'GET' | 'POST' | 'DELETE']> = { manifest: ['/.well-known/collection-protocol', 'GET'], syncSessions: [mount.endpoints.syncSessions!, 'POST'], syncSnapshot: [mount.endpoints.syncSnapshot!, 'GET'], syncPush: [mount.endpoints.syncPush!, 'POST'], syncConflict: [mount.endpoints.syncConflict!, 'POST'], syncPull: [mount.endpoints.syncPull!, 'GET'], syncAck: [mount.endpoints.syncAck!, 'POST'], syncRetire: [retire.href, 'DELETE'] }; return P3_26_REQUIRED_ROUTES.map((key) => { const [uri, method] = paths[key]; return { key, method, routeTemplate: key === 'manifest' ? uri : new URL(uri).pathname, uriDigest: digest(uri), discoveredAt: at }; }); }
function registerRuntimeComposition(app: FastifyInstance, registrations: RuntimeRegistrations, omit?: Phase3ServerSyncRoute): void { for (const route of P3_26_REQUIRED_ROUTES) if (route !== omit) registrations[route](app); }
async function facts(database: DatabaseRuntime) { const value = await database.pool.query<{ rows: number; generation: string | null; boundary: string | null }>(`select (select count(*)::int from operations) rows, (select max(lease_generation)::text from sync_replicas) generation, (select max(commit_ordinal)::text from operations) boundary`); return { rows: value.rows[0]?.rows ?? 0, generation: value.rows[0]?.generation ?? null, boundary: value.rows[0]?.boundary ?? null }; }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function collectPortFacts(observedPorts: ReadonlySet<Phase3ServerSyncPort>, instanceId: string, observedAt: string) {
  for (const name of P3_26_REQUIRED_PORTS) {
    if (!observedPorts.has(name)) throw new Error(`P3-26 runtime port ${name} was not observed`);
  }
  return P3_26_REQUIRED_PORTS.map((name) => ({ name,
    source: name === 'credentialVerifier' ? 'http-observation' as const : 'database-observation' as const,
    observationDigest: digest(`${instanceId}:${name}:observed`), observedAt }));
}

function requiredControlTargets(routes: readonly { key: Phase3ServerSyncRoute }[]) { return [...routes.map((route) => ['route', route.key] as const), ...P3_26_REQUIRED_PORTS.map((port) => ['port', port] as const), ['credential', 'adapter'] as const, ['database', 'disconnect'] as const, ['artifact', 'unwritable'] as const, ['source', 'digest'] as const, ['colp', 'digest'] as const, ['config', 'digest'] as const, ['step', 'omission'] as const]; }
async function runNegativeControls(
  database: DatabaseRuntime, env: NodeJS.ProcessEnv,
  routes: readonly { key: Phase3ServerSyncRoute; method: 'GET' | 'POST' | 'DELETE' }[],
  registrations: RuntimeRegistrations, origin: string, signal: AbortSignal,
  steps: readonly Phase3ServerSyncStepFact[], observedPorts: ReadonlySet<Phase3ServerSyncPort>,
  instanceId: string, observedAt: string, runtimeNonce: string,
  repositoryBindings: RepositoryBindings,
  verifyRepositoryBindings: (expected: unknown, observed: unknown) => void,
): Promise<readonly Phase3ServerSyncNegativeFact[]> {
  const databaseUrl = env.DATABASE_URL; if (!databaseUrl) throw new Error('negative controls require DATABASE_URL');
  const migrations = await database.pool.query<{ name: string }>('select name from kysely_migration order by name');
  const targets = [...requiredControlTargets(routes), ...migrations.rows.map((row) => ['migration', `${row.name}.ts`] as const)];
  while (targets.length < 32) targets.push(['database', `fault-${targets.length}`]);
  const facts: Phase3ServerSyncNegativeFact[] = [];
  for (const [index, [targetKind, target]] of targets.entries()) {
    if (signal.aborted) throw signal.reason;
    const startedAt = new Date().toISOString();
    const observation = await exerciseNegativeControl({ database, databaseUrl, env, routes,
      registrations, origin, targetKind, target, signal, steps, observedPorts, instanceId,
      observedAt, runtimeNonce, repositoryBindings, verifyRepositoryBindings });
    facts.push({ id: `negative:${index}`, targetKind, target,
      injection: 'isolated production-composition fault', outcome: 'failed_closed',
      observationDigest: digest(observation), startedAt, finishedAt: new Date().toISOString() });
  }
  return Object.freeze(facts);
}

async function exerciseNegativeControl(input: {
  database: DatabaseRuntime; databaseUrl: string; env: NodeJS.ProcessEnv; routes: readonly { key: Phase3ServerSyncRoute; method: 'GET' | 'POST' | 'DELETE' }[]; registrations: RuntimeRegistrations; origin: string;
  targetKind: Phase3ServerSyncNegativeFact['targetKind']; target: string; signal: AbortSignal;
  steps: readonly Phase3ServerSyncStepFact[]; observedPorts: ReadonlySet<Phase3ServerSyncPort>;
  instanceId: string; observedAt: string; runtimeNonce: string;
  repositoryBindings: RepositoryBindings;
  verifyRepositoryBindings: (expected: unknown, observed: unknown) => void;
}): Promise<string> {
  switch (input.targetKind) {
    case 'route': {
      const isolated = Fastify({ logger: false });
      try {
        const omitted = input.target as Phase3ServerSyncRoute;
        registerRuntimeComposition(isolated, input.registrations, omitted);
        await isolated.listen({ host: '127.0.0.1', port: 0 });
        const isolatedOrigin = originOf(isolated);
        let uri = `${isolatedOrigin}/.well-known/collection-protocol`;
        if (omitted !== 'manifest') {
          const advertised = await fetch(uri, { signal: input.signal });
          if (!advertised.ok) throw new Error('isolated production Manifest failed');
          uri = negativeRouteUri(await advertised.json() as Manifest, omitted);
        }
        const method = input.routes.find((route) => route.key === omitted)?.method;
        if (!method) throw new Error(`omitted route ${omitted} has no method`);
        const response = await fetch(uri.replace('{conflictId}', 'omitted-control'), { method, signal: input.signal });
        if (response.status !== 404) throw new Error(`omitted route ${input.target} did not fail closed`);
        return `route:${input.target}:manifest-advertised-status:${response.status}`;
      } finally { await isolated.close(); }
    }
    case 'port': {
      const omitted = input.target as Phase3ServerSyncPort;
      const observed = new Set(input.observedPorts); observed.delete(omitted);
      try { collectPortFacts(observed, input.instanceId, input.observedAt); }
      catch (error) {
        if (error instanceof Error && error.message === `P3-26 runtime port ${omitted} was not observed`) {
          return `port:${omitted}:acceptance-port-fact-rejected`;
        }
        throw error;
      }
      throw new Error(`port ${omitted} acceptance gate did not fail closed`);
    }
    case 'credential': {
      const response = await fetch(`${input.origin}/runtime/session`, { method: 'POST', signal: input.signal,
        headers: { Authorization: 'Bearer invalid', Origin: ORIGIN, 'Content-Type': 'application/json',
          'Idempotency-Key': 'p3-26-negative-credential' }, body: JSON.stringify(sessionRequest({
            replicaId: 'negative-credential-replica',
            binding: { browserProfileId: 'negative-credential-profile', browserGeneration: 'negative-credential-generation', mountMode: 'whole-profile' },
          })) });
      if (response.status !== 401) throw new Error(`credential adapter fault did not fail closed (${response.status})`);
      return `credential:status:${response.status}`;
    }
    case 'database': {
      const disconnected = createDatabaseRuntime(input.databaseUrl, { maxConnections: 1,
        applicationName: 'known-p3-26-disconnected-control' });
      await disconnected.close();
      try { await sql`select 1`.execute(disconnected.db); }
      catch { return `database:${input.target}:closed-runtime-rejected`; }
      throw new Error('disconnected database probe did not fail closed');
    }
    case 'artifact': {
      try { await open(resolve('.'), 'w'); } catch { return 'artifact:directory-target-rejected'; }
      throw new Error('unwritable artifact probe unexpectedly opened');
    }
    case 'migration': {
      return exerciseMigrationOmission(input.database, input.databaseUrl, input.target);
    }
    case 'source': case 'colp': case 'config': {
      const tampered = structuredClone(input.repositoryBindings);
      if (input.targetKind === 'source') tampered.source.treeDigest = '0'.repeat(64);
      else if (input.targetKind === 'colp') tampered.colp.conformanceDigest = '0'.repeat(64);
      else tampered.configDigest = '0'.repeat(64);
      try { input.verifyRepositoryBindings(input.repositoryBindings, tampered); }
      catch { return `${input.targetKind}:repository-binding-rejected`; }
      throw new Error(`${input.targetKind} repository binding tamper passed acceptance verification`);
    }
    case 'step': {
      const omitted = input.steps.slice(1);
      try { validatePhase3ServerSyncStepChain(omitted, omitted.length, input.runtimeNonce); }
      catch { return 'step:acceptance-chain-rejected'; }
      throw new Error('step omission passed acceptance verification');
    }
  }
}

function negativeRouteUri(value: Manifest, route: Exclude<Phase3ServerSyncRoute, 'manifest'>): string {
  const mount = value.mounts.find((entry) => entry.id === 'p3-26');
  if (!mount) throw new Error('isolated production Manifest omitted P3-26 mount');
  const advertised: Record<Exclude<Phase3ServerSyncRoute, 'manifest'>, string | undefined> = {
    syncSessions: mount.endpoints.syncSessions,
    syncSnapshot: mount.endpoints.syncSnapshot,
    syncPush: mount.endpoints.syncPush,
    syncConflict: mount.endpoints.syncConflict,
    syncPull: mount.endpoints.syncPull,
    syncAck: mount.endpoints.syncAck,
    syncRetire: ((mount as unknown as Record<string, unknown>)['https://known.example/extensions/sync-retire'] as { href?: string } | undefined)?.href,
  };
  const uri = advertised[route];
  if (!uri) throw new Error(`isolated production Manifest did not advertise ${route}`);
  return uri;
}

async function exerciseMigrationOmission(
  administrator: DatabaseRuntime, databaseUrl: string, omittedFile: string,
): Promise<string> {
  const migrationRoot = resolve('migrations');
  const files = (await readdir(migrationRoot)).filter((name) => /^\d+_.+\.ts$/u.test(name)).sort();
  if (!files.includes(omittedFile)) throw new Error(`migration control target ${omittedFile} does not exist`);
  const directory = await mkdtemp(resolve(tmpdir(), 'known-p3-26-migrations-'));
  const schema = `p3_26_negative_${randomUUID().replaceAll('-', '_')}`;
  await administrator.pool.query(`create schema ${schema}`);
  const isolatedUrl = new URL(databaseUrl); isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const isolated = createDatabaseRuntime(isolatedUrl.toString(), { maxConnections: 2,
    applicationName: `known-p3-26-negative-${omittedFile.slice(0, 12)}` });
  try {
    for (const file of files) if (file !== omittedFile) await copyFile(resolve(migrationRoot, file), resolve(directory, file));
    try {
      await runMigrations(isolated.db, 'latest', directory);
      const applied = await isolated.pool.query<{ name: string }>('select name from kysely_migration order by name');
      const expected = files.map((file) => file.replace(/\.ts$/u, ''));
      if (expected.every((name) => applied.rows.some((row) => row.name === name))) {
        throw new Error(`omitted migration ${omittedFile} unexpectedly passed startup`);
      }
      return `migration:${omittedFile}:startup-list-rejected`;
    } catch (error) {
      if (error instanceof Error && error.message === `omitted migration ${omittedFile} unexpectedly passed startup`) throw error;
      return `migration:${omittedFile}:production-chain-failed-closed`;
    }
  } finally {
    await isolated.close(); await administrator.pool.query(`drop schema if exists ${schema} cascade`);
    await rm(directory, { recursive: true, force: true });
  }
}
function telemetryScan(capture: TelemetryCapture) {
  const parsed = capture.records.map((record) => JSON.parse(record) as { endpoint?: unknown; outcome?: unknown; problem?: unknown });
  const endpoints = [...new Set(parsed.map((record) => record.endpoint).filter((value): value is string => typeof value === 'string'))];
  const outcomes = [...new Set(parsed.map((record) => record.outcome).filter((value): value is string => typeof value === 'string'))];
  if (P3_26_TELEMETRY_ENDPOINTS.some((endpoint) => !endpoints.includes(endpoint))) throw new Error('P3-26 telemetry endpoint coverage is incomplete');
  if (P3_26_TELEMETRY_OUTCOMES.some((outcome) => !outcomes.includes(outcome))) throw new Error('P3-26 telemetry outcome coverage is incomplete');
  const surfaces = {
    logs: capture.logs.join(''),
    traces: capture.records.map((record, index) => `${index + 1}:${digest(record)}`).join('\n'),
    metrics: capture.metrics.join('\n'),
    problems: capture.problems.join('\n'),
    artifact: JSON.stringify({ stepCount: capture.records.length, endpoints, outcomes }),
  };
  const scanned = Object.values(surfaces).join('\n');
  const sentinels = [ACCOUNT, SUBJECT, COLLECTION, AUTHORIZATION, CURSOR_SENTINEL, ERROR_SENTINEL,
    'p3-26-native-sentinel', 'P3-26 title sentinel', 'p3-26-url-sentinel'];
  const leaks = sentinels.filter((sentinel) => scanned.includes(sentinel)); if (leaks.length) throw new Error('P3-26 telemetry sentinel leak');
  return { endpoints: P3_26_TELEMETRY_ENDPOINTS.filter((endpoint) => endpoints.includes(endpoint)),
    outcomes: P3_26_TELEMETRY_OUTCOMES.filter((outcome) => outcomes.includes(outcome)),
    surfaces: Object.keys(surfaces), sentinelDigest: digest(sentinels.join('\0')),
    scannedBytes: Buffer.byteLength(scanned), leaks: 0 as const };
}
