import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  REPLICA_LEASE_BOUNDS,
  canonicalSyncSessionFingerprint,
  classifySyncSessionAuthorityFacts,
  rebuildSyncSessionIssueEnvelope,
  redactSyncSessionIssueError,
  validateSyncSessionIssueInput,
} from '../../../src/modules/sync/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  assertCredentialPreflight,
  validateOptions,
} from '../../../src/infrastructure/sync/postgres/sync-session-admission-postgres.js';

const credential = await mintVerifiedExtensionCredentialFixture({
  issuer: 'https://issuer.example', audience: 'known-api', clientId: 'known-extension',
  subject: 'oidc-subject', credentialId: 'credential-1',
  now: new Date('2026-07-25T10:01:00.000Z'),
});

const validInput = {
  credential,
  idempotencyKey: 'idem-1',
  requestFingerprint: 'sha256-request-1',
  collectionId: 'collection-1',
  replicaId: 'replica-1',
  expectedLeaseGeneration: '1',
  expectedLifecycleRevision: '0',
  binding: {
    browserProfileId: 'profile-1',
    mountMode: 'mounted-folder' as const,
    browserGeneration: 'install-1',
  },
  requestedScopes: ['sync:bootstrap', 'sync:pull', 'sync:push'] as const,
  origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
};

test('P3-38 classifies the closed Session authority matrix without leaking Replica lifecycle state', () => {
  assert.deepEqual(classifySyncSessionAuthorityFacts({ replicaState: 'active', checkpointCursor: null }), {
    kind: 'bootstrap', wireLeaseState: 'active', snapshotRequired: true, scopeCeiling: 'requested',
  });
  assert.deepEqual(classifySyncSessionAuthorityFacts({ replicaState: 'active', checkpointCursor: 'spc2.checkpoint' }), {
    kind: 'active', wireLeaseState: 'active', snapshotRequired: false, scopeCeiling: 'requested',
  });
  assert.deepEqual(classifySyncSessionAuthorityFacts({ replicaState: 'recovery_required', checkpointCursor: 'old' }), {
    kind: 'recovery', wireLeaseState: 'active', snapshotRequired: true, scopeCeiling: 'bootstrap_only',
  });
  for (const replicaState of ['expired', 'retired'] as const) {
    assert.throws(() => classifySyncSessionAuthorityFacts({ replicaState, checkpointCursor: null }),
      /Session authority cannot be issued/);
  }
});

test('P3-07 validates only a P3-01 VerifiedExtensionCredential and closed Session issue shape', () => {
  const result = validateSyncSessionIssueInput(validInput);
  assert.equal(result.credential, credential);
  assert.deepEqual(result.requestedScopes, ['sync:bootstrap', 'sync:pull', 'sync:push']);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.binding));

  for (const candidate of [
    { ...validInput, credential: { authenticated: true } },
    { ...validInput, credential: { ...credential } },
    { ...validInput, credential: { ...credential, kind: 'bearer' } },
    { ...validInput, credential: { ...credential, credentialDigest: '' } },
    { ...validInput, idempotencyKey: '' },
    { ...validInput, expectedLeaseGeneration: '01' },
    { ...validInput, expectedLifecycleRevision: '-1' },
    { ...validInput, requestedScopes: ['sync:pull', 'sync:pull'] },
    { ...validInput, binding: { ...validInput.binding, nativeFolderId: 'native-secret' } },
    { ...validInput, token: 'forbidden' },
    // F025: `collections:create` is not in the issued-scope vocabulary — the
    // backend cannot mint the Session the colp instance-scoped
    // `create_collection` bootstrap lane requires.
    { ...validInput, requestedScopes: ['collections:create'] },
    { ...validInput, requestedScopes: ['sync:push', 'collections:create'] },
    // Instance-scoped sessions are structurally un-issuable: issue input
    // always requires a concrete collectionId.
    { ...validInput, collectionId: '' },
  ]) {
    assert.throws(() => validateSyncSessionIssueInput(candidate), TypeError);
  }
});

