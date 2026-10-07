/**
 * P4A-P07 shared helpers for the focused suites (not a vitest test file).
 *
 * Provides the P07 fixture constants, the REAL mutation-gate headers (session
 * cookie + Origin + CSRF + Known-Command-Id), the production HTTP flow
 * helpers (issue -> INDEPENDENT fetch PUT on the real presigned grant ->
 * complete -> production claim/completeVerification convergence), the
 * replacement/retire/status/finalize route wrappers and deterministic DB
 * re-reads for the replacement/retirement/cleanup assertions. Old/new R2
 * markers are REAL bytes with REAL etags, never test doubles.
 *
 * Every WRITE path goes through production routes or production ports; no
 * test writes the target `attachments`/`blob_generations`/`blob_records`
 * state directly (negative controls only corrupt the precondition facts the
 * commands must reject, or advance the DATABASE clock for retention).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { createPostgresAttachmentsPorts, createUnitOfWork, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  type AttachmentsFeatureConfig,
  type CleanupFaultInjector,
  type GenerationObjectStorePort,
} from '../../src/modules/attachments/index.js';
import { seedP06Collection } from './phase4a-p06-test-helpers.js';
import { P03_BUCKET, makeP03Config } from './phase4a-p03-test-helpers.js';
import type { AuthenticatedTestClient } from './product-http-harness.js';
import type { I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export const P07_ORIGIN = 'https://app.known.example';
export const P07_ISSUER = 'https://issuer.example';
export const P07_COLLECTION_A = 'p07-collection-a';
export const P07_COLLECTION_B = 'p07-collection-b';
export const P07_COLLECTION_OTHER = 'p07-collection-other-owner';
export const P07_MEDIA_TYPE = 'image/png';
export const P07_POLICY_VERSION = 'p07-policy-v1';

/** The actor facts the blob ledger binds (session subject + account id). */
export interface P07BlobOwner {
  readonly subjectId: string;
  readonly principalId: string;
}

export function p07BlobOwnerOf(client: AuthenticatedTestClient): P07BlobOwner {
  return { subjectId: client.subjectId, principalId: client.accountId };
}

export function p07Headers(client: AuthenticatedTestClient, commandId: string): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: P07_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
  };
}

export function p07Digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stable distinct body marker per slot (old/new must differ in SIZE). */
export function p07Body(slot: number): Uint8Array {
  return new TextEncoder().encode(`p07-body-${slot}-${'m'.repeat(64 + slot)}`);
}

export const P07_CONFIG: AttachmentsFeatureConfig = makeP03Config();

/** Cleanup config: retired retention 90 days (fresh retirement never claimable). */
export const P07_CLEANUP_CONFIG: AttachmentsFeatureConfig = makeP03Config({
  retention: { intentRetentionHours: 1, storedRetentionDays: 1, retiredRetentionDays: 90 },
});

export async function p07SeedCollection(
  runtime: I07MigrationRuntime['runtime'],
  options: {
    readonly collectionId: string;
    readonly ownerSubjectId: string;
    readonly members?: ReadonlyArray<{ readonly subjectId: string; readonly role: 'owner' | 'editor' | 'viewer' }>;
  },
): Promise<void> {
  await seedP06Collection(runtime, options);
}

// ---------------------------------------------------------------------------
// Production HTTP flow helpers
// ---------------------------------------------------------------------------

export interface P07UploadedGeneration {
  readonly blobId: string;
  readonly intentId: string;
  readonly generationId: string;
  /** The REAL physical key extracted from the presigned grant URL path. */
  readonly key: string;
  readonly etag: string;
  readonly body: Uint8Array;
  readonly digest: string;
}

export interface P07IssueResponse {
  readonly statusCode: number;
  readonly kind: string;
  readonly receipt: { blobId: string; intentId: string; generationId: string };
  readonly grant: {
    url: string;
    method: string;
    contentType: string;
    contentLength: number;
    expiresAt: string;
    ttlSeconds: number;
  };
}

/** The physical key from a presigned grant URL path (`/<bucket>/<key>`). */
export function p07KeyFromGrantUrl(grantUrl: string): string {
  const pathname = new URL(grantUrl).pathname;
  const prefix = `/${P03_BUCKET}/`;
  assert.ok(pathname.startsWith(prefix), 'grant URL must carry the bucket path');
  return pathname.slice(prefix.length);
}

