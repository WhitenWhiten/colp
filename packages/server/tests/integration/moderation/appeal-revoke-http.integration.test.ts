import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresModerationCommandUnitOfWork,
  createPostgresModerationQueryPorts,
} from '../../../src/infrastructure/governance/postgres-moderation.js';
import { createPostgresModerationStore } from '../../../src/infrastructure/governance/postgres-moderation-store.js';
import { createPostgresModerationRoleUnitOfWork } from '../../../src/infrastructure/governance/postgres-moderation-roles.js';
import { GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME } from '../../../src/infrastructure/governance/postgres-moderation-outbox.js';
import {
  createGovernanceBookmarkControlRoutes,
  createGovernanceCollectionControlRoutes,
} from '../../../src/infrastructure/outbox/governance-collection-control.js';
import { grantModerationRole } from '../../../src/modules/governance/application/moderation-roles.js';
import {
  createSession,
  ensureAccountFromOidcIdentity,
  type IdentityUnitOfWork,
} from '../../../src/modules/identity/index.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { SESSION_COOKIE_NAME } from '../../../src/transport/session-cookie.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateFixtureTables,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const HMAC = Buffer.alloc(32, 17).toString('base64url');

type ApiApp = ReturnType<typeof buildApiApp>;
interface Client {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly accountId: string;
}

