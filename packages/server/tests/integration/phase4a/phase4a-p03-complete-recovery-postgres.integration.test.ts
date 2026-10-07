/**
 * P4A-P03 focused PostgreSQL suite (part 2b): complete-route recovery and
 * negative contracts.
 *
 * Full production flow through the REAL routes (HTTP issue -> INDEPENDENT
 * HTTP client PUT against the REAL presigned URL -> HTTP complete). Asserts
 * 404 concealment for foreign/wrong-principal bindings, physical-key
 * rejection, the frozen late/expired policy, provider-HEAD unknown mapping,
 * client abort safety, API restart recovery, and zero key/secret leakage in
 * the database and Outbox payloads.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  P03_COLLECTION,
  P03_LIVE_PREFIX,
  P03_ORIGIN,
  P03_RO_CREDENTIAL,
  P03_RW_CREDENTIAL,
  P03ObjectServer,
  buildP03App,
  makeP03Config,
  seedP03Collection,
  sha256Hex,
  type P03AppBundle,
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { createProductAttachmentClient } from '../../../generated/openapi/product-v1.client.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const CONFIG = makeP03Config();

interface CompleteProblem {
  error: {
    code: string;
    message: string;
    requestId: string;
    recovery: string;
    sameRequestRetrySafe: boolean;
    precondition: unknown;
    currentEtag: unknown;
    retryAfterSeconds: unknown;
    fieldErrors: Array<{ path: string; code: string; message: string }>;
  };
}

/**
 * The 404 concealment contract: every foreign/absent/wrong-principal binding
 * yields the identical STABLE Problem. requestId is per-request by design, so
 * the byte-identity comparison covers every other envelope field.
 */
function stableProblem(body: string): unknown {
  const parsed = JSON.parse(body) as CompleteProblem;
  const { requestId, ...stable } = parsed.error;
  void requestId;
  return stable;
}

interface IssueReceipt {
  blobId: string;
  intentId: string;
  generationId: string;
}

interface IssueGrant {
  url: string;
  method: string;
  contentType: string;
  contentLength: number;
  expiresAt: string;
  ttlSeconds: number;
}

function p03Body(size = 2048): Buffer {
  const body = Buffer.alloc(size);
  body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < body.length; index += 1) body[index] = index % 251;
  return body;
}

function mutationHeaders(client: AuthenticatedTestClient, commandId: string): Record<string, string> {
  return {
    cookie: client.cookie,
    origin: P03_ORIGIN,
    'x-csrf-token': client.csrfToken,
    'known-command-id': commandId,
    'content-type': 'application/json',
  };
}