export async function p07Issue(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  collectionId: string,
  body: Uint8Array,
  commandId: string,
  mediaType: string = P07_MEDIA_TYPE,
): Promise<P07IssueResponse> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/attachments/issue',
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      collectionId,
      declaredSize: body.byteLength,
      declaredSha256: p07Digest(body),
      mediaHint: mediaType,
      expectedPolicyRevision: null,
    }),
  });
  assert.equal(response.statusCode, 201, `issue failed: ${response.statusCode} ${response.body}`);
  return response.json() as P07IssueResponse;
}

/** Independent HTTP client executes the real presigned create-only PUT. */
export async function p07Put(grantUrl: string, body: Uint8Array): Promise<{ status: number; etag: string }> {
  const putResponse = await fetch(grantUrl, {
    method: 'PUT',
    headers: { 'If-None-Match': '*', 'Content-Type': 'application/octet-stream' },
    body: body as unknown as BodyInit,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(putResponse.status === 200 || putResponse.status === 201,
    `independent PUT failed: ${putResponse.status}`);
  const etag = putResponse.headers.get('etag');
  assert.ok(etag, 'PUT response must carry an ETag');
  return { status: putResponse.status, etag };
}

/** POST /api/v1/attachments/complete through the production route. */
export async function p07Complete(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  binding: { blobId: string; intentId: string; generationId: string },
  body: Uint8Array,
  etag: string,
  commandId: string,
  mediaType: string = P07_MEDIA_TYPE,
): Promise<{ statusCode: number; body: string }> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/attachments/complete',
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      binding,
      declared: { size: body.byteLength, sha256: p07Digest(body), mediaType, etag },
    }),
  });
}

/** Claims the verification outbox row like the production worker and drives
 * the PRODUCTION claim/completeVerification ports to stored_private. */
export async function p07VerifyToStored(
  runtime: I07MigrationRuntime['runtime'],
  blobId: string,
  generationId: string,
  body: Uint8Array,
  mediaType: string = P07_MEDIA_TYPE,
): Promise<void> {
  const rows = await sql<{ outbox_id: string }>`
    select outbox_id from outbox_events
    where handler_name = 'attachments_verify_generation'
      and aggregate_id = ${blobId}
      and aggregate_scope = ${generationId}
      and state = 'pending'
  `.execute(runtime.db);
  assert.equal(rows.rows.length, 1, `exactly one verification outbox row for ${generationId}`);
  const outboxId = rows.rows[0]!.outbox_id;
  await sql`
    update outbox_events
    set state = 'leased', lease_generation = 1, attempt_count = 1, locked_until = now() + interval '1 hour'
    where outbox_id = ${outboxId} and state = 'pending'
  `.execute(runtime.db);
  const attempt = { outboxId, leaseGeneration: '1' };
  const ports = createPostgresAttachmentsPorts();
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const claimed = await ports.claimVerification(transaction, {
      blobId,
      generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed', `verification claim failed for ${generationId}`);
    const completed = await ports.completeVerification(transaction, {
      blobId,
      generationId,
      attempt,
      verifiedSize: body.byteLength,
      verifiedSha256: p07Digest(body),
      mediaType,
      policyVersion: P07_POLICY_VERSION,
    });
    assert.equal(completed.outcome, 'stored_private', `verification CAS failed for ${generationId}`);
  });
}

/** Full production upload: issue route -> independent PUT -> complete -> verification. */
export async function p07UploadToStored(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  runtime: I07MigrationRuntime['runtime'],
  options: {
    readonly collectionId: string;
    readonly body: Uint8Array;
    readonly commandId?: string;
    /** Media declaration (issue mediaHint + complete declared + verified
     * media fact). Defaults to P07_MEDIA_TYPE; suites whose bytes do not
     * match a SAFE allowlisted type MUST declare text/plain (the unique
     * allowed-media member outside the verification SAFE allowlist) so the
     * fixture never makes a false cleanliness claim while the product flow
     * still accepts the declaration. */
    readonly mediaType?: string;
  },
): Promise<P07UploadedGeneration> {
  const mediaType = options.mediaType ?? P07_MEDIA_TYPE;
  const issueCommandId = options.commandId ?? randomUUID();
  const issued = await p07Issue(app, client, options.collectionId, options.body, issueCommandId, mediaType);
  const key = p07KeyFromGrantUrl(issued.grant.url);
  const { etag } = await p07Put(issued.grant.url, options.body);
  const completeCommandId = randomUUID();
  const complete = await p07Complete(app, client, issued.receipt, options.body, etag, completeCommandId, mediaType);
  assert.equal(complete.statusCode, 200, `complete failed: ${complete.statusCode} ${complete.body}`);
  const completed = JSON.parse(complete.body) as { kind: string; receipt: { intentId: string; generationId: string } };
  assert.equal(completed.kind, 'completed', 'first upload must complete');
  await p07VerifyToStored(runtime, issued.receipt.blobId, issued.receipt.generationId, options.body, mediaType);
  return {
    blobId: issued.receipt.blobId,
    intentId: issued.receipt.intentId,
    generationId: issued.receipt.generationId,
    key,
    etag,
    body: options.body,
    digest: p07Digest(options.body),
  };
}

