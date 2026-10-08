/**
 * P4A-P04 shared helpers for the focused suites. This file is not a test file:
 * it matches no vitest test pattern and is never listed in a focused config.
 *
 * Provides:
 *  - production state-driving helpers over the REAL PostgreSQL attachments
 *    ports (allocate / completeUploadCas / claimVerification /
 *    completeVerification / quarantineVerification / finalizeHandoff), so the
 *    status read observes genuine ledger states — no test SQL manufactures a
 *    success path;
 *  - the P02 canonical finalize + the legal terminal-fact precondition rows
 *    (the retire/deleted MUTATIONS belong to P07; P04 only prepares the
 *    terminal metadata facts to pin the read/concealment contract);
 *  - `instrumentP04QueryCounter`: a pg Pool statement counter that covers
 *    every statement through the runtime pool, Kysely transactions included
 *    (BEGIN/COMMIT are counted but assertions filter to SELECTs).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Pool, PoolClient } from 'pg';
import { createPostgresAttachmentCanonicalMutationPorts, createPostgresAttachmentsPorts, createUnitOfWork, type DatabaseRuntime } from '../../src/infrastructure/database/index.js';
import {
  I13_MEDIA_TYPE,
  i13Body,
  i13CompleteCasInput,
  i13HandoffInput,
  sha256HexBytes,
  slotOf,
} from './phase4a-i13-test-helpers.js';
import {
  finalizeInTx,
  p02FinalizeInput,
  seedP02StoredPrivate,
} from './phase4a-p02-test-helpers.js';
import { identityFor, type I07MigrationRuntime } from './phase4a-i07-test-helpers.js';

export const P04_ISSUER = 'https://issuer.example';
export const P04_COLLECTION_A = 'p04-collection-a';
export const P04_COLLECTION_B = 'p04-collection-b';
export const P04_MEDIA_TYPE = I13_MEDIA_TYPE;
export const P04_POLICY_VERSION = 'p04-policy-v1';
export const P04_DECLARED_SIZE = 2048;

/** The actor facts the blob ledger binds (session subject + account id). */
export interface P04BlobOwner {
  readonly subjectId: string;
  readonly principalId: string;
}

export interface P04SeedOptions {
  readonly owner: P04BlobOwner;
  readonly collectionId?: string;
  /** Past expiry drives the `expired`/`orphaned` state. */
  readonly expiresAt?: Date;
  readonly declaredSize?: number;
}

const ports = createPostgresAttachmentsPorts();

function p04AllocateInput(
  id: ReturnType<typeof identityFor>,
  body: Uint8Array,
  options: P04SeedOptions,
) {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: options.owner.principalId,
    collectionId: options.collectionId ?? P04_COLLECTION_A,
    subjectIdentity: options.owner.subjectId,
    bucket: 'p04-bucket',
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: options.declaredSize ?? body.byteLength,
    expectedSha256: sha256HexBytes(body),
    mediaHint: P04_MEDIA_TYPE,
    policyRevision: P04_POLICY_VERSION,
    idempotencyKey: `p04-idem-${id.intentId}`,
    expiresAt: options.expiresAt ?? new Date('2099-01-01T00:00:00.000Z'),
  };
}

/**
 * Seeds the exact verification outbox fence the production claim port checks
 * (`state='leased'`, `lease_generation`, `locked_until` in the future) and
 * returns the attempt fence the worker presents on every verification write.
 */
async function seedVerificationFence(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
): Promise<{ outboxId: string; leaseGeneration: string }> {
  const attempt = { outboxId: `p04-outbox-${id.generationId}`, leaseGeneration: '1' };
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
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
  });
  return attempt;
}

async function allocateAndComplete(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<Uint8Array> {
  const body = i13Body(slotOf(id));
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, p04AllocateInput(id, body, options));
    assert.equal(allocated.outcome, 'issued');
    const cas = await ports.completeUploadCas(transaction, i13CompleteCasInput(id, body, {
      actorPrincipalId: options.owner.principalId,
    }));
    assert.equal(cas.outcome, 'uploaded');
  });
  return body;
}

/** Logical state `issued` (generation `allocated`). */
export async function seedP04Issued(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = i13Body(slotOf(id));
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, p04AllocateInput(id, body, options));
    assert.equal(allocated.outcome, 'issued');
  });
  return { body, digest: sha256HexBytes(body) };
}

/** Logical state `uploaded` (generation `active`, bound observed facts). */
export async function seedP04Uploaded(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = await allocateAndComplete(runtime, id, options);
  return { body, digest: sha256HexBytes(body) };
}

/** Logical state `verifying` (verification lease claimed, CAS not completed). */
export async function seedP04Verifying(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = await allocateAndComplete(runtime, id, options);
  const attempt = await seedVerificationFence(runtime, id);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const claimed = await ports.claimVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed');
  });
  return { body, digest: sha256HexBytes(body) };
}

/** Logical state `stored_private` (verification completed, active generation). */
export async function seedP04StoredPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = i13Body(slotOf(id));
  const attempt = await seedVerificationFence(runtime, id);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, p04AllocateInput(id, body, options));
    assert.equal(allocated.outcome, 'issued');
    const cas = await ports.completeUploadCas(transaction, i13CompleteCasInput(id, body, {
      actorPrincipalId: options.owner.principalId,
    }));
    assert.equal(cas.outcome, 'uploaded');
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
      verifiedSha256: sha256HexBytes(body),
      mediaType: I13_MEDIA_TYPE,
      policyVersion: P04_POLICY_VERSION,
    });
    assert.equal(completed.outcome, 'stored_private');
  });
  return { body, digest: sha256HexBytes(body) };
}

