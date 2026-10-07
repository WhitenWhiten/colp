/**
 * Shared helpers for the P4A-I12 focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides:
 * - deterministic private-blob identity fixtures whose physical generation key
 *   contains a UNIQUE MARKER (so the marker exists in real rows + body bytes);
 *   the SAME marker also rides the non-sensitive metadata fields a shared
 *   projection could leak (blobId, Attachment binding identity, verified
 *   mediaType), so a metadata-level leak is caught by the marker scan,
 * - a real production seed path to `stored_private` (allocate -> complete CAS
 *   -> verification claim/complete) and to `attached_private` (the PRODUCTION
 *   finalize handoff port) plus fixture state variants
 *   (`expired`, retired generation, `quarantined`) used to
 *   prove every shared consumer still serves a visible CONTROL resource while
 *   the private marker appears NOWHERE,
 * - a public control collection + control node seed that every consumer must
 *   serve normally (anti-false-positive: empty results never count),
 * - a profile seed for the Profile/Manifest consumer, and a sync session seed
 *   (account + replica + issued session) for Sync bootstrap/pull.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createUnitOfWork } from '../../src/infrastructure/database/index.js';
import { createPostgresAttachmentsPorts } from '../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncSessionIssuer,
} from '../../src/infrastructure/sync/index.js';
import type { VerifiedExtensionCredential } from '../../src/modules/identity/index.js';
import type { AllocateGenerationInput } from '../../src/modules/attachments/index.js';
import { mintVerifiedExtensionCredentialFixture } from './extension-credential.js';
import {
  identityFor,
  sha256Hex,
  uuidFor,
  type I07MigrationRuntime,
} from './phase4a-i07-test-helpers.js';

export const I12_SUBJECT_OWNER = 'i12-subject-owner';
export const I12_PRINCIPAL_OWNER = 'i12-principal-owner';
export const I12_COLLECTION = 'i12-control-collection';
export const I12_BUCKET = 'i12-production-bucket';
export const I12_LIVE_PREFIX = 'attachments/live/';
export const I12_ISSUER = 'https://issuer.example';
export const I12_SYNC_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const ports = createPostgresAttachmentsPorts();

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Unique marker embedded ONLY in the private blob rows/bytes: the physical
 * generation key, the blob identity, the Attachment binding identity and the
 * verified media type all carry it (never legitimately in any shared
 * projection), so a metadata-level leak is caught by the marker scan.
 */
export function privateMarker(prefix = 'i12-private'): string {
  return `${prefix}-${randomUUID()}`;
}

/** Unique marker embedded in the visible control resource every consumer must serve. */
export function controlMarker(prefix = 'i12-control'): string {
  return `${prefix}-${randomUUID()}`;
}

export function assertMarkerAbsentFromJson(value: unknown, marker: string, label: string): void {
  const serialized = JSON.stringify(value);
  assert.ok(serialized !== undefined, `${label} must be JSON-serializable`);
  assert.equal(serialized.includes(marker), false, `${label} must never contain private marker ${marker}`);
}

export function assertControlVisible(value: unknown, controlMarkerValue: string, label: string): void {
  const serialized = JSON.stringify(value);
  assert.ok(serialized !== undefined, `${label} must be JSON-serializable`);
  assert.equal(serialized.includes(controlMarkerValue), true, `${label} must serve the visible control resource (${controlMarkerValue})`);
}

// ---------------------------------------------------------------------------
// Private blob identity + production seed
// ---------------------------------------------------------------------------

export interface I12BlobIdentity {
  readonly blobId: string;
  readonly intentId: string;
  readonly generationId: string;
  readonly key: string;
  readonly fingerprint: string;
  /** Marker-bearing verified media type (blob row, intent and observed content type). */
  readonly mediaType: string;
  /** Marker-bearing future Attachment binding identity (finalize handoff). */
  readonly bindingId: string;
}

/**
 * Identity whose physical key embeds `marker` so the marker exists in real
 * rows; the SAME marker also rides the non-sensitive metadata fields a shared
 * projection could leak (`blobId`, Attachment `bindingId`, verified
 * `mediaType`), so a metadata-level leak is caught by the marker scan.
 */