import { createAppealRevokeFixture } from './appeal-revoke-http-fixture.js';
describeWithPostgres('CG-07 appeal revoke HTTP', () => {
  const fixture = createAppealRevokeFixture();
  const { harness, grant, mutationHeaders, seedActions } = fixture;
  test('uphold revokes only the appealed action; reject keeps it; stranger cannot create', async () => {
    const { app, owner, stranger, moderator, reviewer } = await harness();
    await grant(moderator.accountId, 'moderator');
    await grant(reviewer.accountId, 'reviewer');
    const seeded = await seedActions(app, owner, moderator);

    const strangerCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'please restore this hide' },
    });
    assert.notEqual(strangerCreate.statusCode, 201);
    assert.ok(strangerCreate.statusCode === 403 || strangerCreate.statusCode === 404);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'please restore this hide' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const appeal = created.json() as Record<string, unknown>;
    assert.equal(typeof appeal.id, 'string');
    assert.equal(appeal.actionId, seeded.hide.id);
    assert.equal(appeal.status, 'submitted');
    assert.equal(appeal.resolution, null);
    assert.equal(Object.hasOwn(appeal, 'reporterAccountId'), false);
    assert.equal(Object.hasOwn(appeal, 'evidenceIds'), false);
    assert.equal(Object.hasOwn(appeal, 'appellantAccountId'), false);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'second open appeal' },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal((duplicate.json() as { error: { code: string } }).error.code, 'revision_conflict');

    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-appeals',
      headers: { cookie: owner.cookie },
    });
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal(((mine.json() as { items: unknown[] }).items.length), 1);

    const ownerGet = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/appeals/${appeal.id}`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerGet.statusCode, 200, ownerGet.body);
    assert.equal((ownerGet.json() as { id: string }).id, appeal.id);
    assert.ok(typeof ownerGet.headers.etag === 'string');

    const reviewerGet = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/appeals/${appeal.id}`,
      headers: { cookie: reviewer.cookie },
    });
    assert.equal(reviewerGet.statusCode, 200, reviewerGet.body);

    const strangerGet = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/appeals/${appeal.id}`,
      headers: { cookie: stranger.cookie },
    });
    // CG-F004: a stranger is concealed with 404 exactly like a missing
    // appeal — 403 here would make the endpoint an existence oracle.
    assert.equal(strangerGet.statusCode, 404);
    assert.equal((strangerGet.json() as { error: { code?: string } }).error.code, 'resource_not_found');

    const officialList = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/appeals?status=submitted',
      headers: { cookie: reviewer.cookie },
    });
    assert.equal(officialList.statusCode, 200, officialList.body);

    const strangerList = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/appeals',
      headers: { cookie: stranger.cookie },
    });
    assert.ok(strangerList.statusCode === 403 || strangerList.statusCode === 404);

    const missingIfMatch = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/appeals/${appeal.id}/decision`,
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: { decision: 'uphold', resolution: 'false positive hide' },
    });
    assert.notEqual(missingIfMatch.statusCode, 200);
    assert.equal(missingIfMatch.statusCode, 428);

    const reviewerDecide = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/appeals/${appeal.id}/decision`,
      headers: mutationHeaders(reviewer, crypto.randomUUID(), { 'if-match': String(created.headers.etag) }),
      payload: { decision: 'uphold', resolution: 'reviewer cannot decide' },
    });
    assert.equal(reviewerDecide.statusCode, 403);

    const staleIfMatch = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/appeals/${appeal.id}/decision`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': '"0"' }),
      payload: { decision: 'uphold', resolution: 'stale etag must not decide' },
    });
    assert.equal(staleIfMatch.statusCode, 412);

    const upheld = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/appeals/${appeal.id}/decision`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': String(created.headers.etag) }),
      payload: { decision: 'uphold', resolution: 'false positive hide' },
    });
    assert.equal(upheld.statusCode, 200, upheld.body);
    assert.equal((upheld.json() as { status: string }).status, 'upheld');

    const secondDecision = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/appeals/${appeal.id}/decision`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), {
        'if-match': String(upheld.headers.etag),
      }),
      payload: { decision: 'reject', resolution: 'already terminal' },
    });
    assert.equal(secondDecision.statusCode, 409);
    assert.equal((secondDecision.json() as { error: { code: string } }).error.code, 'revision_conflict');

    const visibility = await fixture.runtime.pool.query<{ visibility: string }>(
      `select visibility from collections where id=$1`,
      [seeded.collectionId],
    );
    assert.equal(visibility.rows[0]?.visibility, 'public');
    const ownerCatalog = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${seeded.collectionId}/catalog`,
      headers: { cookie: owner.cookie },
    });
    assert.equal(ownerCatalog.statusCode, 200, ownerCatalog.body);

    const hideAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/actions/${seeded.hide.id}`,
      headers: { cookie: moderator.cookie },
    });
    const delistAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/actions/${seeded.delist.id}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal((hideAfter.json() as { state: string }).state, 'revoked');
    assert.equal((delistAfter.json() as { state: string }).state, 'active');

    const rejectAppeal = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.delist.id, description: 'please restore delist' },
    });
    assert.equal(rejectAppeal.statusCode, 201, rejectAppeal.body);
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/moderation/appeals/${(rejectAppeal.json() as { id: string }).id}/decision`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), {
        'if-match': String(rejectAppeal.headers.etag),
      }),
      payload: { decision: 'reject', resolution: 'delist stands' },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    const delistKept = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/actions/${seeded.delist.id}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal((delistKept.json() as { state: string }).state, 'active');
  });

  test('case changes, revocations and appeal decisions all enforce the action budget before commands', async () => {
    const { app, moderator } = await harness(true, true);
    try {
      for (const [method, url] of [
        ['PATCH', '/api/v1/moderation/cases/opaque-case'],
        ['POST', '/api/v1/moderation/actions/opaque-action/revoke'],
        ['POST', '/api/v1/moderation/appeals/opaque-appeal/decision'],
      ] as const) {
        const response = await app.inject({ method, url,
          headers: mutationHeaders(moderator, crypto.randomUUID()), payload: {} });
        assert.equal(response.statusCode, 429, response.body);
        assert.equal(response.headers['retry-after'], '60');
      }
    } finally { await app.close(); }
  });

  test('create is limited to 10 appeals per account per 86400s', async () => {
    const { app, owner, moderator } = await harness();
    await grant(moderator.accountId, 'moderator');
    const seeded = await seedActions(app, owner, moderator);
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/moderation/appeals',
        headers: mutationHeaders(owner, crypto.randomUUID()),
        payload: { actionId: seeded.hide.id, description: 'please restore this hide' },
      });
      if (index === 0) assert.equal(response.statusCode, 201, response.body);
      else assert.equal(response.statusCode, 409, response.body);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'please restore this hide' },
    });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal((limited.json() as { error: { code: string } }).error.code, 'rate_limited');
  });

  test('feature off is 404 and no second worker consumer is registered', async () => {
    const { app, owner } = await harness(false);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: 'act_missing', description: 'should not write' },
    });
    assert.equal(created.statusCode, 404);
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-appeals',
      headers: { cookie: owner.cookie },
    });
    assert.equal(listed.statusCode, 404);
    const official = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/appeals',
      headers: { cookie: owner.cookie },
    });
    assert.equal(official.statusCode, 404);
    const byId = await app.inject({
      method: 'GET',
      url: '/api/v1/moderation/appeals/apl_missing',
      headers: { cookie: owner.cookie },
    });
    assert.equal(byId.statusCode, 404);
    const decide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals/apl_missing/decision',
      headers: mutationHeaders(owner, crypto.randomUUID(), { 'if-match': '"1"' }),
      payload: { decision: 'reject', resolution: 'feature off' },
    });
    assert.equal(decide.statusCode, 404);
    const collectionRoutes = createGovernanceCollectionControlRoutes({
      provider: { async purge() {} },
      publicationOrigin: ORIGIN,
      productOrigin: ORIGIN,
    });
    const bookmarkRoutes = createGovernanceBookmarkControlRoutes({
      provider: { async purge() {} },
      publicationOrigin: ORIGIN,
      productOrigin: ORIGIN,
    });
    assert.equal(new Set(collectionRoutes.map((route) => route.handlerName)).size, 1);
    assert.equal(collectionRoutes[0]?.handlerName, GOVERNANCE_COLLECTION_CONTROL_HANDLER_NAME);
    assert.equal(new Set(bookmarkRoutes.map((route) => route.handlerName)).size, 1);
    assert.equal(collectionRoutes.some((route) => route.eventType.includes('appeal')), false);
    assert.equal(bookmarkRoutes.some((route) => route.eventType.includes('appeal')), false);
  });

  test('expired evidence can be queried and recycled without a new worker consumer', async () => {
    const { app, owner, moderator } = await harness();
    await grant(moderator.accountId, 'moderator');
    const seeded = await seedActions(app, owner, moderator);
    const official = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${(await fixture.runtime.pool.query<{ id: string }>(
        `select case_id as id from moderation_actions where id=$1`,
        [seeded.hide.id],
      )).rows[0]!.id}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal(official.statusCode, 200, official.body);
    const evidenceId = (official.json() as { evidenceIds: string[] }).evidenceIds[0];
    assert.ok(evidenceId);
    const caseId = (official.json() as { case: { id: string } }).case.id;
    await fixture.runtime.pool.query(
      `update moderation_evidence set retain_until='1970-01-01T00:00:00.000Z' where id=$1`,
      [evidenceId],
    );
    const store = createPostgresModerationStore(fixture.runtime.db);
    const expired = await store.listExpiredEvidence(new Date('1970-01-02T00:00:00.000Z'), 10);
    assert.equal(expired.some((row) => row.id === evidenceId), true);
    const deleted = await store.recycleExpiredEvidence(new Date('1970-01-02T00:00:00.000Z'), 10);
    assert.equal(deleted >= 1, true);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/moderation/cases/${caseId}/evidence/${evidenceId}`,
      headers: { cookie: moderator.cookie },
    });
    assert.equal(gone.statusCode, 404);
  });

  test('appeal right survives the parent collection being deleted', async () => {
    const { app, owner, stranger, moderator } = await harness();
    await grant(moderator.accountId, 'moderator');
    const seeded = await seedActions(app, owner, moderator);

    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'please restore this hide' },
    });
    assert.equal(before.statusCode, 201, before.body);

    // Soft-delete the parent Collection with its root node in one transaction
