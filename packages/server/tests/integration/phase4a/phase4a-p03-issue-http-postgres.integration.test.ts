/**
 * P4A-P03 focused PostgreSQL suite (part 1): the production issue route.
 *
 * Boots the PRODUCTION app composition (`buildApiApp`) with the REAL
 * PostgreSQL attachments ports, the REAL R2 adapter pointed at a local HTTP
 * object server (real presigner, real transport), and the production
 * admission switch store + verification Outbox append. Every request goes
 * through the real route with session cookie + Origin + CSRF +
 * Known-Command-Id (no module helper substitutes for the route).
 *
 * Covers the issue half of the P03 test scope: owner/member/outsider/
 * anonymous, ledger-before-grant ordering, duplicate + concurrent issue,
 * durable admission switch, oversize/malformed input (zero ledger side
 * effects), client abort convergence, API restart recovery, and zero
 * key/secret leakage in the database.
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
  P03_BUCKET,
  P03_COLLECTION,
  P03_LIVE_PREFIX,
  P03_ORIGIN,
  P03_RO_CREDENTIAL,
  P03_RW_CREDENTIAL,
  P03ObjectServer,
  buildP03App,
  makeP03Config,
  seedP03Collection,
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import { stopAdmissionAndDrain, resumeAdmission } from '../../../src/modules/attachments/index.js';
import { createPostgresAttachmentsAdmissionSwitchStore } from '../../../src/infrastructure/database/index.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');
const CONFIG = makeP03Config();
const DIGEST = 'a'.repeat(64);

interface IssueProblem {
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

interface IssueBody {
  collectionId: string;
  declaredSize: number;
  declaredSha256: string | null;
  mediaHint: string | null;
  expectedPolicyRevision: string | null;
}

function issueBody(overrides: Partial<IssueBody> = {}): IssueBody {
  return {
    collectionId: P03_COLLECTION,
    declaredSize: 2048,
    declaredSha256: DIGEST,
    mediaHint: 'image/png',
    expectedPolicyRevision: null,
    ...overrides,
  };
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

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describeWithPostgres('P4A-P03 production issue route', () => {
  let isolated: I07MigrationRuntime;
  let objectServer: P03ObjectServer;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let viewer: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p03_issue', { maxConnections: 12 });
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p03-owner', handle: 'p03_owner',
    });
    editor = await issueTestSession({
      factory,
      subject: 'p03-editor', handle: 'p03_editor',
    });
    viewer = await issueTestSession({
      factory,
      subject: 'p03-viewer', handle: 'p03_viewer',
    });
    outsider = await issueTestSession({
      factory,
      subject: 'p03-outsider', handle: 'p03_outsider',
    });
    await seedP03Collection(isolated.runtime, {
      collectionId: P03_COLLECTION,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: editor.subjectId, role: 'editor' },
        { subjectId: viewer.subjectId, role: 'viewer' },
      ],
    });
    objectServer = new P03ObjectServer();
    await objectServer.start();
  }, 120_000);

  afterAll(async () => {
    await objectServer?.close();
    await isolated?.dropSchema();
  });

  async function newApp(): Promise<ReturnType<typeof buildP03App>> {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: objectServer.url,
      attachmentsConfig: CONFIG,
    });
  }

  async function intentCount(): Promise<number> {
    const rows = await sql<{ count: string }>`select count(*)::text as count from upload_intents`.execute(isolated.runtime.db);
    return Number(rows.rows[0]!.count);
  }

  test('anonymous issue is rejected with authentication_required and creates no ledger row', async () => {
    const bundle = await newApp();
    try {
      const response = await bundle.app.inject({
        method: 'POST',
        url: '/api/v1/attachments/issue',
        headers: { origin: P03_ORIGIN, 'x-csrf-token': 'x'.repeat(43), 'known-command-id': randomUUID(), 'content-type': 'application/json' },
        payload: JSON.stringify(issueBody()),
      });
      assert.equal(response.statusCode, 401);
      assert.equal((response.json() as IssueProblem).error.code, 'authentication_required');
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(await intentCount(), 0);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('an owner issues a durable intent with ledger-before-grant ordering and zero secret leakage', async () => {
    const bundle = await newApp();
    try {
      const commandId = randomUUID();
      const response = await bundle.app.inject({
        method: 'POST',
        url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, commandId),
        payload: JSON.stringify(issueBody()),
      });
      assert.equal(response.statusCode, 201, response.body);
      const body = response.json() as {
        kind: string;
        receipt: { blobId: string; intentId: string; generationId: string };
        grant: { url: string; method: string; contentType: string; contentLength: number; expiresAt: string; ttlSeconds: number };
      };
      assert.equal(body.kind, 'issued');
      assert.equal(body.receipt.blobId.length, 64);
      assert.equal(body.receipt.intentId.length, 32);
      assert.equal(body.receipt.generationId.length, 32);
      assert.equal(body.grant.method, 'PUT');
      assert.equal(body.grant.contentType, 'image/png');
      assert.equal(body.grant.contentLength, 2048);
      assert.equal(body.grant.ttlSeconds, 60);
      assert.ok(Number.isFinite(Date.parse(body.grant.expiresAt)));
      // The grant URL is a REAL presigned URL signed by the production adapter
      // against the local object transport (never a fixed route grant).
      const grantUrl = new URL(body.grant.url);
      assert.equal(grantUrl.origin, objectServer.url);
      // The physical key is an independent ledger fact (never the
      // generationId); the grant must sign exactly the committed key.
      assert.ok(grantUrl.pathname.startsWith(`/${P03_BUCKET}/${P03_LIVE_PREFIX}`));
      const keySuffix = grantUrl.pathname.slice(`/${P03_BUCKET}/${P03_LIVE_PREFIX}`.length);
      assert.match(keySuffix, /^[a-f0-9]{32}$/u, 'the grant key suffix must be a 32-hex opaque key');
      assert.equal(grantUrl.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
      assert.ok(grantUrl.searchParams.get('X-Amz-Signature'), 'presigned signature must be present');

      // Ledger-before-grant: the durable row is committed and visible (DB
      // clock) at issue-response time, strictly before the external PUT.
      const ledger = await isolated.runtime.pool.query<{ created_at: Date; observed: Date; key: string }>(
        `select ui.created_at, clock_timestamp() as observed, bg.key from upload_intents ui
         join blob_generations bg on bg.generation_id = ui.generation_id
         where ui.intent_id = $1`,
        [body.receipt.intentId],
      );
      assert.equal(ledger.rowCount, 1);
      const row = ledger.rows[0]!;
      assert.ok(row.created_at.getTime() <= row.observed.getTime(), 'ledger row must be durable before the grant');
      assert.ok(row.key.startsWith(P03_LIVE_PREFIX));
      assert.equal(grantUrl.pathname, `/${P03_BUCKET}/${row.key}`, 'the grant must sign exactly the committed physical key');
      // No external PUT happened yet (grant is issued, not executed).
      assert.equal(objectServer.keyCount(), 0);
      assert.equal(objectServer.requests.filter((request) => request.method === 'PUT').length, 0);

      // Zero key/secret leakage: the grant URL and credentials never appear
      // in any ledger row, and the physical key is only the opaque ledger key.
      const dump = await sql`
        select ui.intent_id, ui.blob_id, ui.generation_id, ui.idempotency_key, ui.subject_identity,
               ui.collection_id, ui.expected_size, ui.expected_sha256, ui.media_hint, ui.policy_revision,
               bg.key, bg.bucket, bg.key_fingerprint
        from upload_intents ui join blob_generations bg on bg.generation_id = ui.generation_id
      `.execute(isolated.runtime.db);
      const serialized = JSON.stringify(dump.rows);
      assert.equal(serialized.includes(body.grant.url), false, 'grant URL must not be persisted');
      assert.equal(serialized.includes('X-Amz-Signature'), false);
      assert.equal(serialized.includes(P03_RW_CREDENTIAL.accessKeyId), false);
      assert.equal(serialized.includes(P03_RW_CREDENTIAL.secretAccessKey), false);
      assert.equal(serialized.includes(P03_RO_CREDENTIAL.accessKeyId), false);
      assert.equal(serialized.includes(P03_RO_CREDENTIAL.secretAccessKey), false);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('duplicate issue with the same Known-Command-Id recovers the same identity with a fresh grant', async () => {
    const bundle = await newApp();
    try {
      const before = await intentCount();
      const commandId = randomUUID();
      const first = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
      });
      assert.equal(first.statusCode, 201);
      const firstBody = first.json() as { kind: string; receipt: { blobId: string; intentId: string; generationId: string }; grant: { url: string } };

      // The real presigner stamps X-Amz-Date with second resolution: a replay
      // issued in the same wall-clock second produces a byte-identical URL.
      // Cross the second boundary so the fresh re-signing is deterministic
      // (the durable identity must NOT change).
      const firstSignedSecond = Math.floor(Date.now() / 1_000);
      await waitForCondition(
        () => Math.floor(Date.now() / 1_000) > firstSignedSecond,
        {
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          description: 'the presigner clock to cross its one-second timestamp resolution',
        },
      );
      const second = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
      });
      assert.equal(second.statusCode, 201);
      const secondBody = second.json() as { kind: string; receipt: { blobId: string; intentId: string; generationId: string }; grant: { url: string } };
      assert.equal(secondBody.kind, 'recovered');
      assert.deepEqual(secondBody.receipt, firstBody.receipt);
      assert.notEqual(secondBody.grant.url, firstBody.grant.url, 'each replay must receive a fresh signed URL');
      assert.equal(await intentCount(), before + 1, 'one intent per idempotency binding');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('concurrent issue with the same Known-Command-Id converges to a single identity', async () => {
    const bundle = await newApp();
    try {
      const before = await intentCount();
      const commandId = randomUUID();
      const [left, right] = await Promise.all([
        bundle.app.inject({
          method: 'POST', url: '/api/v1/attachments/issue',
          headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
        }),
        bundle.app.inject({
          method: 'POST', url: '/api/v1/attachments/issue',
          headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
        }),
      ]);
      assert.equal(left.statusCode, 201);
      assert.equal(right.statusCode, 201);
      const leftBody = left.json() as { kind: string; receipt: { blobId: string; intentId: string; generationId: string } };
      const rightBody = right.json() as { kind: string; receipt: { blobId: string; intentId: string; generationId: string } };
      assert.deepEqual(leftBody.receipt, rightBody.receipt, 'the loser recovers the winner identity');
      assert.ok([leftBody.kind, rightBody.kind].includes('issued'));
      assert.ok([leftBody.kind, rightBody.kind].includes('recovered'));
      assert.equal(await intentCount(), before + 1);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('members issue, outsiders and cross-Collection actors are denied with zero ledger rows', async () => {
    const bundle = await newApp();
    try {
      const before = await intentCount();
      for (const member of [editor, viewer]) {
        const response = await bundle.app.inject({
          method: 'POST', url: '/api/v1/attachments/issue',
          headers: mutationHeaders(member, randomUUID()), payload: JSON.stringify(issueBody()),
        });
        assert.equal(response.statusCode, 201, `${member.subjectId} must be admitted as a Collection member`);
      }
      const denied = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(outsider, randomUUID()), payload: JSON.stringify(issueBody()),
      });
      assert.equal(denied.statusCode, 403);
      assert.equal((denied.json() as IssueProblem).error.code, 'insufficient_permission');
      assert.equal(denied.headers['cache-control'], 'private, no-store');
      assert.equal(denied.headers['retry-after'], undefined);

      const crossCollection = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, randomUUID()),
        payload: JSON.stringify(issueBody({ collectionId: 'p03-foreign-collection' })),
      });
      assert.equal(crossCollection.statusCode, 403);
      assert.equal((crossCollection.json() as IssueProblem).error.code, 'insufficient_permission');
      assert.equal(await intentCount(), before + 2, 'only the two member issues created ledger rows');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('the durable admission switch stops issue before any ledger work and resume restores it', async () => {
    const bundle = await newApp();
    try {
      const before = await intentCount();
      const switchDeps = { store: createPostgresAttachmentsAdmissionSwitchStore(isolated.runtime), now: () => new Date() };
      const stopped = await stopAdmissionAndDrain(switchDeps, { reason: 'maintenance', operatorId: 'p03-operator', leaseTtlSeconds: 60 });
      assert.equal(stopped.outcome, 'stopped');
      try {
        const refused = await bundle.app.inject({
          method: 'POST', url: '/api/v1/attachments/issue',
          headers: mutationHeaders(owner, randomUUID()), payload: JSON.stringify(issueBody()),
        });
        assert.equal(refused.statusCode, 503);
        assert.equal((refused.json() as IssueProblem).error.code, 'rate_limit_unavailable');
        assert.equal(refused.headers['retry-after'], undefined, '503 must never fabricate a quota fact');
        assert.equal(await intentCount(), before, 'stopped admission creates no ledger rows');

        const resumed = await resumeAdmission(switchDeps, { operatorId: 'p03-operator' });
        assert.equal(resumed.outcome, 'resumed');
        const issued = await bundle.app.inject({
          method: 'POST', url: '/api/v1/attachments/issue',
          headers: mutationHeaders(owner, randomUUID()), payload: JSON.stringify(issueBody()),
        });
        assert.equal(issued.statusCode, 201);
        assert.equal(await intentCount(), before + 1);
      } finally {
        // Never leave admission stopped for the rest of the suite, even if an
        // assertion above fails mid-test.
        await resumeAdmission(switchDeps, { operatorId: 'p03-operator' }).catch(() => undefined);
      }
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('oversized and malformed inputs are rejected before any ledger work', async () => {
    const bundle = await newApp();
    try {
      const before = await intentCount();
      const cases: Array<{ body: unknown; expectedStatus: number; expectedCode: string }> = [
        { body: issueBody({ declaredSize: 6 * 1024 * 1024 }), expectedStatus: 413, expectedCode: 'payload_too_large' },
        { body: issueBody({ declaredSize: 64 * 1024 * 1024 + 1 }), expectedStatus: 413, expectedCode: 'payload_too_large' },
        { body: issueBody({ declaredSize: -1 }), expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: { ...issueBody(), declaredSize: undefined }, expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: { ...issueBody(), declaredSha256: 'xyz' }, expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: { ...issueBody(), mediaHint: 'text/html' }, expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: { ...issueBody(), extraField: 1 }, expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: { ...issueBody(), declaredSize: 1.5 }, expectedStatus: 422, expectedCode: 'invalid_document' },
        // Unified collectionId contract (KA-P4-AM-02): lengths above the
        // 256-char codec ceiling (257/512) and control characters are
        // rejected by the transport schema with a stable 422 BEFORE any
        // rate-limit or database work.
        { body: issueBody({ collectionId: 'c'.repeat(257) }), expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: issueBody({ collectionId: 'c'.repeat(512) }), expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: issueBody({ collectionId: 'ok\u0000nul' }), expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: issueBody({ collectionId: 'ok\nnewline' }), expectedStatus: 422, expectedCode: 'invalid_document' },
        { body: issueBody({ collectionId: '   ' }), expectedStatus: 422, expectedCode: 'invalid_document' },
      ];
      for (const entry of cases) {
        const response = await bundle.app.inject({
          method: 'POST', url: '/api/v1/attachments/issue',
          headers: mutationHeaders(owner, randomUUID()),
          payload: JSON.stringify(entry.body),
        });
        assert.equal(response.statusCode, entry.expectedStatus, JSON.stringify(entry.body));
        assert.equal((response.json() as IssueProblem).error.code, entry.expectedCode);
      }
      // Transport body budget (route-level 16 KiB) is enforced by the shared
      // product admission layer before the handler runs.
      const oversizedTransport = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, randomUUID()),
        payload: JSON.stringify({ ...issueBody(), padding: 'x'.repeat(20_000) }),
      });
      assert.equal(oversizedTransport.statusCode, 413);
      assert.equal((oversizedTransport.json() as IssueProblem).error.code, 'payload_too_large');
      // A missing Known-Command-Id is a 400 invalid_request.
      const missingCommand = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: { cookie: owner.cookie, origin: P03_ORIGIN, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
        payload: JSON.stringify(issueBody()),
      });
      assert.equal(missingCommand.statusCode, 400);
      assert.equal((missingCommand.json() as IssueProblem).error.code, 'invalid_request');
      assert.equal(await intentCount(), before, 'no rejected input may create a ledger row');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a client abort is safe: retrying the same Known-Command-Id converges to one durable intent', async () => {
    const bundle = await newApp();
    try {
      const before = await intentCount();
      const baseUrl = await listen(bundle.app);
      const commandId = randomUUID();
      const controller = new AbortController();
      let requestReachedResolve!: () => void;
      const requestReached = new Promise<void>((resolvePromise) => { requestReachedResolve = resolvePromise; });
      const observeRequest = (request: { readonly url?: string }): void => {
        if (request.url === '/api/v1/attachments/issue') requestReachedResolve();
      };
      bundle.app.server.on('request', observeRequest);
      const attempt = fetch(`${baseUrl}/api/v1/attachments/issue`, {
        method: 'POST',
        headers: mutationHeaders(owner, commandId),
        body: JSON.stringify(issueBody()),
        signal: controller.signal,
      }).then(
        () => undefined,
        () => undefined,
      );
      await requestReached;
      controller.abort();
      await attempt;
      bundle.app.server.off('request', observeRequest);
      // Whether or not the first attempt committed before the abort, the
      // durable identity is recovered by the retry (never duplicated).
      const retry = await bundle.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
      });
      assert.equal(retry.statusCode, 201, retry.body);
      assert.equal(await intentCount(), before + 1);
      assert.equal(objectServer.requests.some((request) => request.method === 'PUT'), false, 'abort must not trigger a PUT');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('API restart: an intent issued before restart is recovered by the same binding afterwards', async () => {
    const before = await intentCount();
    const first = await newApp();
    const commandId = randomUUID();
    let receipt: { blobId: string; intentId: string; generationId: string };
    try {
      const response = await first.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
      });
      assert.equal(response.statusCode, 201);
      receipt = (response.json() as { receipt: { blobId: string; intentId: string; generationId: string } }).receipt;
    } finally {
      await first.app.close();
      await first.store.close();
    }
    const second = await newApp();
    try {
      const replay = await second.app.inject({
        method: 'POST', url: '/api/v1/attachments/issue',
        headers: mutationHeaders(owner, commandId), payload: JSON.stringify(issueBody()),
      });
      assert.equal(replay.statusCode, 201);
      const body = replay.json() as { kind: string; receipt: { blobId: string; intentId: string; generationId: string } };
      assert.equal(body.kind, 'recovered');
      assert.deepEqual(body.receipt, receipt);
      assert.equal(await intentCount(), before + 1);
    } finally {
      await second.app.close();
      await second.store.close();
    }
  });
});