export function i12BlobIdentity(slot: number, marker: string): I12BlobIdentity {
  const blobId = `i12-blob-${marker}-${uuidFor(1100 + slot)}`;
  const intentId = uuidFor(2100 + slot);
  const generationId = uuidFor(3100 + slot);
  const key = `${I12_LIVE_PREFIX}${marker}-${uuidFor(4100 + slot)}`;
  return {
    blobId, intentId, generationId, key, fingerprint: sha256Hex(key),
    mediaType: `application/octet-stream; fixture=${marker}`,
    bindingId: `i12-binding-${marker}-${uuidFor(5100 + slot)}`,
  };
}

export function i12AllocateInput(
  id: I12BlobIdentity,
  overrides: Partial<AllocateGenerationInput> = {},
): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: I12_PRINCIPAL_OWNER,
    collectionId: I12_COLLECTION,
    subjectIdentity: I12_SUBJECT_OWNER,
    bucket: I12_BUCKET,
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: 16,
    expectedSha256: 'a'.repeat(64),
    mediaHint: id.mediaType,
    policyRevision: 'policy-r1',
    idempotencyKey: `idem-${id.intentId}`,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function sha256HexBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface SeedPrivateBlobOptions {
  readonly collectionId?: string;
  readonly ownerSubjectId?: string;
  readonly principalId?: string;
  readonly body?: Uint8Array;
}