/** POST /api/v1/attachments/{blobId}/replacement through the production route. */
export async function p07Replacement(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  blobId: string,
  options: {
    readonly body: Uint8Array;
    readonly commandId?: string;
    readonly mediaHint?: string | null;
    readonly declaredSha256?: string | null;
  },
): Promise<P07IssueResponse & { statusCode: number; body: string }> {
  const commandId = options.commandId ?? randomUUID();
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/attachments/${encodeURIComponent(blobId)}/replacement`,
    headers: p07Headers(client, commandId),
    payload: JSON.stringify({
      declaredSize: options.body.byteLength,
      declaredSha256: options.declaredSha256 ?? p07Digest(options.body),
      mediaHint: options.mediaHint ?? P07_MEDIA_TYPE,
      expectedPolicyRevision: null,
    }),
  });
  if (response.statusCode !== 201) {
    return {
      statusCode: response.statusCode,
      body: response.body,
      kind: '',
      receipt: { blobId: '', intentId: '', generationId: '' },
      grant: { url: '', method: '', contentType: '', contentLength: 0, expiresAt: '', ttlSeconds: 0 },
    };
  }
  return { ...(response.json() as P07IssueResponse), statusCode: 201, body: response.body };
}

/** Replacement issue + PUT + complete + verification (the complete route CAS-activates atomically). */
export async function p07ReplaceAndVerify(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  runtime: I07MigrationRuntime['runtime'],
  blobId: string,
  newBody: Uint8Array,
  mediaType: string = P07_MEDIA_TYPE,
): Promise<P07UploadedGeneration> {
  const issued = await p07Replacement(app, client, blobId, { body: newBody, mediaHint: mediaType });
  assert.equal(issued.statusCode, 201, `replacement failed: ${issued.statusCode}`);
  assert.equal(issued.receipt.blobId, blobId);
  const key = p07KeyFromGrantUrl(issued.grant.url);
  const { etag } = await p07Put(issued.grant.url, newBody);
  const complete = await p07Complete(app, client, issued.receipt, newBody, etag, randomUUID(), mediaType);
  assert.equal(complete.statusCode, 200, `replacement complete failed: ${complete.statusCode} ${complete.body}`);
  const completed = JSON.parse(complete.body) as { kind: string };
  assert.ok(completed.kind === 'completed' || completed.kind === 'idempotent', `unexpected complete kind ${completed.kind}`);
  await p07VerifyToStored(runtime, blobId, issued.receipt.generationId, newBody, mediaType);
  return {
    blobId,
    intentId: issued.receipt.intentId,
    generationId: issued.receipt.generationId,
    key,
    etag,
    body: newBody,
    digest: p07Digest(newBody),
  };
}

/** GET /api/v1/attachments/{blobId} through the production route. */
export async function p07Status(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  blobId: string,
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  return app.inject({
    method: 'GET',
    url: `/api/v1/attachments/${encodeURIComponent(blobId)}`,
    headers: { cookie: client.cookie },
  });
}

/** POST /api/v1/attachments/{blobId}/finalize through the production route. */
export async function p07Finalize(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  blobId: string,
  commandId: string,
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/attachments/${encodeURIComponent(blobId)}/finalize`,
    headers: p07Headers(client, commandId),
    payload: '{}',
  });
}