/** Logical state `attached_private` (finalize handoff consumed the generation). */
export async function seedP04AttachedPrivate(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = i13Body(slotOf(id));
  await seedP04StoredPrivate(runtime, id, options);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const handoff = await ports.finalizeHandoff(transaction, i13HandoffInput(id, {
      blobId: id.blobId,
      ownerSubjectId: options.owner.subjectId,
      policyRevision: P04_POLICY_VERSION,
    }));
    assert.equal(handoff.outcome, 'attached');
  });
  return { body, digest: sha256HexBytes(body) };
}

/** Blob `expired` + generation `orphaned` (intent deadline crossed before complete). */
export async function seedP04Expired(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = i13Body(slotOf(id));
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const allocated = await ports.allocate(transaction, p04AllocateInput(id, body, {
      ...options,
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
    }));
    assert.equal(allocated.outcome, 'issued');
    const cas = await ports.completeUploadCas(transaction, i13CompleteCasInput(id, body, {
      actorPrincipalId: options.owner.principalId,
    }));
    assert.equal(cas.outcome, 'late_rejected');
  });
  const state = await runtime.pool.query<{ logical_state: string }>(
    'select logical_state from blob_records where blob_id = $1', [id.blobId],
  );
  assert.equal(state.rows[0]?.logical_state, 'expired');
  return { body, digest: sha256HexBytes(body) };
}

/** Blob `expired` + generation `quarantined` (verification quarantine). */
export async function seedP04Quarantined(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions,
): Promise<{ body: Uint8Array; digest: string }> {
  const body = await allocateAndComplete(runtime, id, options);
  const attempt = await seedVerificationFence(runtime, id);
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    const claimed = await ports.claimVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      leaseTtlSeconds: 60,
    });
    assert.equal(claimed.outcome, 'claimed');
    const quarantined = await ports.quarantineVerification(transaction, {
      blobId: id.blobId,
      generationId: id.generationId,
      attempt,
      reason: 'digest_mismatch',
    });
    assert.equal(quarantined.outcome, 'quarantined');
  });
  return { body, digest: sha256HexBytes(body) };
}

/**
 * Drives the P02 canonical finalize so the blob carries a REAL `attachments`
 * metadata row, then prepares the legal terminal fact (`retired` requires
 * `retired_at`, `deleted` requires `deleted_at`). The retire/delete MUTATION
 * belongs to P07; this helper only prepares the metadata precondition so P04
 * can pin the read/concealment contract for terminal attachments.
 */
export async function seedP04TerminalAttachmentMetadata(
  runtime: I07MigrationRuntime['runtime'],
  id: ReturnType<typeof identityFor>,
  options: P04SeedOptions & { readonly terminalState: 'retired' | 'deleted' },
): Promise<void> {
  const assembly = createPostgresAttachmentCanonicalMutationPorts();
  await seedP02StoredPrivate(runtime, id, options.collectionId ?? P04_COLLECTION_A, {
    ownerSubjectId: options.owner.subjectId,
    principalId: options.owner.principalId,
  });
  const result = await finalizeInTx(runtime, assembly, p02FinalizeInput(id, {
    blobId: id.blobId,
    collectionId: options.collectionId ?? P04_COLLECTION_A,
    ownerSubjectId: options.owner.subjectId,
    actorPrincipalId: options.owner.principalId,
  }));
  assert.equal(result.outcome, 'finalized');
  const timestampColumn = options.terminalState === 'retired' ? 'retired_at' : 'deleted_at';
  const updated = await runtime.pool.query(
    `update attachments set logical_state = $1, ${timestampColumn} = now(), updated_at = now()
     where blob_id = $2 and logical_state = 'attached_private'`,
    [options.terminalState, id.blobId],
  );
  assert.equal(updated.rowCount, 1);
}

// ---------------------------------------------------------------------------
// pg Pool statement counter (covers Kysely transactions and raw pool.query)
// ---------------------------------------------------------------------------

export interface P04QueryCounter {
  readonly statements: readonly string[];
  selectDelta(before: number): number;
  snapshot(): number;
}

function statementText(first: unknown): string {
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * Counts every statement sent through the runtime pg pool. The pool's
 * `connect` is wrapped so EVERY acquired client (including idle clients
 * created before instrumentation, e.g. during migrations) reports its
 * statements exactly once; both Kysely and raw `pool.query` acquire clients
 * through `connect`, so no path can bypass the counter. BEGIN/COMMIT are
 * counted but callers filter to SELECTs for workload assertions.
 */
export function instrumentP04QueryCounter(runtime: DatabaseRuntime): P04QueryCounter {
  const statements: string[] = [];
  const wrappedClients = new WeakSet<object>();
  const wrapQuery = (original: (...args: unknown[]) => unknown) =>
    function wrapped(this: unknown, ...args: unknown[]): unknown {
      const text = statementText(args[0]);
      if (text.trim() !== '') statements.push(text);
      return original.apply(this, args);
    };

  const pool = runtime.pool as Pool;
  const originalConnect = pool.connect.bind(pool) as unknown as (callback?: unknown) => Promise<PoolClient> | void;
  pool.connect = ((...args: unknown[]) => {
    // Callback form (not used by Kysely/pool internals): delegate untouched.
    if (typeof args[0] === 'function') return originalConnect(args[0]) as unknown;
    return (originalConnect() as Promise<PoolClient>).then((client: PoolClient) => {
      if (!wrappedClients.has(client)) {
        wrappedClients.add(client);
        client.query = wrapQuery(client.query.bind(client)) as typeof client.query;
      }
      return client;
    });
  }) as typeof pool.connect;
  return Object.freeze({
    statements,
    snapshot: () => statements.length,
    selectDelta: (before: number) =>
      statements.slice(before).filter((text) => /^\s*select\b/iu.test(text)).length,
  });
}