// (the lifecycle triggers are deferrable): the action persists and the
// affected owner's right must not vanish with the live parent row.
    const client = await fixture.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `update nodes set deleted_at = now() where collection_id = $1 and is_root`, [seeded.collectionId],
      );
      await client.query(
        `update collections set deleted_at = now() where id = $1`, [seeded.collectionId],
      );
      await client.query('commit');
    } finally {
      client.release();
    }
    const afterDelete = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.delist.id, description: 'delist cannot be appealed after parent deletion' },
    });
    assert.equal(afterDelete.statusCode, 201, 'owner must keep the appeal right after parent deletion');
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/moderation-actions',
      headers: { cookie: owner.cookie },
    });
    assert.equal(mine.statusCode, 200, mine.body);
    const mineItems = (mine.json() as { items: Array<{ id: string }> }).items;
    assert.equal(mineItems.some((row) => row.id === seeded.hide.id), true,
      'deleted-parent actions must stay on the affected owner list');
    assert.equal(mineItems.some((row) => row.id === seeded.delist.id), true);

    const strangerAppeal = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { actionId: seeded.delist.id, description: 'stranger is not the affected owner' },
    });
    assert.equal(strangerAppeal.statusCode, 404, 'stranger is not affected by the deleted-parent action');
  });

  test('appeal right stays with the snapshot owner after ownership transfer', async () => {
    const { app, owner, stranger, moderator } = await harness();
    await grant(moderator.accountId, 'moderator');
    const seeded = await seedActions(app, owner, moderator);

    // Transfer the Collection to the stranger: the action was decided against
    // the original owner, so the original owner keeps the appeal right and the
    // new owner does not inherit it.
    await fixture.runtime.pool.query(
      `update collections
          set owner_subject_id = (select a2.subject_id from accounts a2 where a2.id = $2)
        where id = $1`,
      [seeded.collectionId, stranger.accountId],
    );
    const oldOwnerAppeal = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'original owner appeals the hide' },
    });
    assert.equal(oldOwnerAppeal.statusCode, 201, oldOwnerAppeal.body);
    const newOwnerAppeal = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(stranger, crypto.randomUUID()),
      payload: { actionId: seeded.delist.id, description: 'new owner is not the snapshot owner' },
    });
    assert.equal(newOwnerAppeal.statusCode, 404, 'transferred-in owner must not inherit the appeal right');
  });
});