function completeBody(binding: IssueReceipt, declared: { size: number; sha256: string; mediaType: string; etag: string }) {
  return { binding, declared };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describeWithPostgres('P4A-P03 production complete route (recovery negatives)', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P03ObjectServer;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let member: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p03_complete_recovery', { maxConnections: 12 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p03-owner', handle: 'p03_owner',
    });
    member = await issueTestSession({
      factory,
      subject: 'p03-member', handle: 'p03_member',
    });
    await seedP03Collection(isolated.runtime, {
      collectionId: P03_COLLECTION,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: member.subjectId, role: 'editor' },
      ],
    });
    objectServer = new P03ObjectServer();
    await objectServer.start();
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  function newApp(): P03AppBundle {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
  }

  async function issueViaHttp(bundle: P03AppBundle, client: AuthenticatedTestClient, body: Buffer): Promise<{
    receipt: IssueReceipt;
    grant: IssueGrant;
    commandId: string;
  }> {
    const commandId = randomUUID();
    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/attachments/issue',
      headers: mutationHeaders(client, commandId),
      payload: JSON.stringify({
        collectionId: P03_COLLECTION,
        declaredSize: body.byteLength,
        declaredSha256: sha256Hex(body),
        mediaHint: 'image/png',
        expectedPolicyRevision: null,
      }),
    });
    assert.equal(response.statusCode, 201, response.body);
    const parsed = response.json() as { receipt: IssueReceipt; grant: IssueGrant };
    return { receipt: parsed.receipt, grant: parsed.grant, commandId };
  }

  /** Independent HTTP client executes the REAL presigned URL (create-only PUT). */
  async function putViaHttp(grant: IssueGrant, body: Buffer): Promise<string> {
    const response = await fetch(grant.url, {
      method: 'PUT',
      headers: {
        'If-None-Match': '*',
        'Content-Type': grant.contentType,
      },
      body: body as unknown as BodyInit,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.status === 200 || response.status === 201, `external PUT failed: ${response.status}`);
    const etag = response.headers.get('etag');
    assert.ok(etag, 'external PUT must return an ETag');
    return etag;
  }

  async function completeViaHttp(
    bundle: P03AppBundle,
    client: AuthenticatedTestClient,
    binding: IssueReceipt,
    declared: { size: number; sha256: string; mediaType: string; etag: string },
    commandId: string,
  ) {
    return bundle.app.inject({
      method: 'POST',
      url: '/api/v1/attachments/complete',
      headers: mutationHeaders(client, commandId),
      payload: JSON.stringify(completeBody(binding, declared)),
    });
  }

  async function outboxCount(blobId: string): Promise<number> {
    const rows = await sql<{ count: string }>`
      select count(*)::text as count from outbox_events
      where handler_name = 'attachments_verify_generation' and aggregate_id = ${blobId}
    `.execute(isolated.runtime.db);
    return Number(rows.rows[0]!.count);
  }

  async function blobState(blobId: string): Promise<{ logical_state: string; current_generation_id: string | null } | null> {
    const rows = await sql<{ logical_state: string; current_generation_id: string | null }>`
      select logical_state, current_generation_id from blob_records where blob_id = ${blobId}
    `.execute(isolated.runtime.db);
    return rows.rows[0] ?? null;
  }

  async function keyOf(intentId: string): Promise<string> {
    const rows = await isolated.runtime.pool.query<{ key: string }>(
      `select bg.key from upload_intents ui join blob_generations bg on bg.generation_id = ui.generation_id
       where ui.intent_id = $1`, [intentId],
    );
    assert.equal(rows.rowCount, 1);
    return rows.rows[0]!.key;
  }

  test('foreign, wrong-principal and anonymous completes are concealed or rejected with zero side effects', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);
      const declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };

      const wrongBlob = await completeViaHttp(bundle, owner, {
        blobId: 'f'.repeat(64), intentId: receipt.intentId, generationId: receipt.generationId,
      }, declared, randomUUID());
      assert.equal(wrongBlob.statusCode, 404);
      assert.equal((wrongBlob.json() as CompleteProblem).error.code, 'resource_not_found');
      assert.equal(wrongBlob.headers['cache-control'], 'private, no-store');

      const wrongGeneration = await completeViaHttp(bundle, owner, {
        blobId: receipt.blobId, intentId: receipt.intentId, generationId: 'e'.repeat(32),
      }, declared, randomUUID());
      assert.equal(wrongGeneration.statusCode, 404);
      assert.equal((wrongGeneration.json() as CompleteProblem).error.code, 'resource_not_found');

      // 404 concealment: the external Problem is identical for every foreign
      // identity (no existence side channel). requestId is per-request by
      // design; every other envelope byte is compared.
      assert.deepEqual(stableProblem(wrongBlob.body), stableProblem(wrongGeneration.body));

      const nonexistent = await completeViaHttp(bundle, owner, {
        blobId: 'd'.repeat(64), intentId: 'c'.repeat(32), generationId: 'e'.repeat(32),
      }, declared, randomUUID());
      assert.equal(nonexistent.statusCode, 404);
      assert.deepEqual(stableProblem(nonexistent.body), stableProblem(wrongBlob.body), 'foreign and absent bindings share the identical 404');

      const wrongPrincipal = await completeViaHttp(bundle, member, receipt, declared, randomUUID());
      assert.equal(wrongPrincipal.statusCode, 404, 'wrong-principal binding is concealed');
      assert.equal((wrongPrincipal.json() as CompleteProblem).error.code, 'resource_not_found');
      assert.deepEqual(stableProblem(wrongPrincipal.body), stableProblem(wrongBlob.body));

      const anonymous = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/complete',
        headers: { origin: P03_ORIGIN, 'x-csrf-token': 'x'.repeat(43), 'known-command-id': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify(completeBody(receipt, declared)),
      });
      assert.equal(anonymous.statusCode, 401);
      assert.equal((anonymous.json() as CompleteProblem).error.code, 'authentication_required');

      assert.equal(await outboxCount(receipt.blobId), 0);
      assert.equal((await blobState(receipt.blobId))?.logical_state, 'issued');
      assert.equal((await blobState(receipt.blobId))?.current_generation_id, null);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('complete never accepts a physical key and rejects unknown fields as invalid_document', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);
      const declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };
      const key = await keyOf(receipt.intentId);

      const bindingWithKey = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/complete',
        headers: mutationHeaders(owner, randomUUID()),
        payload: JSON.stringify({
          binding: { ...receipt, key },
          declared,
        }),
      });
      assert.equal(bindingWithKey.statusCode, 422);
      assert.equal((bindingWithKey.json() as CompleteProblem).error.code, 'invalid_document');
      assert.ok((bindingWithKey.json() as CompleteProblem).error.fieldErrors.some((entry) => entry.code === 'unknown_field'));

      const topLevelKey = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/complete',
        headers: mutationHeaders(owner, randomUUID()),
        payload: JSON.stringify({ binding: receipt, declared, key }),
      });
      assert.equal(topLevelKey.statusCode, 422);
      assert.equal((topLevelKey.json() as CompleteProblem).error.code, 'invalid_document');

      assert.equal(await outboxCount(receipt.blobId), 0);
      // The physical object is untouched by key-carrying requests: it still
      // exists under the exact committed key with the identical ETag.
      assert.equal(objectServer.has(key), true, 'the object must still exist under the exact key');
      assert.equal(objectServer.etagOf(key), etag, 'the object bytes must be untouched');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('an expired intent is rejected with attachment_state_conflict and the frozen late policy', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const blobId = `expired-${randomUUID().replaceAll('-', '')}`;
      const intentId = `intent-${randomUUID().replaceAll('-', '')}`;
      const generationId = `generation-${randomUUID().replaceAll('-', '')}`;
      const key = `${P03_LIVE_PREFIX}expired-${randomUUID().replaceAll('-', '')}`;
      const etag = `"etag-expired"`;
      const ports = createPostgresAttachmentsPorts();
      await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) => ports.allocate(transaction, {
        blobId,
        intentId,
        generationId,
        principalId: owner.accountId,
        collectionId: P03_COLLECTION,
        subjectIdentity: owner.subjectId,
        bucket: CONFIG.r2.bucket,
        key,
        keyFingerprint: sha256Hex(key),
        expectedSize: body.byteLength,
        expectedSha256: sha256Hex(body),
        mediaHint: 'image/png',
        policyRevision: 'policy-r1',
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() - 60_000),
      }));
      // Provider fixture: the object exists (legitimate pre-commit state).
      objectServer.objects.set(key, {
        etag, size: body.byteLength, contentType: 'image/png', metadata: {}, body,
      });

      const response = await completeViaHttp(bundle, owner, { blobId, intentId, generationId }, {
        size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag,
      }, randomUUID());
      assert.equal(response.statusCode, 409);
      assert.equal((response.json() as CompleteProblem).error.code, 'attachment_state_conflict');
      assert.equal(await outboxCount(blobId), 0);
      const state = await blobState(blobId);
      assert.equal(state?.logical_state, 'expired', 'late complete must apply the frozen late policy');
      const generation = await sql<{ generation_state: string }>`
        select generation_state from blob_generations where generation_id = ${generationId}
      `.execute(isolated.runtime.db);
      assert.equal(generation.rows[0]?.generation_state, 'orphaned');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a provider HEAD unknown maps to a retryable 503 with zero database side effects and recovers', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);
      const key = await keyOf(receipt.intentId);
      const declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };

      objectServer.headFailures.add(key);
      const failed = await completeViaHttp(bundle, owner, receipt, declared, randomUUID());
      assert.equal(failed.statusCode, 503);
      const problem = failed.json() as CompleteProblem;
      assert.equal(problem.error.code, 'rate_limit_unavailable');
      assert.equal(problem.error.sameRequestRetrySafe, true, 'a retry with the same request must be safe');
      assert.equal(failed.headers['retry-after'], undefined, '503 must never fabricate a quota fact');
      assert.equal(await outboxCount(receipt.blobId), 0);
      assert.equal((await blobState(receipt.blobId))?.logical_state, 'issued');

      objectServer.headFailures.delete(key);
      const recovered = await completeViaHttp(bundle, owner, receipt, declared, randomUUID());
      assert.equal(recovered.statusCode, 200);
      assert.equal((recovered.json() as { kind: string }).kind, 'completed');
      assert.equal(await outboxCount(receipt.blobId), 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a client abort during the provider HEAD is safe and the retry converges to one Outbox row', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);
      const key = await keyOf(receipt.intentId);
      const declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };
      const baseUrl = await listen(bundle.app);
      const commandId = randomUUID();

      objectServer.headDelays.set(key, 1_200);
      const controller = new AbortController();
      const attempt = fetch(`${baseUrl}/api/v1/attachments/complete`, {
        method: 'POST',
        headers: mutationHeaders(owner, commandId),
        body: JSON.stringify(completeBody(receipt, declared)),
        signal: controller.signal,
      }).then(
        () => undefined,
        () => undefined,
      );
      await waitForCondition(
        () => objectServer.requests.some((request) => request.method === 'HEAD'
          && request.path.includes(key)),
        { timeoutMs: 5_000, description: 'the aborted complete request to reach the delayed provider HEAD' },
      );
      controller.abort();
      await attempt;
      // New requests are no longer delayed. If the aborted server-side attempt
      // is still finishing, the retry converges through the real database
      // locking/idempotency path instead of relying on a guessed delay.
      objectServer.headDelays.delete(key);

      const retry = await completeViaHttp(bundle, owner, receipt, declared, randomUUID());
      assert.equal(retry.statusCode, 200, retry.body);
      const kind = (retry.json() as { kind: string }).kind;
      assert.ok(kind === 'completed' || kind === 'idempotent', `expected converged complete, got ${kind}`);
      assert.equal(await outboxCount(receipt.blobId), 1, 'abort must never duplicate the Outbox row');
      assert.equal((await blobState(receipt.blobId))?.logical_state, 'uploaded');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('API restart: complete after restart re-reads the authoritative ledger', async () => {
    const first = newApp();
    const body = p03Body();
    let receipt: IssueReceipt;
    let etag: string;
    let declared: { size: number; sha256: string; mediaType: string; etag: string };
    try {
      const issued = await issueViaHttp(first, owner, body);
      receipt = issued.receipt;
      etag = await putViaHttp(issued.grant, body);
      declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };
    } finally {
      await first.app.close();
      await first.store.close();
    }
    const second = newApp();
    try {
      const completed = await completeViaHttp(second, owner, receipt, declared, randomUUID());
      assert.equal(completed.statusCode, 200, completed.body);
      assert.equal((completed.json() as { kind: string }).kind, 'completed');
      assert.equal(await outboxCount(receipt.blobId), 1);

      // A stale/wrong binding is still concealed after restart (authoritative
      // ledger re-read, never a cached guess).
      const stale = await completeViaHttp(second, owner, {
        blobId: receipt.blobId, intentId: receipt.intentId, generationId: '0'.repeat(32),
      }, declared, randomUUID());
      assert.equal(stale.statusCode, 404);
      assert.equal((stale.json() as CompleteProblem).error.code, 'resource_not_found');
    } finally {
      await second.app.close();
      await second.store.close();
    }
  });
});