test('P3-07 fingerprint binds every authority fence but excludes correlation and raw secrets', () => {
  const first = canonicalSyncSessionFingerprint(validInput);
  assert.equal(first, canonicalSyncSessionFingerprint({ ...validInput }));
  for (const changed of [
    { ...validInput, collectionId: 'collection-2' },
    { ...validInput, replicaId: 'replica-2' },
    { ...validInput, expectedLeaseGeneration: '2' },
    { ...validInput, expectedLifecycleRevision: '1' },
    { ...validInput, requestedScopes: ['sync:pull'] as const },
    { ...validInput, binding: { ...validInput.binding, browserGeneration: 'install-2' } },
  ]) {
    assert.notEqual(canonicalSyncSessionFingerprint(changed), first);
  }
  assert.doesNotMatch(first, /oidc-subject|credential-1|profile-1|install-1/);
});

test('P3-07 denial redaction exposes only stable low-sensitivity codes', () => {
  const problem = redactSyncSessionIssueError({
    code: 'credential_invalid',
    message: 'Bearer secret-token for native folder 431 was rejected',
  });
  assert.deepEqual(problem, { code: 'credential_invalid' });
  assert.doesNotMatch(JSON.stringify(problem), /secret-token|431|Bearer/);
});

test('P3 Better Auth cutover accepts only the closed OAuth and Product-session issuer set', async () => {
  const productIssuer = 'https://known.example';
  const productCredential = await mintVerifiedExtensionCredentialFixture({
    issuer: productIssuer,
    audience: 'known-api',
    clientId: 'known-extension',
    subject: 'product-subject',
    credentialId: 'product-session-1',
    now: new Date('2026-07-25T10:01:00.000Z'),
  });
  const options = validateOptions({
    issuer: 'https://issuer.example',
    acceptedIssuers: ['https://issuer.example', productIssuer],
    audience: 'known-api',
    clientId: 'known-extension',
    replayEncryptionKey: Buffer.alloc(32, 7),
    replayEncryptionKeyVersion: 1,
    sessionDurationSeconds: 900,
    replicaLeaseExtensionSeconds: REPLICA_LEASE_BOUNDS.minSeconds,
    tombstoneRetentionSeconds: 2_592_000,
    maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot', 'syncPull', 'syncAck', 'syncPush', 'syncConflict'],
  });
  assert.doesNotThrow(() => assertCredentialPreflight(credential, options));
  assert.doesNotThrow(() => assertCredentialPreflight(productCredential, options));
  const untrusted = await mintVerifiedExtensionCredentialFixture({
    issuer: 'https://untrusted.example', audience: 'known-api', clientId: 'known-extension',
    subject: 'untrusted-subject', credentialId: 'untrusted-1',
    now: new Date('2026-07-25T10:01:00.000Z'),
  });
  assert.throws(() => assertCredentialPreflight(untrusted, options), /credential_invalid/u);
  assert.throws(() => validateOptions({ ...options,
    acceptedIssuers: [productIssuer] }), /accepted issuers/u);
});

test('P3-07 replay envelope preserves byte-stable identity and rebuilds dynamic authority hints', () => {
  const identity = {
    sessionId: 'session-replay-1',
    expiresAt: '2026-07-25T10:16:00.000Z',
    serverTime: '2026-07-25T10:16:00.000Z',
    acceptedProtocolVersion: '0.2' as const,
    scope: 'collection' as const,
    maxBatchOperations: 1,
    tombstoneRetentionSeconds: 86_400,
    batchBindingSecret: 'batch-binding-secret',
    endpointCapability: 'endpoint-capability',
  };
  const facts = {
    replicaLease: {
      leaseId: 'lease-2', generation: '2', state: 'active' as const,
      lastSeenAt: '2026-07-25T10:20:00.000Z', expiresAt: '2026-07-25T11:20:00.000Z',
      acknowledgedCursor: 'spc2.checkpoint',
    },
    collectionRevision: 'c2',
    collectionCursor: 'spc2.checkpoint',
    snapshotRequired: true,
    conversionPolicy: { alias: 'duplicate' as const, separator: 'native' as const,
      unknownExtensions: 'preserve_remote' as const },
    endpointCapabilities: ['syncSnapshot', 'syncPull'],
  };
  const envelope = rebuildSyncSessionIssueEnvelope(identity, facts);
  assert.deepEqual(envelope, {
    sessionId: identity.sessionId, expiresAt: identity.expiresAt, serverTime: identity.serverTime,
    acceptedProtocolVersion: identity.acceptedProtocolVersion, scope: identity.scope,
    maxBatchOperations: identity.maxBatchOperations,
    tombstoneRetentionSeconds: identity.tombstoneRetentionSeconds,
    replicaLease: facts.replicaLease, collectionRevision: facts.collectionRevision,
    collectionCursor: facts.collectionCursor, snapshotRequired: facts.snapshotRequired,
    conversionPolicy: facts.conversionPolicy, endpointCapabilities: facts.endpointCapabilities,
    batchBindingSecret: identity.batchBindingSecret, endpointCapability: identity.endpointCapability,
  });
  assert.ok(Object.isFrozen(envelope));
  assert.ok(Object.isFrozen(envelope.replicaLease));
  assert.ok(Object.isFrozen(envelope.endpointCapabilities));
  assert.ok(Object.isFrozen(envelope.conversionPolicy));
});