/** POST /api/v1/attachments/{blobId}/retire through the production route. */
export async function p07Retire(
  app: FastifyInstance,
  client: AuthenticatedTestClient,
  blobId: string,
  commandId: string,
): Promise<{ statusCode: number; headers: Record<string, unknown>; body: string }> {
  return app.inject({
    method: 'POST',
    url: `/api/v1/attachments/${encodeURIComponent(blobId)}/retire`,
    headers: p07Headers(client, commandId),
    payload: '{}',
  });
}

// Deterministic DB re-reads (assertions only)

export interface P07GenerationRow {
  readonly generationId: string; readonly blobId: string; readonly key: string;
  readonly generationState: string; readonly retireReason: string | null;
  readonly retiredAt: Date | null; readonly orphanedAt: Date | null;
  readonly deletedAt: Date | null; readonly confirmedAbsentAt: Date | null;
  readonly quarantinedAt: Date | null; readonly observedEtag: string | null;
  readonly observedSize: number | null;
}

interface P07GenerationSqlRow {
  generation_id: string; blob_id: string; key: string; generation_state: string;
  retire_reason: string | null; retired_at: Date | null; orphaned_at: Date | null;
  deleted_at: Date | null; confirmed_absent_at: Date | null; quarantined_at: Date | null;
  observed_etag: string | null; observed_size: string | null;
}

export async function readP07Generation(
  runtime: DatabaseRuntime,
  generationId: string,
): Promise<P07GenerationRow | null> {
  const rows = await sql<P07GenerationSqlRow>`
    select bg.generation_id, bg.blob_id, bg.key, bg.generation_state, bg.retire_reason,
           bg.retired_at, bg.orphaned_at, bg.deleted_at, bg.confirmed_absent_at, bg.quarantined_at,
           bg.observed_etag, bg.observed_size::text
    from blob_generations bg where bg.generation_id = ${generationId}
  `.execute(runtime.db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    generationId: row.generation_id,
    blobId: row.blob_id,
    key: row.key,
    generationState: row.generation_state,
    retireReason: row.retire_reason,
    retiredAt: row.retired_at,
    orphanedAt: row.orphaned_at,
    deletedAt: row.deleted_at,
    confirmedAbsentAt: row.confirmed_absent_at,
    quarantinedAt: row.quarantined_at,
    observedEtag: row.observed_etag,
    observedSize: row.observed_size === null ? null : Number(row.observed_size),
  };
}

export interface P07BlobRow {
  readonly blobId: string; readonly logicalState: string;
  readonly currentGenerationId: string | null; readonly verifiedSize: number | null;
  readonly verifiedSha256: string | null; readonly mediaType: string | null;
  readonly ownerSubjectId: string;
}

interface P07BlobSqlRow {
  blob_id: string; logical_state: string; current_generation_id: string | null;
  verified_size: string | null; verified_sha256: string | null; media_type: string | null;
  owner_subject_id: string;
}

