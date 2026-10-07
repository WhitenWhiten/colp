/**
 * P4A-P03 focused PostgreSQL suite (part 2a): the production complete route.
 *
 * Full production flow through the REAL routes: HTTP issue -> INDEPENDENT
 * HTTP client PUT against the REAL presigned URL (production adapter over a
 * local object transport) -> HTTP complete. Asserts the generated OpenAPI
 * client contract, the same-commit verification Outbox, idempotent replay /
 * concurrent convergence, and tampered-declaration recovery.
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

describeWithPostgres('P4A-P03 production complete route', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P03ObjectServer;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let member: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p03_complete', { maxConnections: 12 });
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

  test('the generated OpenAPI client drives the production issue/complete routes', async () => {
    const bundle = newApp();
    try {
      const fetchShim = async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const response = await bundle.app.inject({
          method: (init?.method ?? 'GET') as 'GET' | 'POST',
          url: url.pathname + url.search,
          headers,
          ...(init?.body === undefined ? {} : { payload: String(init.body) }),
        });
        return {
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: response.headers as unknown as Headers,
          json: async () => response.json(),
        };
      };
      const client = createProductAttachmentClient({
        origin: P03_ORIGIN,
        csrfToken: owner.csrfToken,
        sessionCookie: owner.cookie,
        originHeader: P03_ORIGIN,
        fetch: fetchShim as typeof globalThis.fetch,
      });
      const body = p03Body();
      const commandId = randomUUID();
      const issued = await client.issue({
        collectionId: P03_COLLECTION,
        declaredSize: body.byteLength,
        declaredSha256: sha256Hex(body),
        mediaHint: 'image/png',
        expectedPolicyRevision: null,
      }, commandId);
      assert.equal(issued.kind, 'issued');
      const etag = await putViaHttp(issued.grant, body);
      const completed = await client.complete({
        binding: issued.receipt,
        declared: { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag },
      }, commandId);
      assert.equal(completed.kind, 'completed');
      assert.deepEqual(completed.receipt, issued.receipt);
      assert.equal(await outboxCount(issued.receipt.blobId), 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('issue -> independent PUT -> complete converges to uploaded with one same-commit Outbox row', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant, commandId } = await issueViaHttp(bundle, owner, body);
      const key = await keyOf(receipt.intentId);

      // Ledger-before-grant: DB-clock ordering before the external PUT.
      const ledger = await isolated.runtime.pool.query<{ created_at: Date; observed: Date }>(
        `select ui.created_at, clock_timestamp() as observed from upload_intents ui where ui.intent_id = $1`,
        [receipt.intentId],
      );
      assert.equal(ledger.rowCount, 1);
      assert.ok(ledger.rows[0]!.created_at.getTime() <= ledger.rows[0]!.observed.getTime());

      const etag = await putViaHttp(grant, body);
      assert.equal(objectServer.has(key), true, 'the independent PUT must reach the exact generation key');
      assert.equal(objectServer.etagOf(key), etag);

      const completed = await completeViaHttp(bundle, owner, receipt, {
        size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag,
      }, commandId);
      assert.equal(completed.statusCode, 200, completed.body);
      const result = completed.json() as { kind: string; receipt: IssueReceipt };
      assert.equal(result.kind, 'completed');
      assert.deepEqual(result.receipt, receipt);

      const state = await blobState(receipt.blobId);
      assert.equal(state?.logical_state, 'uploaded');
      assert.equal(state?.current_generation_id, receipt.generationId);
      assert.equal(await outboxCount(receipt.blobId), 1, 'verification Outbox must be enqueued in the same commit');

      // Zero key/secret leakage: no grant URL / credential / signature in the
      // ledger or Outbox payload, and no physical key in the Outbox payload.
      const outbox = await sql`
        select payload_json from outbox_events
        where handler_name = 'attachments_verify_generation' and aggregate_id = ${receipt.blobId}
      `.execute(isolated.runtime.db);
      const outboxText = JSON.stringify(outbox.rows);
      assert.equal(outboxText.includes(receipt.generationId), true);
      assert.equal(outboxText.includes(key), false, 'Outbox payload must never carry the physical key');
      assert.equal(outboxText.includes(grant.url), false);
      assert.equal(outboxText.includes('X-Amz-Signature'), false);

      const dump = await sql`
        select ui.intent_id, ui.blob_id, ui.generation_id, ui.idempotency_key, ui.expected_sha256,
               bg.key, bg.bucket, bg.key_fingerprint, bg.observed_etag, bg.observed_size::text
        from upload_intents ui join blob_generations bg on bg.generation_id = ui.generation_id
      `.execute(isolated.runtime.db);
      const dumpText = JSON.stringify(dump.rows);
      for (const forbidden of [grant.url, 'X-Amz-Signature', P03_RW_CREDENTIAL.accessKeyId,
        P03_RW_CREDENTIAL.secretAccessKey, P03_RO_CREDENTIAL.accessKeyId, P03_RO_CREDENTIAL.secretAccessKey]) {
        assert.equal(dumpText.includes(forbidden), false, 'secret must not be persisted');
      }

      // Exact-key cleanup: DELETE + HEAD-confirmed absence leaves zero residual.
      const deleted = await bundle.store.deleteExact({ generationId: receipt.generationId, key });
      assert.ok(deleted.outcome === 'deleted' || deleted.outcome === 'absent');
      const absent = await bundle.store.confirmAbsent({ generationId: receipt.generationId, key });
      assert.equal(absent.absent, true);
      assert.equal(objectServer.has(key), false);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('duplicate complete is idempotent and never enqueues a second Outbox row', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant, commandId } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);
      const declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };

      const first = await completeViaHttp(bundle, owner, receipt, declared, commandId);
      assert.equal(first.statusCode, 200);
      assert.equal((first.json() as { kind: string }).kind, 'completed');

      const second = await completeViaHttp(bundle, owner, receipt, declared, randomUUID());
      assert.equal(second.statusCode, 200);
      assert.equal((second.json() as { kind: string }).kind, 'idempotent');
      assert.equal(await outboxCount(receipt.blobId), 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('concurrent complete converges to a single Outbox row', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);
      const declared = { size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag };
      const [left, right] = await Promise.all([
        completeViaHttp(bundle, owner, receipt, declared, randomUUID()),
        completeViaHttp(bundle, owner, receipt, declared, randomUUID()),
      ]);
      assert.equal(left.statusCode, 200);
      assert.equal(right.statusCode, 200);
      const kinds = [(left.json() as { kind: string }).kind, (right.json() as { kind: string }).kind].sort();
      assert.deepEqual(kinds, ['completed', 'idempotent']);
      assert.equal(await outboxCount(receipt.blobId), 1);
      assert.equal((await blobState(receipt.blobId))?.logical_state, 'uploaded');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('tampered declarations are attachment_state_conflict with zero Outbox side effects', async () => {
    const bundle = newApp();
    try {
      const body = p03Body();
      const { receipt, grant } = await issueViaHttp(bundle, owner, body);
      const etag = await putViaHttp(grant, body);

      const wrongEtag = await completeViaHttp(bundle, owner, receipt, {
        size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag: '"tampered-etag"',
      }, randomUUID());
      assert.equal(wrongEtag.statusCode, 409);
      assert.equal((wrongEtag.json() as CompleteProblem).error.code, 'attachment_state_conflict');

      const wrongSize = await completeViaHttp(bundle, owner, receipt, {
        size: 999, sha256: sha256Hex(body), mediaType: 'image/png', etag,
      }, randomUUID());
      assert.equal(wrongSize.statusCode, 409);
      assert.equal((wrongSize.json() as CompleteProblem).error.code, 'attachment_state_conflict');

      const wrongDigest = await completeViaHttp(bundle, owner, receipt, {
        size: body.byteLength, sha256: 'b'.repeat(64), mediaType: 'image/png', etag,
      }, randomUUID());
      assert.equal(wrongDigest.statusCode, 409);
      assert.equal((wrongDigest.json() as CompleteProblem).error.code, 'attachment_state_conflict');

      assert.equal(await outboxCount(receipt.blobId), 0);
      assert.equal((await blobState(receipt.blobId))?.logical_state, 'issued');

      // The same object still completes after the tampered attempts.
      const honest = await completeViaHttp(bundle, owner, receipt, {
        size: body.byteLength, sha256: sha256Hex(body), mediaType: 'image/png', etag,
      }, randomUUID());
      assert.equal(honest.statusCode, 200);
      assert.equal((honest.json() as { kind: string }).kind, 'completed');
      assert.equal(await outboxCount(receipt.blobId), 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

});