/** Drives the PRODUCTION ledger to `stored_private` with an active generation whose key carries the marker. */
export async function seedStoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: I12BlobIdentity,
  options: SeedPrivateBlobOptions = {},
): Promise<void> {
  const collectionId = options.collectionId ?? I12_COLLECTION;
  const ownerSubjectId = options.ownerSubjectId ?? I12_SUBJECT_OWNER;
  const principalId = options.principalId ?? I12_PRINCIPAL_OWNER;
  const body = options.body ?? new TextEncoder().encode(id.key);
  const digest = sha256HexBytes(body);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, i12AllocateInput(id, {
      collectionId,
      subjectIdentity: ownerSubjectId,
      principalId,
      expectedSize: body.byteLength,
      expectedSha256: digest,
      mediaHint: id.mediaType,
    }));
    assert.equal(allocated.outcome, 'issued');
    const cas = await ports.completeUploadCas(transaction, {
      intentId: id.intentId,
      generationId: id.generationId,
      blobId: id.blobId,
      actorPrincipalId: principalId,
      declaredSize: body.byteLength,
      declaredSha256: digest,
      declaredMediaType: id.mediaType,
      observedEtag: `"etag-${id.generationId}"`,
      observedSize: body.byteLength,
      observedContentType: id.mediaType,
      observedMetadata: {},
    });
    assert.equal(cas.outcome, 'uploaded');
  });
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const attempt = { outboxId: `outbox-${id.generationId}`, leaseGeneration: '1' };
    const domainEventId = randomUUID();
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${attempt.outboxId}, 'outbox'), (${domainEventId}, 'outbox')
    `.execute(transaction);
    await sql`
      insert into outbox_events
        (outbox_id, domain_event_id, event_type, event_version, handler_name, handler_mode,
         aggregate_type, aggregate_id, aggregate_scope, occurred_at, payload_json, state,
         attempt_count, available_at, locked_until, lease_generation)
      values (${attempt.outboxId}, ${domainEventId}, 'attachments.upload-verified', 1,
         'attachments_verify_generation', 'delivery_each_event', 'blob', ${id.blobId},
         ${id.generationId}, now(), '{}'::jsonb, 'leased', 1, now(), now() + interval '1 hour', 1)
    `.execute(transaction);
    const claimed = await ports.claimVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed');
    const completed = await ports.completeVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      verifiedSize: body.byteLength,
      verifiedSha256: digest,
      mediaType: id.mediaType,
      policyVersion: 'i12-policy-v1',
    });
    assert.equal(completed.outcome, 'stored_private');
  });
}

/**
 * Fixture variant: `stored_private -> attached_private` through the PRODUCTION
 * finalize handoff port (`finalizeHandoff`, transaction-bound — the same port
 * the I13/P02 canonical finalize assembly drives). The handoff writes the
 * unique future Attachment binding facts (id/etag/generation/policy) in the
 * SAME transaction, so the committed terminal row satisfies every I13
 * `blob_records_attached_binding_*` CHECK constraint without any test SQL; the
 * marker still lives only in the private blob rows/bytes (blobId, binding id,
 * mediaType, key) and must never reach a shared projection.
 */
export async function seedAttachedPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: I12BlobIdentity,
  options: SeedPrivateBlobOptions = {},
): Promise<void> {
  await seedStoredPrivate(runtime, id, options);
  const body = options.body ?? new TextEncoder().encode(id.key);
  const digest = sha256HexBytes(body);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const handoff = await ports.finalizeHandoff(transaction, {
      blobId: id.blobId,
      attachmentBindingId: id.bindingId,
      expectedGenerationId: id.generationId,
      ownerSubjectId: options.ownerSubjectId ?? I12_SUBJECT_OWNER,
      expectedEtag: `"etag-${id.generationId}"`,
      verifiedSize: body.byteLength,
      verifiedSha256: digest,
      mediaType: id.mediaType,
      policyRevision: 'i12-policy-v1',
    });
    assert.equal(handoff.outcome, 'attached', `finalize handoff must commit for ${id.blobId}`);
  });
}

/** Fixture variant: `stored_private -> expired` (legal state-machine transition). */
export async function seedExpiredBlob(
  runtime: I07MigrationRuntime['runtime'],
  id: I12BlobIdentity,
  options: SeedPrivateBlobOptions = {},
): Promise<void> {
  await seedStoredPrivate(runtime, id, options);
  await runtime.pool.query(
    `update blob_records set logical_state='expired', updated_at=now() where blob_id=$1`,
    [id.blobId],
  );
}

/** Fixture variant: a RETIRED generation for the same blob (replacement CAS). */
export async function seedRetiredGeneration(
  runtime: I07MigrationRuntime['runtime'],
  original: I12BlobIdentity,
  replacement: I12BlobIdentity,
  options: SeedPrivateBlobOptions = {},
): Promise<void> {
  await seedStoredPrivate(runtime, original, options);
  const replacementBody = options.body ?? new TextEncoder().encode(replacement.key);
  const digest = sha256HexBytes(replacementBody);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, i12AllocateInput(replacement, {
      blobId: original.blobId,
      collectionId: options.collectionId ?? I12_COLLECTION,
      subjectIdentity: options.ownerSubjectId ?? I12_SUBJECT_OWNER,
      principalId: options.principalId ?? I12_PRINCIPAL_OWNER,
      expectedSize: replacementBody.byteLength,
      expectedSha256: digest,
      mediaHint: replacement.mediaType,
    }));
    assert.equal(allocated.outcome, 'issued');
    // The replacement generation is completed to 'observed' through the
    // production complete port (activateReplacement later CASes it to active
    // and retires gen1), mirroring the I10 replacement seed.
    const cas = await ports.complete(transaction, {
      intentId: replacement.intentId,
      generationId: replacement.generationId,
      blobId: original.blobId,
      observedEtag: `"etag-${replacement.generationId}"`,
      observedSize: replacementBody.byteLength,
      observedContentType: replacement.mediaType,
      observedMetadata: {},
    });
    assert.equal(cas.outcome, 'verified_observed');
    const activated = await ports.activateReplacement(transaction, {
      blobId: original.blobId,
      expectedActiveGenerationId: original.generationId,
      newGenerationId: replacement.generationId,
    });
    assert.equal(activated.outcome, 'activated');
  });
}

/** Fixture variant: generation quarantined (contract corruption -> quarantined facts). */
export async function seedQuarantinedGeneration(
  runtime: I07MigrationRuntime['runtime'],
  id: I12BlobIdentity,
  options: SeedPrivateBlobOptions = {},
): Promise<void> {
  await seedStoredPrivate(runtime, id, options);
  await runtime.pool.query(
    `update blob_generations
        set generation_state='quarantined', quarantined_at=now(), quarantined_reason='i12-contract-corruption-fixture'
      where generation_id=$1`,
    [id.generationId],
  );
}

// ---------------------------------------------------------------------------
// Control collection + control node
// ---------------------------------------------------------------------------

export interface SeedControlCollectionOptions {
  readonly collectionId?: string;
  readonly ownerSubjectId?: string;
  readonly visibility?: 'private' | 'protected' | 'public' | 'unlisted';
  readonly title?: string;
  readonly publicationSlug?: string;
  readonly allowSearchIndexing?: boolean;
  /** Title of the visible control node each consumer must serve. */
  readonly controlNodeTitle?: string;
  readonly nodeUrl?: string;
}

export async function seedControlCollection(
  runtime: I07MigrationRuntime['runtime'],
  options: SeedControlCollectionOptions = {},
): Promise<{ readonly collectionId: string; readonly rootId: string; readonly nodeId: string; readonly controlNodeTitle: string }> {
  const collectionId = options.collectionId ?? I12_COLLECTION;
  const rootId = `${collectionId}-root`;
  const nodeId = `${collectionId}-control-node`;
  const controlNodeTitle = options.controlNodeTitle ?? controlMarker();
  const visibility = options.visibility ?? 'public';
  const published = visibility === 'public' || visibility === 'unlisted';
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql`
      insert into resource_id_ledger (resource_id, resource_type)
      values (${collectionId}, 'collection'), (${rootId}, 'node'), (${nodeId}, 'node')
    `.execute(transaction);
    await sql`
      insert into collections
        (id, owner_subject_id, title, summary, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, publication_slug,
         published_at, allow_search_indexing, created_at, updated_at)
      values (${collectionId}, ${options.ownerSubjectId ?? I12_SUBJECT_OWNER}, ${options.title ?? 'I12 control collection'},
         'i12 control summary', 'bookmarks', ${visibility}, ${rootId},
         'r1', 'c1', 'p1', ${options.publicationSlug ?? (published ? collectionId : null)},
         ${published ? sql`now()` : sql`null`}, ${options.allowSearchIndexing ?? true}, now(), now())
    `.execute(transaction);
    await sql`
      insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision, created_at, updated_at)
      values (${rootId}, ${collectionId}, null, 'folder', true, 'Root', null, null, '[]'::jsonb,
         'inherit', null, 'r1', 'ch1', now(), now())
    `.execute(transaction);
    await sql`
      insert into nodes
        (id, collection_id, parent_id, kind, is_root, title, url, description, tags,
         visibility, position_token, resource_revision, children_revision, created_at, updated_at)
      values (${nodeId}, ${collectionId}, ${rootId}, 'bookmark', false, ${controlNodeTitle},
         ${options.nodeUrl ?? 'https://control.example.test/i12'}, 'i12 control node description', '[]'::jsonb,
         'inherit', 'A', 'r1', 'ch1', now(), now())
    `.execute(transaction);
  });
  return { collectionId, rootId, nodeId, controlNodeTitle };
}

// ---------------------------------------------------------------------------
// Profile seed (Profile/Manifest consumer)
// ---------------------------------------------------------------------------

export interface SeedProfileOptions {
  readonly subjectId?: string;
  readonly accountId?: string;
  readonly handle?: string;
  readonly displayName?: string;
  readonly oidcSubject?: string;
}

/**
 * A 22-char ULID-shaped account id (21 chars + A/Q/g/w checksum char) that the
 * production public-profile facts mapper accepts.
 */
export function i12AccountId(): string {
  const chars = `i12${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  return `${chars}${'AQgw'[chars.length % 4]!}`;
}

