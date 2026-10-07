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

export function createAppealRevokeFixture() {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('moderation_cg07');
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
  }, 120_000);

  beforeEach(async () => {
    await truncateFixtureTables(runtime.pool, `truncate table moderation_appeals, moderation_actions, moderation_evidence, moderation_cases, moderation_roles,
      catalog_preferences, product_command_receipts, outbox_events, audit_events,
      operations, policy_revisions, content_revisions, children_revisions, resource_revisions,
      collection_policies, collection_members, nodes, collections, resource_id_ledger,
      oidc_login_transactions, sessions, account_identities, profile_handles, profiles, accounts cascade`);
  });

  afterAll(async () => isolated?.close());

  async function harness(enabled = true, denyActions = false): Promise<{
    app: ApiApp;
    owner: Client;
    stranger: Client;
    moderator: Client;
    reviewer: Client;
  }> {
    const config = loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_CONTENT_GOVERNANCE: enabled ? 'true' : 'false',
      ...(enabled ? { GOVERNANCE_CURSOR_HMAC_KEY: HMAC } : {}),
    });
    const identityUnitOfWork = createPostgresIdentityUnitOfWork(runtime.db);
    const owner = await issueSession(identityUnitOfWork, {
      subject: 'cg07-owner', email: 'owner@example.test', handle: 'cg07owner',
    });
    const stranger = await issueSession(identityUnitOfWork, {
      subject: 'cg07-stranger', email: 'stranger@example.test', handle: 'cg07stranger',
    });
    const moderator = await issueSession(identityUnitOfWork, {
      subject: 'cg07-mod', email: 'mod@example.test', handle: 'cg07mod',
    });
    const reviewer = await issueSession(identityUnitOfWork, {
      subject: 'cg07-rev', email: 'rev@example.test', handle: 'cg07rev',
    });
    const app = buildApiApp({
      config,
      ...(denyActions ? { governanceActionRateLimiter: {
        ...createFixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
        consume: () => ({ allowed: false as const, retryAfterSeconds: 60 }),
      } } : {}),
      identityUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      moderationCommandUnitOfWork: createPostgresModerationCommandUnitOfWork(runtime.db),
      moderationQueryPorts: createPostgresModerationQueryPorts(runtime.db),
    });
    return { app, owner, stranger, moderator, reviewer };
  }

  async function issueSession(
    unitOfWork: IdentityUnitOfWork,
    identity: { readonly subject: string; readonly email: string; readonly handle: string },
  ): Promise<Client> {
    const issued = await unitOfWork.execute(async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example/realms/known',
        subject: identity.subject,
        email: identity.email,
        displayName: identity.handle,
        handle: identity.handle,
      });
      const secrets = await createSession(ports, { accountId: ensured.account.id });
      return { ensured, secrets };
    });
    return {
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(issued.secrets.rawSessionToken)}`,
      csrfToken: issued.secrets.rawCsrfToken,
      accountId: issued.ensured.account.id,
    };
  }

  function mutationHeaders(client: Client, commandId: string, extra: Record<string, string> = {}) {
    return {
      cookie: client.cookie,
      origin: ORIGIN,
      'x-csrf-token': client.csrfToken,
      'known-command-id': commandId,
      'content-type': extra['content-type'] ?? 'application/json',
      ...extra,
    };
  }

  async function grant(accountId: string, role: 'moderator' | 'reviewer'): Promise<void> {
    const granted = await createPostgresModerationRoleUnitOfWork(runtime.db).execute((ports) =>
      grantModerationRole(ports, { accountId, role, reason: 'cg07 fixture' }));
    assert.equal(granted.changed, true);
  }

  async function seedActions(app: ApiApp, owner: Client, moderator: Client): Promise<{
    readonly collectionId: string;
    readonly hide: { readonly id: string; readonly state: string };
    readonly delist: { readonly id: string; readonly state: string };
  }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: { kind: 'bookmarks', title: 'Appeal Notes', summary: 'notes' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const collectionId = (created.json() as { collection: { id: string; etag: string } }).collection.id;
    const published = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${collectionId}`,
      headers: mutationHeaders(owner, crypto.randomUUID(), {
        'content-type': 'application/merge-patch+json',
        'if-match': (created.json() as { collection: { etag: string } }).collection.etag,
      }),
      payload: { visibility: 'public', publicationSlug: 'cg07-notes', allowSearchIndexing: true },
    });
    assert.equal(published.statusCode, 200, published.body);
    const reported = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/reports',
      headers: mutationHeaders(owner, crypto.randomUUID()),
      payload: {
        target: { kind: 'collection', id: collectionId },
        category: 'spam',
        description: 'unsolicited advertising network',
      },
    });
    assert.equal(reported.statusCode, 201, reported.body);
    const caseId = (reported.json() as { id: string }).id;
    const hide = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId, target: { kind: 'collection', id: collectionId },
        action: 'hide_public', reason: 'hide public collection',
      },
    });
    assert.equal(hide.statusCode, 201, hide.body);
    const delist = await app.inject({
      method: 'POST',
      url: '/api/v1/moderation/actions',
      headers: mutationHeaders(moderator, crypto.randomUUID()),
      payload: {
        caseId, target: { kind: 'collection', id: collectionId },
        action: 'delist', reason: 'delist collection',
      },
    });
    assert.equal(delist.statusCode, 201, delist.body);
    return {
      collectionId,
      hide: hide.json() as { id: string; state: string },
      delist: delist.json() as { id: string; state: string },
    };
  }

  return { get isolated() { return isolated; }, get runtime() { return runtime; }, harness, grant, mutationHeaders, seedActions };
}