export async function readP07Blob(runtime: DatabaseRuntime, blobId: string): Promise<P07BlobRow | null> {
  const rows = await sql<P07BlobSqlRow>`
    select blob_id, logical_state, current_generation_id, verified_size::text,
           verified_sha256, media_type, owner_subject_id
    from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    blobId: row.blob_id,
    logicalState: row.logical_state,
    currentGenerationId: row.current_generation_id,
    verifiedSize: row.verified_size === null ? null : Number(row.verified_size),
    verifiedSha256: row.verified_sha256,
    mediaType: row.media_type,
    ownerSubjectId: row.owner_subject_id,
  };
}

export interface P07AttachmentRow {
  readonly attachmentId: string; readonly blobId: string; readonly collectionId: string;
  readonly logicalState: string; readonly retiredAt: Date | null; readonly deletedAt: Date | null;
}

interface P07AttachmentSqlRow {
  attachment_id: string; blob_id: string; collection_id: string; logical_state: string;
  retired_at: Date | null; deleted_at: Date | null;
}

export async function readP07Attachment(runtime: DatabaseRuntime, blobId: string): Promise<P07AttachmentRow | null> {
  const rows = await sql<P07AttachmentSqlRow>`
    select attachment_id, blob_id, collection_id, logical_state, retired_at, deleted_at
    from attachments where blob_id = ${blobId}
  `.execute(runtime.db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    attachmentId: row.attachment_id,
    blobId: row.blob_id,
    collectionId: row.collection_id,
    logicalState: row.logical_state,
    retiredAt: row.retired_at,
    deletedAt: row.deleted_at,
  };
}

export interface P07OperationRow {
  readonly operationId: string; readonly attachmentId: string; readonly blobId: string;
  readonly collectionId: string; readonly commitOrdinal: bigint;
  readonly payloadJson: Record<string, unknown>;
}

interface P07OperationSqlRow {
  operation_id: string; collection_id: string; commit_ordinal: bigint;
  payload_json: Record<string, unknown>;
}

export async function readP07OperationByCommandId(
  runtime: DatabaseRuntime,
  operationType: string,
  commandId: string,
): Promise<P07OperationRow | null> {
  const rows = await sql<P07OperationSqlRow>`
    select operation.operation_id, operation.collection_id, operation.commit_ordinal,
      payload.payload_json
    from operation_lookup_facts fact
    join operations operation on operation.operation_id=fact.operation_id
    join operation_payloads payload on payload.operation_id=fact.operation_id
    where fact.operation_type = ${operationType}
      and fact.command_id = ${commandId}
    order by operation.commit_ordinal desc
    limit 1
  `.execute(runtime.db);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    operationId: row.operation_id,
    attachmentId: String(row.payload_json['attachmentId'] ?? ''),
    blobId: String(row.payload_json['blobId'] ?? ''),
    collectionId: row.collection_id,
    commitOrdinal: BigInt(row.commit_ordinal),
    payloadJson: row.payload_json,
  };
}

export async function p07OperationCount(
  runtime: DatabaseRuntime,
  operationType: string,
  commandId: string,
): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count
    from operation_lookup_facts
    where operation_type = ${operationType}
      and command_id = ${commandId}
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

export async function p07OutboxCount(
  runtime: DatabaseRuntime,
  blobId: string,
  handlerName: string,
): Promise<number> {
  const rows = await sql<{ count: string }>`
    select count(*)::text as count
    from outbox_events where aggregate_id = ${blobId} and handler_name = ${handlerName}
  `.execute(runtime.db);
  return Number(rows.rows[0]!.count);
}

/** The count of tombstone rows that must SURVIVE cleanup for a generation. */
export async function p07TombstoneCounts(
  runtime: DatabaseRuntime,
  generationId: string,
): Promise<{ keys: number; generations: number; intents: number }> {
  const rows = await runtime.pool.query<{ count: string }>(
    `select count(*)::text as count from generation_keys where generation_id = $1
     union all select count(*)::text from blob_generations where generation_id = $1
     union all select count(*)::text from upload_intents where generation_id = $1`,
    [generationId],
  );
  assert.equal(rows.rows.length, 3);
  return {
    keys: Number(rows.rows[0]!.count),
    generations: Number(rows.rows[1]!.count),
    intents: Number(rows.rows[2]!.count),
  };
}

/** Re-issuing a tombstoned physical key must be rejected (SQLSTATE 23505). */
export async function p07ReissueKeyRejected(
  runtime: DatabaseRuntime,
  generationId: string,
  key: string,
  blobId: string,
): Promise<{ code?: string }> {
  let failure: { code?: string } | undefined;
  try {
    await runtime.pool.query(
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
       values ($1, $2, $3, $4, 'allocate')`,
      [`reissue-${generationId}`, key, p07Digest(key), blobId],
    );
  } catch (error) {
    failure = error as { code?: string };
  }
  assert.ok(failure, 'reissuing the same physical key must be rejected');
  return failure!;
}

export interface P07CleanupInput {
  readonly ledger: ReturnType<typeof createPostgresAttachmentsPorts>;
  readonly objectStore: GenerationObjectStorePort;
  readonly config: AttachmentsFeatureConfig;
  readonly uow: ReturnType<typeof createUnitOfWork>;
  readonly leaseOwner: string;
  readonly faultInjector?: CleanupFaultInjector;
}

/** The production cleanup coordinator input for the P07 assertions. */
export function p07Cleanup(
  runtime: I07MigrationRuntime['runtime'],
  store: GenerationObjectStorePort,
  config: AttachmentsFeatureConfig,
  leaseOwner: string,
  faultInjector?: CleanupFaultInjector,
): P07CleanupInput {
  return {
    ledger: createPostgresAttachmentsPorts(),
    objectStore: store,
    config,
    uow: createUnitOfWork(runtime.db),
    leaseOwner,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  };
}
