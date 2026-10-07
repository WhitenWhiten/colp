import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config.js';
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
describeWithPostgres('governance receipt HTTP recovery', () => {
  const fixture = createAppealRevokeFixture();
  const { harness, grant, mutationHeaders, seedActions } = fixture;
  test('exact governance receipts replay after state changes; new intents and revoked access still reject', async () => {
    const { app, owner, moderator } = await harness();
    await grant(moderator.accountId, 'moderator');
    const seeded = await seedActions(app, owner, moderator);
    const caseRow = await fixture.runtime.pool.query('select case_id from moderation_actions where id=$1', [seeded.hide.id]);
    const caseId = caseRow.rows[0].case_id as string;
    const caseRead = await app.inject({ method: 'GET', url: `/api/v1/moderation/cases/${caseId}`, headers: { cookie: moderator.cookie } });
    const caseRequest = {
      method: 'PATCH' as const, url: `/api/v1/moderation/cases/${caseId}`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': String(caseRead.headers.etag) }),
      payload: { internalNote: 'receipt recovery' },
    };
    const appealRequest = {
      method: 'POST' as const, url: '/api/v1/moderation/appeals',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { actionId: seeded.hide.id, description: 'please restore this collection' },
    };
    const appeal = await app.inject(appealRequest);
    assert.equal(appeal.statusCode, 201, appeal.body);
    const decisionRequest = {
      method: 'POST' as const, url: `/api/v1/moderation/appeals/${appeal.json().id}/decision`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': String(appeal.headers.etag) }),
      payload: { decision: 'uphold', resolution: 'false positive hide' },
    };
    const revokeRequest = {
      method: 'POST' as const, url: `/api/v1/moderation/actions/${seeded.delist.id}/revoke`,
      headers: mutationHeaders(moderator, crypto.randomUUID(), { 'if-match': '"1"' }),
      payload: { reason: 'false positive delist' },
    };
    async function durableState() {
      return (await fixture.runtime.pool.query(`select
        (select count(*) from audit_events) as audits,
        (select count(*) from outbox_events) as outbox,
        (select jsonb_agg(to_jsonb(a) order by id) from moderation_actions a) as actions,
        (select jsonb_agg(to_jsonb(a) order by id) from moderation_appeals a) as appeals,
        (select jsonb_agg(to_jsonb(a) order by id) from moderation_cases a) as cases`)).rows;
    }
    for (const request of [caseRequest, decisionRequest, revokeRequest]) {
      const first = await app.inject(request);
      assert.equal(first.statusCode, 200, first.body);
      const before = await durableState();
      const retry = await app.inject(request);
      assert.equal(retry.statusCode, first.statusCode, retry.body);
      assert.deepEqual(retry.json(), first.json());
      assert.equal(retry.headers.etag, first.headers.etag);
      assert.deepEqual(await durableState(), before);
      const stale = await app.inject({ ...request, headers: { ...request.headers, 'known-command-id': crypto.randomUUID() } });
      assert.equal(stale.statusCode, 412, stale.body);
      const changed = await app.inject({ ...request, payload: { ...request.payload, ...('reason' in request.payload ? { reason: 'changed intent' } : 'resolution' in request.payload ? { resolution: 'changed intent' } : { internalNote: 'changed intent' }) } });
      assert.equal(changed.statusCode, 409, changed.body);
    }
    const beforeAppealReplay = await durableState();
    const appealRetry = await app.inject(appealRequest);
    assert.equal(appealRetry.statusCode, 201, appealRetry.body);
    assert.deepEqual(appealRetry.json(), appeal.json());
    assert.equal(appealRetry.headers.etag, appeal.headers.etag);
    assert.deepEqual(await durableState(), beforeAppealReplay);
    const changedAppeal = await app.inject({ ...appealRequest, payload: { ...appealRequest.payload, description: 'changed appeal' } });
    assert.equal(changedAppeal.statusCode, 409, changedAppeal.body);
    await fixture.runtime.pool.query('delete from moderation_roles where account_id=$1', [moderator.accountId]);
    for (const request of [caseRequest, decisionRequest, revokeRequest]) {
      const denied = await app.inject(request);
      assert.equal(denied.statusCode, 403, denied.body);
    }
    await app.close();
  });


});
