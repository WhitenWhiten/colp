/**
 * P4A-P04 focused PostgreSQL suite (part 1): status route authorization,
 * concealment, workload, headers, and side-effect freedom.
 *
 * Boots the PRODUCTION app composition (`buildApiApp`) with the REAL
 * PostgreSQL attachments ports and drives blobs through the production ledger
 * ports into genuine states. Every request goes through the real route with a
 * real session cookie.
 *
 * Covers: owner visibility vs member non-owner / outsider / anonymous /
 * revoked owner / cross-Collection concealment, real-ID guessing
 * (byte-identical 404 vs nonexistent), query-count workload equality (the
 * existence side channel), `private, no-store` on every response, query
 * parameter rejection (no pagination surface), no ETag surface, zero
 * per-ID write side effects, and the query plan.
 *
 * Anti-false-positive: a nonexistent ID alone, an empty DTO, or a mocked
 * authorization can never satisfy these assertions — every 404 is compared
 * against a REAL foreign blobId and the owner 200 path asserts the exact
 * frozen DTO shape against a REAL ledger row.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
  type AuthenticatedTestClient,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  P03_ORIGIN,
  buildP03App,
  makeP03Config,
  seedP03Collection,
} from '../../support/phase4a-p03-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccessPolicyWritePort } from '../../../src/infrastructure/access-policy/index.js';
import { createAttachmentRouteRateLimitFacade } from '../../../src/infrastructure/rate-limit/index.js';
import {
  ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
  rateLimitSubjectHmac,
  type AttachmentRateLimitConfig,
  type AttachmentRouteRateLimitFacade,
  type RateLimitCheckInput,
  type RateLimitStore,
  type RateLimitStoreOutcome,
  type RateLimitStoreReadiness,
} from '../../../src/modules/attachments/index.js';
import { identityFor } from '../../support/phase4a-i07-test-helpers.js';
import {
  P04_COLLECTION_A,
  P04_COLLECTION_B,
  P04_DECLARED_SIZE,
  instrumentP04QueryCounter,
  seedP04Issued,
  type P04QueryCounter,
} from '../../support/phase4a-p04-test-helpers.js';

const NOW = new Date('2026-08-08T12:00:00.000Z');

interface StatusProblem {
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

const CONCEALED_404 = {
  code: 'resource_not_found',
  message: 'The requested Attachment resource was not found.',
  recovery: 'none',
  sameRequestRetrySafe: false,
  precondition: null,
  currentEtag: null,
  retryAfterSeconds: null,
  fieldErrors: [],
} as const;

function assertConcealed404(response: { statusCode: number; headers: Record<string, unknown>; body: string }): StatusProblem['error'] {
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(typeof response.headers['x-request-id'], 'string');
  const problem = (JSON.parse(response.body) as StatusProblem).error;
  assert.deepEqual(
    {
      code: problem.code,
      message: problem.message,
      recovery: problem.recovery,
      sameRequestRetrySafe: problem.sameRequestRetrySafe,
      precondition: problem.precondition,
      currentEtag: problem.currentEtag,
      retryAfterSeconds: problem.retryAfterSeconds,
      fieldErrors: problem.fieldErrors,
    },
    CONCEALED_404,
    'every concealed 404 must carry the identical stable external Problem',
  );
  assert.equal(problem.requestId, response.headers['x-request-id']);
  return problem;
}

function getStatus(bundle: ReturnType<typeof buildP03App>, blobId: string, cookie?: string) {
  return bundle.app.inject({
    method: 'GET',
    url: `/api/v1/attachments/${encodeURIComponent(blobId)}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
}

describeWithPostgres('P4A-P04 production status route: authorization and concealment', () => {
  let isolated: I07MigrationRuntime;
  let identityUnitOfWork: ReturnType<typeof createIdentityMemoryUnitOfWork>;
  let factory: ReturnType<typeof createInMemoryBetterAuthTestFactory>;
  let owner: AuthenticatedTestClient;
  let editor: AuthenticatedTestClient;
  let viewer: AuthenticatedTestClient;
  let outsider: AuthenticatedTestClient;
  let revokee: AuthenticatedTestClient;
  let counter: P04QueryCounter;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('phase4a_p04_status', { maxConnections: 12 });
    counter = instrumentP04QueryCounter(isolated.runtime);
    identityUnitOfWork = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
    owner = await issueTestSession({
      factory,
      subject: 'p04-owner', handle: 'p04_owner' });
    editor = await issueTestSession({
      factory,
      subject: 'p04-editor', handle: 'p04_editor' });
    viewer = await issueTestSession({
      factory,
      subject: 'p04-viewer', handle: 'p04_viewer' });
    outsider = await issueTestSession({
      factory,
      subject: 'p04-outsider', handle: 'p04_outsider' });
    revokee = await issueTestSession({
      factory,
      subject: 'p04-revokee', handle: 'p04_revokee' });
    await seedP03Collection(isolated.runtime, {
      collectionId: P04_COLLECTION_A,
      ownerSubjectId: owner.subjectId,
      members: [
        { subjectId: owner.subjectId, role: 'owner' },
        { subjectId: editor.subjectId, role: 'editor' },
        { subjectId: viewer.subjectId, role: 'viewer' },
        { subjectId: revokee.subjectId, role: 'editor' },
      ],
    });
    await seedP03Collection(isolated.runtime, {
      collectionId: P04_COLLECTION_B,
      ownerSubjectId: outsider.subjectId,
      members: [
        { subjectId: outsider.subjectId, role: 'owner' },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  function newApp(options: { readonly rateLimit?: AttachmentRouteRateLimitFacade } = {}): ReturnType<typeof buildP03App> {
    return buildP03App({
      runtime: isolated.runtime,
      databaseUrl: isolated.databaseUrl,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      objectServerUrl: 'http://127.0.0.1:1',
      attachmentsConfig: makeP03Config(),
      ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    });
  }

  async function seedOwnedBlob(
    client: AuthenticatedTestClient,
    slot: number,
    collectionId = P04_COLLECTION_A,
  ) {
    const id = identityFor(slot);
    await seedP04Issued(isolated.runtime, id, {
      owner: { subjectId: client.subjectId, principalId: client.accountId },
      collectionId,
      declaredSize: P04_DECLARED_SIZE,
    });
    return id;
  }

  test('anonymous status reads are concealed 404 with zero database work, for real and fake identities', async () => {
    const bundle = newApp();
    try {
      const real = await seedOwnedBlob(owner, 1);
      const before = counter.snapshot();
      const realResponse = await getStatus(bundle, real.blobId);
      const fakeResponse = await getStatus(bundle, `nobody-${randomUUID()}`);
      assertConcealed404(realResponse);
      assertConcealed404(fakeResponse);
      assert.equal(counter.selectDelta(before), 0, 'anonymous reads must never touch PostgreSQL');
      assert.equal(realResponse.headers['set-cookie'], undefined);
      assert.equal(realResponse.headers['location'], undefined);
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('the owner reads a real blob with the frozen DTO shape and exactly three SELECTs', async () => {
    const bundle = newApp();
    try {
      const id = await seedOwnedBlob(owner, 2);
      const before = counter.snapshot();
      const response = await getStatus(bundle, id.blobId, owner.cookie);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(typeof response.headers['x-request-id'], 'string');
      assert.equal(response.headers['etag'], undefined, 'the frozen status contract carries no ETag');
      assert.equal(response.headers['location'], undefined, 'a status read never redirects');
      const body = response.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), [
        'blobId', 'logicalState', 'verificationStatus', 'availability',
        'size', 'mediaType', 'createdAt', 'updatedAt', 'allowedActions',
      ], 'the status body must expose exactly the frozen DTO fields');
      assert.equal(body.blobId, id.blobId);
      assert.equal(body.logicalState, 'issued');
      assert.equal(body.verificationStatus, 'pending');
      assert.equal(body.availability, 'unavailable');
      assert.equal(body.size, 2048);
      assert.equal(body.mediaType, 'image/png');
      assert.deepEqual(body.allowedActions, ['complete']);
      const createdAt = String(body.createdAt);
      const updatedAt = String(body.updatedAt);
      assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, 'createdAt must be ISO-8601 UTC');
      assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, 'updatedAt must be ISO-8601 UTC');
      assert.ok(createdAt <= updatedAt, 'createdAt must never follow updatedAt');
      assert.ok(Date.parse(createdAt) >= Date.parse('2026-08-01T00:00:00.000Z'), 'createdAt must be a real DB-clock time');
      // No digest/key/URL/generation/lease vocabulary in the body.
      const serialized = JSON.stringify(body);
      for (const forbidden of [id.generationId, id.intentId, id.key, 'X-Amz', 'sha256',
        'https://', 'lease', 'filename', 'bucket', 'etag']) {
        assert.equal(serialized.includes(forbidden), false, `the DTO must not leak ${forbidden}`);
      }
      assert.equal(counter.selectDelta(before), 3,
        'the owner read is blob status, collection header, and membership');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('member non-owner, outsider, and cross-Collection requests are identical concealed 404s', async () => {
    const bundle = newApp();
    try {
      const ownerBlob = await seedOwnedBlob(owner, 3);
      const editorBlob = await seedOwnedBlob(editor, 4);
      const foreignBlob = await seedOwnedBlob(outsider, 5, P04_COLLECTION_B);
      // The owner UPLOADED into collection B but holds no CURRENT membership
      // there (the collection belongs to the outsider): the cross-Collection
      // read must be concealed exactly like a nonexistent blob — the owner
      // binding alone is never enough, authorization is re-read every time.
      const crossCollection = await seedOwnedBlob(owner, 6, P04_COLLECTION_B);

      // Expected SELECT count per denied identity: the status-facts read is
      // always exactly one. Only the cross-Collection OWNER (owner binding
      // matches, so the blob cannot be faked) additionally authorizes via
      // collection header plus CURRENT membership (the whole point of the
      // case: the immutable owner binding alone is never enough). That
      // 3-vs-1 difference cannot be an existence side channel — only the
      // subject who already owns the blob can ever observe it.
      const denied: Array<[string, string, string, number]> = [
        ['member non-owner', ownerBlob.blobId, editor.cookie, 1],
        ['viewer non-owner', ownerBlob.blobId, viewer.cookie, 1],
        ['outsider', ownerBlob.blobId, outsider.cookie, 1],
        ['cross-Collection owner', crossCollection.blobId, owner.cookie, 3],
        ['owner vs foreign blob', foreignBlob.blobId, owner.cookie, 1],
        ['cross-Collection owner vs editor blob', editorBlob.blobId, outsider.cookie, 1],
      ];
      for (const [label, blobId, cookie, expectedSelects] of denied) {
        const before = counter.snapshot();
        const response = await getStatus(bundle, blobId, cookie);
        assertConcealed404(response);
        assert.equal(counter.selectDelta(before), expectedSelects,
          `${label} must run exactly ${expectedSelects} SELECT${expectedSelects === 1 ? '' : 's'} before the concealed 404`);
      }
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('real-ID guessing: a foreign subject sees a byte-identical 404 for a real blobId and a random one', async () => {
    const bundle = newApp();
    try {
      const id = await seedOwnedBlob(owner, 7);
      const before = counter.snapshot();
      const real = await getStatus(bundle, id.blobId, editor.cookie);
      const fake = await getStatus(bundle, `${id.blobId}-does-not-exist`, editor.cookie);
      const realProblem = assertConcealed404(real);
      const fakeProblem = assertConcealed404(fake);
      assert.deepEqual({ ...realProblem, requestId: '' }, { ...fakeProblem, requestId: '' },
        'a guessed real blobId must be indistinguishable from a nonexistent one');
      assert.equal(real.headers['cache-control'], fake.headers['cache-control']);
      assert.equal(counter.selectDelta(before), 2,
        'real and nonexistent reads must run the same bounded workload (1 SELECT each)');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('a revoked owner loses visibility with the same concealed 404 and regains it on re-grant', async () => {
    const bundle = newApp();
    try {
      const id = await seedOwnedBlob(revokee, 8);
      assert.equal((await getStatus(bundle, id.blobId, revokee.cookie)).statusCode, 200);

      await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
        const removed = await createPostgresAccessPolicyWritePort(transaction).deleteMembership({
          collectionId: P04_COLLECTION_A,
          subjectId: revokee.subjectId,
        });
        assert.equal(removed, true);
      });
      const revoked = await getStatus(bundle, id.blobId, revokee.cookie);
      const fake = await getStatus(bundle, `${id.blobId}-missing`, revokee.cookie);
      const revokedProblem = assertConcealed404(revoked);
      const fakeProblem = assertConcealed404(fake);
      assert.deepEqual({ ...revokedProblem, requestId: '' }, { ...fakeProblem, requestId: '' },
        'a revoked owner must be indistinguishable from a nonexistent blob');

      await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
        await createPostgresAccessPolicyWritePort(transaction).insertMembership({
          collectionId: P04_COLLECTION_A,
          subjectId: revokee.subjectId,
          role: 'editor',
          grantedAt: new Date(),
        });
      });
      const restored = await getStatus(bundle, id.blobId, revokee.cookie);
      assert.equal(restored.statusCode, 200, 're-granted membership restores owner visibility');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('query parameters are rejected (no pagination surface) with the stable 400 envelope', async () => {
    const bundle = newApp();
    try {
      const id = await seedOwnedBlob(owner, 9);
      for (const query of ['?cursor=abc', '?page=2', '?limit=10&offset=0']) {
        const response = await bundle.app.inject({
          method: 'GET',
          url: `/api/v1/attachments/${encodeURIComponent(id.blobId)}${query}`,
          headers: { cookie: owner.cookie },
        });
        assert.equal(response.statusCode, 400, query);
        assert.equal((response.json() as StatusProblem).error.code, 'invalid_request', query);
        assert.equal(response.headers['cache-control'], 'private, no-store', query);
      }
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('invalid identifiers are concealed 404 and oversize ones are transport-rejected, both with zero database work', async () => {
    const bundle = newApp();
    try {
      const before = counter.snapshot();
      // Control characters never reach the SQL layer: the use case rejects
      // them and the route conceals with the stable 404 envelope.
      const whitespace = await getStatus(bundle, '\t\t', owner.cookie);
      assertConcealed404(whitespace);
      // Identities longer than Fastify's router cap (maxParamLength=128) can
      // never match any route param: the router rejects them with the uniform
      // 414 transport rejection BEFORE session resolution or any SQL — for
      // every identity alike (no real blobId can exceed the cap, so the 414
      // carries no existence signal; it is the same rejection a nonexistent
      // route would receive).
      const oversize = await getStatus(bundle, 'a'.repeat(600), owner.cookie);
      assert.equal(oversize.statusCode, 414, 'oversize identities are rejected at the transport boundary');
      assert.equal(counter.selectDelta(before), 0, 'invalid identities must be rejected before any SQL');
      // The 414 is identity-independent: an anonymous request with the same
      // oversize identity receives the same transport rejection.
      const anonymousOversize = await getStatus(bundle, 'a'.repeat(600));
      assert.equal(anonymousOversize.statusCode, 414);
      assert.equal(counter.selectDelta(before), 0, 'oversize reads must never touch PostgreSQL for any identity');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('status reads are side-effect free and add no per-ID response surface', async () => {
    const bundle = newApp();
    try {
      const id = await seedOwnedBlob(owner, 10);
      const counts = async () => {
        const rows = await sql<{ operations: string; audit: string; outbox: string }>`
          select
            (select count(*)::text from operations) as operations,
            (select count(*)::text from audit_events) as audit,
            (select count(*)::text from outbox_events) as outbox
        `.execute(isolated.runtime.db);
        return rows.rows[0]!;
      };
      const before = await counts();
      const responses = [
        await getStatus(bundle, id.blobId, owner.cookie),
        await getStatus(bundle, id.blobId, editor.cookie),
        await getStatus(bundle, id.blobId),
        await getStatus(bundle, `${id.blobId}-nope`, owner.cookie),
      ];
      const after = await counts();
      assert.deepEqual(after, before, 'a read must never create Operation/Audit/Outbox rows');
      assert.equal(responses[0]!.statusCode, 200);
      for (const response of responses.slice(1)) {
        assertConcealed404(response);
      }
      const serialized = responses.map((response) => response.body).join('\n');
      for (const forbidden of [id.generationId, id.intentId, id.key, 'X-Amz', 'https://', 'lease']) {
        assert.equal(serialized.includes(forbidden), false, `no response may carry ${forbidden}`);
      }
    } finally {
      await bundle.app.close();
      await bundle.store.close();
    }
  });

  test('query plan: the status read resolves blob/generation/intent/metadata through indexes', async () => {
    const id = await seedOwnedBlob(owner, 11);
    await seedP04Issued(isolated.runtime, identityFor(12), {
      owner: { subjectId: owner.subjectId, principalId: owner.accountId },
    });
    const plan = await sql<{ 'QUERY PLAN': string }>`
      explain
      select br.owner_subject_id, br.logical_state, br.current_generation_id,
             br.verified_size::text, br.media_type, br.created_at, br.updated_at,
             bg.generation_state as current_generation_state,
             ui.collection_id, ui.expected_size::text, ui.media_hint,
             a.logical_state as attachment_logical_state
      from blob_records br
      left join blob_generations bg on bg.generation_id = br.current_generation_id
      left join upload_intents ui on ui.blob_id = br.blob_id
        and (br.current_generation_id is null or ui.generation_id = br.current_generation_id)
      left join attachments a on a.blob_id = br.blob_id
      where br.blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.ok(!/Seq Scan/u.test(text), 'the status read must never Seq Scan');
    assert.match(text, /Index (?:Only )?Scan.*blob_records_pkey/u,
      'the read must resolve through the blob primary key');
  });

  // -------------------------------------------------------------------------
  // FIX-L-051 status admission budget (KA-P4-AM-16): the owner-private read
  // is admission-limited on a STABLE per-principal budget BEFORE any
  // repository work; anonymous requests stay cheap and never consume it.
  // -------------------------------------------------------------------------

  const STATUS_BUDGET_SECRET = Buffer.from('p04-status-budget-integration-secret', 'utf8');

  /** Bounded scripted store: per-principal fixed-window budget, no Redis. */
  class ScriptedStatusBudgetStore implements RateLimitStore {
    readonly checks: Array<{ routeClass: string; principalId: string; scope: string }> = [];
    private readonly counts = new Map<string, number>();
    constructor(
      private readonly rateMax: number,
      private readonly rateWindowMs: number,
      private readonly now: () => number,
    ) {}

    async check(input: RateLimitCheckInput): Promise<RateLimitStoreOutcome> {
      this.checks.push({
        routeClass: input.routeClass,
        principalId: input.subject.principalId,
        scope: input.subject.scope,
      });
      const nowMs = input.nowEpochMs ?? this.now();
      const windowStart = Math.floor(nowMs / this.rateWindowMs) * this.rateWindowMs;
      const key = `${input.subject.principalId}\u0000${input.subject.scope}\u0000${windowStart}`;
      const count = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, count);
      const allowed = count <= this.rateMax;
      return Object.freeze({
        kind: allowed ? 'allowed' : 'denied',
        decision: Object.freeze({
          allowed,
          remaining: allowed ? this.rateMax - count : 0,
          retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((windowStart + this.rateWindowMs - nowMs) / 1000)),
          windowStartEpochMs: windowStart,
        }),
      });
    }

    readiness(): RateLimitStoreReadiness {
      return Object.freeze({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: this.now() });
    }

    close(): Promise<void> {
      return Promise.resolve();
    }
  }

  function makeStatusBudgetConfig(rateMax: number): AttachmentRateLimitConfig {
    return Object.freeze({
      mode: 'enforce',
      required: false,
      redisUrl: 'redis://127.0.0.1:6379',
      keySecretRef: 'known/p04/status/hmac',
      keyPrefix: 'p04-status',
      commandTimeoutMs: 75,
      connectTimeoutMs: 1000,
      maxRetriesPerRequest: 1,
      routes: Object.freeze({
        issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
        complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
        download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
        status: Object.freeze({ rateMax, rateWindowMs: 60000 }),
      }),
      completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
    });
  }

  test('an exhausted status budget stops the repository BEFORE the read: stable 429, zero new SELECTs, per-principal and blobId-independent', async () => {
    const store = new ScriptedStatusBudgetStore(2, 60_000, () => NOW.getTime());
    const facade = createAttachmentRouteRateLimitFacade({
      config: makeStatusBudgetConfig(2),
      store,
      subjectKeyFor: (subject) => rateLimitSubjectHmac(STATUS_BUDGET_SECRET, subject),
      now: () => NOW.getTime(),
    });
    const bundle = newApp({ rateLimit: facade });
    try {
      const blobA = await seedOwnedBlob(owner, 20);
      const blobB = await seedOwnedBlob(owner, 21);
      const before = counter.snapshot();
      // Two allowed reads of DIFFERENT blobIds share ONE per-principal budget:
      // a rotatable blobId must never mint a fresh bucket (KA-P4-AM-16).
      const first = await getStatus(bundle, blobA.blobId, owner.cookie);
      assert.equal(first.statusCode, 200, first.body);
      const second = await getStatus(bundle, blobB.blobId, owner.cookie);
      assert.equal(second.statusCode, 200, second.body);
      // The third read (any blobId) is exhausted BEFORE the repository.
      const third = await getStatus(bundle, blobA.blobId, owner.cookie);
      assert.equal(third.statusCode, 429, third.body);
      assert.equal(third.headers['cache-control'], 'private, no-store');
      const problem = (JSON.parse(third.body) as StatusProblem).error;
      assert.equal(problem.code, 'rate_limited');
      assert.equal(problem.recovery, 'refresh_and_retry');
      assert.equal(problem.sameRequestRetrySafe, true);
      assert.ok(typeof problem.retryAfterSeconds === 'number' && problem.retryAfterSeconds > 0,
        'the 429 must carry the real Retry-After quota fact');
      assert.equal(third.headers['retry-after'], String(problem.retryAfterSeconds),
        'the Retry-After header must equal the Problem retryAfterSeconds');
      assert.equal(third.headers['ratelimit-policy'], 'attachments-status:2:60000',
        'the frozen RateLimit-Policy header must name the status route class');
      // Exactly the two allowed reads reached PostgreSQL (3 SELECTs each:
      // blob status, collection header, membership); the denied read added
      // ZERO repository work.
      assert.equal(counter.selectDelta(before), 6,
        'the exhausted read must be denied before any repository work');
      // The admission subject is the STABLE principal with the FIXED route
      // scope for every blobId — blob identity never enters the limiter.
      assert.deepEqual(store.checks, [
        { routeClass: 'status', principalId: owner.accountId, scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE },
        { routeClass: 'status', principalId: owner.accountId, scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE },
        { routeClass: 'status', principalId: owner.accountId, scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE },
      ]);
      // A DIFFERENT principal keeps its own budget: the editor is not blocked
      // by the owner's exhaustion and still reaches the repository (1 SELECT
      // before its concealed 404).
      const editorBefore = counter.snapshot();
      const editorRead = await getStatus(bundle, blobA.blobId, editor.cookie);
      assertConcealed404(editorRead);
      assert.equal(counter.selectDelta(editorBefore), 1,
        'a distinct principal must be isolated from the owner budget');
      assert.deepEqual(store.checks.at(-1), {
        routeClass: 'status',
        principalId: editor.accountId,
        scope: ATTACHMENT_RATE_LIMIT_FIXED_SCOPE,
      });
      // The ANONYMOUS path stays the cheap concealed 404 with ZERO database
      // work and never consults or consumes the authenticated budget.
      const anonymousBefore = counter.snapshot();
      const anonymousRead = await getStatus(bundle, blobA.blobId);
      assertConcealed404(anonymousRead);
      assert.equal(counter.selectDelta(anonymousBefore), 0,
        'anonymous reads must never touch PostgreSQL');
      assert.equal(store.checks.length, 4,
        'the anonymous request must never enter the admission budget');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
      await facade.close();
    }
  });

  test('a failed status admission store fails closed: 503 rate_limit_unavailable with zero database work', async () => {
    const failing: RateLimitStore = {
      check: async () => Object.freeze({
        kind: 'failed',
        failure: Object.freeze({ class: 'unavailable', code: 'rate_limit_unavailable' }),
      }),
      readiness: () => Object.freeze({
        status: 'degraded',
        reason: 'last_command_failed',
        lastCheckedAtEpochMs: NOW.getTime(),
      }),
      close: async () => undefined,
    };
    const facade = createAttachmentRouteRateLimitFacade({
      config: makeStatusBudgetConfig(2),
      store: failing,
      subjectKeyFor: (subject) => rateLimitSubjectHmac(STATUS_BUDGET_SECRET, subject),
      now: () => NOW.getTime(),
    });
    const bundle = newApp({ rateLimit: facade });
    try {
      const id = await seedOwnedBlob(owner, 22);
      const before = counter.snapshot();
      const response = await getStatus(bundle, id.blobId, owner.cookie);
      assert.equal(response.statusCode, 503, response.body);
      assert.equal((JSON.parse(response.body) as StatusProblem).error.code, 'rate_limit_unavailable');
      assert.equal(response.headers['retry-after'], undefined,
        'a 503 must never carry a fabricated Retry-After quota fact');
      assert.equal(counter.selectDelta(before), 0,
        'the fail-closed 503 must happen before any repository work');
    } finally {
      await bundle.app.close();
      await bundle.store.close();
      await facade.close();
    }
  });

  test('the route remains closed (503 attachments_not_implemented) without the P04 composition', async () => {
    // Reuse the P01 closed-mount pattern: an app without attachmentRoutes deps
    // must keep the explicit closed state for the status route.
    const { buildApiApp } = await import('../../../src/transport/app.js');
    const { loadConfig } = await import('../../support/test-config.js');
    const { alwaysReady } = await import('../../../src/infrastructure/health.js');
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      PRODUCT_ORIGIN: P03_ORIGIN,
      ALLOWED_ORIGINS: P03_ORIGIN,
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      readiness: alwaysReady,
      identityUnitOfWork,
      browserSessionAuthority: factory.authority,
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/attachments/${identityFor(13).blobId}`,
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, 503);
      assert.equal((response.json() as StatusProblem).error.code, 'attachments_not_implemented');
      assert.equal(response.headers['cache-control'], 'private, no-store');
    } finally {
      await app.close();
    }
  });
});