export async function seedProfile(
  runtime: I07MigrationRuntime['runtime'],
  options: SeedProfileOptions = {},
): Promise<{ readonly subjectId: string; readonly handle: string }> {
  const subjectId = options.subjectId ?? I12_SUBJECT_OWNER;
  const accountId = options.accountId ?? i12AccountId();
  const handle = options.handle ?? 'i12_owner';
  const displayName = options.displayName ?? 'I12 Owner';
  const oidcSubject = options.oidcSubject ?? 'i12-oidc-subject';
  await runtime.pool.query('begin');
  try {
    await runtime.pool.query(
      `insert into accounts (id, subject_id, status) values ($1, $2, 'active')
         on conflict (id) do nothing`,
      [accountId, subjectId],
    );
    await runtime.pool.query(
      `insert into profiles (account_id, display_name) values ($1, $2)
         on conflict (account_id) do nothing`,
      [accountId, displayName],
    );
    await runtime.pool.query(
      `insert into profile_handles (handle, account_id) values ($1, $2)
         on conflict (handle) do nothing`,
      [handle, accountId],
    );
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)
         on conflict (id) do nothing`,
      [`i12-identity-${accountId}`, accountId, I12_ISSUER, oidcSubject],
    );
    await runtime.pool.query('commit');
  } catch (error) {
    await runtime.pool.query('rollback');
    throw error;
  }
  return { subjectId, handle };
}

// ---------------------------------------------------------------------------
// Sync session seed (Sync bootstrap/pull consumers)
// ---------------------------------------------------------------------------

export interface I12SyncSession {
  readonly credential: VerifiedExtensionCredential;
  readonly replicaId: string;
  readonly sessionId: string;
  readonly collectionId: string;
}

export async function seedSyncSession(
  runtime: I07MigrationRuntime['runtime'],
  options: { readonly collectionId?: string; readonly suffix?: string; readonly scopes?: readonly ('sync:bootstrap' | 'sync:pull' | 'sync:push')[] } = {},
): Promise<I12SyncSession> {
  const suffix = options.suffix ?? randomUUID();
  const collectionId = options.collectionId ?? I12_COLLECTION;
  // The sync account owns the control collection (owner subject
  // I12_SUBJECT_OWNER) so the session issuer resolves role=owner. One fixed
  // account + one account_identity is shared by every session in the suite;
  // each session still gets its own credential/replica/session ids.
  const accountId = 'i12-sync-account';
  const subjectId = I12_SUBJECT_OWNER;
  const oidcSubject = 'i12-sync-oidc';
  await runtime.pool.query('begin');
  try {
    await runtime.pool.query(
      `insert into accounts (id, subject_id, status) values ($1, $2, 'active')
         on conflict (id) do nothing`,
      [accountId, subjectId],
    );
    await runtime.pool.query(
      `insert into profile_handles (handle, account_id) values ($1, $2)
         on conflict (handle) do nothing`,
      [`i12_sync`, accountId],
    );
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)
         on conflict (id) do nothing`,
      [`i12-sync-identity`, accountId, I12_ISSUER, oidcSubject],
    );
    await runtime.pool.query('commit');
  } catch (error) {
    await runtime.pool.query('rollback');
    throw error;
  }
  const credential = await mintVerifiedExtensionCredentialFixture({
    issuer: I12_ISSUER, audience: 'known-api', clientId: 'known-extension',
    subject: oidcSubject, credentialId: `i12-credential-${suffix}`,
  });
  const replica = await createPostgresReplicaStore(runtime.db, { ids: {
    deviceId: () => `i12-device-${suffix}`, replicaId: () => `i12-replica-${suffix}`,
    leaseId: () => `i12-lease-${suffix}`,
  } }).create({
    accountId, collectionId, deviceName: 'I12 device', replicaName: 'I12 replica',
    kind: 'browser_extension',
    adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
    capabilities: { read: true, write: true, events: true, separator: true, alias: false,
      annotations: 'sidecar', maxBatchOperations: 1 },
    binding: { browserProfileId: `i12-profile-${suffix}`, mountMode: 'whole-profile',
      browserGeneration: `i12-generation-${suffix}` },
    leaseDurationSeconds: 3_600,
  }, { actorAccountId: accountId });
  const issuer = createPostgresSyncSessionIssuer(runtime.db, {
    issuer: I12_ISSUER, audience: 'known-api', clientId: 'known-extension',
    replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
    sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
    tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
    endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    retentionWindow: {
      async load(_transaction, collectionIdForWindow) {
        return { collectionId: collectionIdForWindow,
          earliestPull: { cursor: null, commitOrdinal: '0' },
          purgedThrough: { cursor: null, commitOrdinal: '0' },
          snapshotUrl: '/private-entry/snapshot-download' };
      },
    },
  });
  const issued = await issuer.issue({
    credential, idempotencyKey: `i12-session-${suffix}`, requestFingerprint: `i12-session-fp-${suffix}`,
    collectionId, replicaId: replica.replicaId,
    expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
    binding: replica.binding, requestedScopes: [...(options.scopes ?? ['sync:bootstrap', 'sync:pull'])],
    origin: I12_SYNC_ORIGIN,
  });
  return {
    credential, replicaId: replica.replicaId, sessionId: issued.session.sessionId, collectionId,
  };
}

export { identityFor, uuidFor, sha256Hex };