test('FIX-L-036 Replica lease bounds are one frozen range shared by install and renewal', () => {
  assert.deepEqual(REPLICA_LEASE_BOUNDS, { minSeconds: 60, maxSeconds: 2_592_000 });
  assert.ok(Object.isFrozen(REPLICA_LEASE_BOUNDS));
  // First-install registration and renewal/config must accept the same range:
  // the shared maximum (thirty days) lies above the legacy one-day hard limit
  // that used to reject new-device registration with invalid_document.
  assert.equal(REPLICA_LEASE_BOUNDS.maxSeconds, 2_592_000);
  assert.equal(REPLICA_LEASE_BOUNDS.maxSeconds > 86_400, true);
});

test('P3-07 replay envelope keeps identity byte-stable while authority hints track the current facts', () => {
  const identity = {
    sessionId: 'session-replay-1',
    expiresAt: '2026-07-25T10:16:00.000Z',
    serverTime: '2026-07-25T10:16:00.000Z',
    acceptedProtocolVersion: '0.1' as const,
    scope: 'collection' as const,
    maxBatchOperations: 1,
    tombstoneRetentionSeconds: 86_400,
    batchBindingSecret: 'batch-binding-secret',
    endpointCapability: 'endpoint-capability',
  };
  const staleHints = {
    replicaLease: { leaseId: 'lease-1', generation: '1', state: 'active' as const,
      lastSeenAt: '2026-07-25T10:16:00.000Z', expiresAt: '2026-07-25T11:16:00.000Z',
      acknowledgedCursor: null },
    collectionRevision: 'c1', collectionCursor: 'bootstrap-session-replay-1', snapshotRequired: false,
    conversionPolicy: { alias: 'skip' as const, separator: 'preserve_remote' as const,
      unknownExtensions: 'preserve_remote' as const },
    endpointCapabilities: ['syncSnapshot', 'syncPull', 'syncPush'],
  };
  const currentHints = {
    replicaLease: { leaseId: 'lease-2', generation: '2', state: 'active' as const,
      lastSeenAt: '2026-07-25T10:30:00.000Z', expiresAt: '2026-07-25T11:30:00.000Z',
      acknowledgedCursor: 'spc2.checkpoint' },
    collectionRevision: 'c2', collectionCursor: 'spc2.checkpoint', snapshotRequired: true,
    conversionPolicy: { alias: 'duplicate' as const, separator: 'native' as const,
      unknownExtensions: 'preserve_remote' as const },
    endpointCapabilities: ['syncSnapshot'],
  };
  const stale = rebuildSyncSessionIssueEnvelope(identity, staleHints);
  const current = rebuildSyncSessionIssueEnvelope(identity, currentHints);
  for (const field of ['sessionId', 'expiresAt', 'serverTime', 'acceptedProtocolVersion', 'scope',
    'maxBatchOperations', 'tombstoneRetentionSeconds', 'batchBindingSecret',
    'endpointCapability'] as const) {
    assert.equal(current[field], stale[field], field);
  }
  assert.equal(current.snapshotRequired, true);
  assert.equal(current.collectionRevision, 'c2');
  assert.equal(current.collectionCursor, 'spc2.checkpoint');
  assert.deepEqual(current.replicaLease, currentHints.replicaLease);
  assert.deepEqual(current.endpointCapabilities, ['syncSnapshot']);
  assert.deepEqual(current.conversionPolicy, currentHints.conversionPolicy);
});
