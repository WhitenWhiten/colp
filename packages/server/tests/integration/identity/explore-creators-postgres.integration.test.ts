import assert from 'node:assert/strict';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresExploreCreatorsQueryPort } from '../../../src/infrastructure/identity/index.js';
import { generateOpaqueId } from '../../../src/modules/identity/index.js';
import {
  type ExplorePageReadPort,
  type ExplorePageRecord,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { mapExploreCreatorDto } from '../../../src/transport/product/explore-routes.js';
import { memoryExploreDirectoryLimiter } from '../../support/memory-product-rate-limiters.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function exploreRow(id: string, ownerSubjectId: string): ExplorePageRecord {
  return Object.freeze({
    id,
    ownerSubjectId,
    title: `Title ${id}`,
    summary: `Summary ${id}`,
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: id,
    tags: Object.freeze(['tag']),
    nodeCount: 3,
    orderingNodeCount: 3,
    language: null,
    hiddenPublic: false,
    viewCount: 0,
    updatedAt: '2026-07-24T00:00:00.000Z',
    orderingUpdatedAtMicros: '1784851200000000',
  });
}

function explorePage(rows: readonly ExplorePageRecord[]): ExplorePageReadPort {
  return {
    async loadPage(request) {
      return Object.freeze(rows.slice(0, request.limit + 1));
    },
  };
}

describeWithPostgres('Explore creator postgres join (ORG-P0-a)', () => {
  let isolated: IsolatedPostgresRuntime;
  let knownAccountId: string;
  let knownSubjectId: string;
  let unknownSubjectId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('explore_creators', {
      maxConnections: 8,
      applicationName: 'known-explore-creators',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    knownAccountId = generateOpaqueId();
    knownSubjectId = `owner-${generateOpaqueId()}`;
    unknownSubjectId = `missing-${generateOpaqueId()}`;
    const unknownAccountId = generateOpaqueId();
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status) values ($1, $2, 'active'), ($3, $4, 'active')`,
      [knownAccountId, knownSubjectId, unknownAccountId, unknownSubjectId],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url) values ($1, $2, $3)`,
      [knownAccountId, 'Ada', 'https://cdn.example.test/ada.png'],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles(handle, account_id) values ($1, $2)`,
      ['ada_explore', knownAccountId],
    );
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('joins accounts/profiles/profile_handles and falls back to Unknown without a profile', async () => {
    const port = createPostgresExploreCreatorsQueryPort(isolated.runtime.db);
    const facts = await port.findByOwnerSubjectIds([knownSubjectId, unknownSubjectId]);
    assert.equal(facts.has(knownSubjectId), true);
    assert.equal(facts.has(unknownSubjectId), false);
    const known = mapExploreCreatorDto(knownSubjectId, facts.get(knownSubjectId));
    const unknown = mapExploreCreatorDto(unknownSubjectId, facts.get(unknownSubjectId));
    assert.deepEqual(known, {
      id: `account:${knownAccountId}`,
      name: 'Ada',
      handle: 'ada_explore',
      avatar: 'https://cdn.example.test/ada.png',
    });
    assert.deepEqual(unknown, {
      id: `subject:${unknownSubjectId}`,
      name: 'Unknown',
      handle: null,
      avatar: null,
    });
  });

  test('HTTP Explore creators match the postgres port DTO', async () => {
    const port = createPostgresExploreCreatorsQueryPort(isolated.runtime.db);
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused/known',
      PRODUCT_ORIGIN: 'https://known.example',
      PUBLICATION_ORIGIN: 'https://known.example',
      LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    });
    const app = buildApiApp({
      config,
      exploreDirectoryRateLimiter: memoryExploreDirectoryLimiter(),
      explorePageQuery: explorePage([
        exploreRow('known-one', knownSubjectId),
        exploreRow('unknown-one', unknownSubjectId),
      ]),
      exploreCreatorsQuery: port,
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      items: Array<{ id: string; creators: Array<{ id: string; name: string; handle: string | null; avatar: string | null }> }>;
    };
    assert.deepEqual(body.items.find((item) => item.id === 'known-one')?.creators, [{
      id: `account:${knownAccountId}`,
      name: 'Ada',
      handle: 'ada_explore',
      avatar: 'https://cdn.example.test/ada.png',
    }]);
    assert.deepEqual(body.items.find((item) => item.id === 'unknown-one')?.creators, [{
      id: `subject:${unknownSubjectId}`,
      name: 'Unknown',
      handle: null,
      avatar: null,
    }]);
  });

  test('restrict_publication emits one Unknown sentinel and hides subject, account, handle, and avatar', async () => {
    const restrictedAccountId = generateOpaqueId();
    const restrictedSubjectId = `restricted-${generateOpaqueId()}`;
    const bareAccountId = generateOpaqueId();
    const bareSubjectId = `restricted-bare-${generateOpaqueId()}`;
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status) values ($1, $2, 'active'), ($3, $4, 'active')`,
      [restrictedAccountId, restrictedSubjectId, bareAccountId, bareSubjectId],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name, avatar_url) values ($1, 'Secret', 'https://cdn.example.test/secret.png')`,
      [restrictedAccountId],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles(handle, account_id) values ($1, $2)`,
      ['secret_explore', restrictedAccountId],
    );
    const target = JSON.stringify({ kind: 'account', id: restrictedAccountId });
    const bareTarget = JSON.stringify({ kind: 'account', id: bareAccountId });
    await isolated.runtime.pool.query(
      `insert into moderation_cases(
         id, reporter_account_id, target_kind, target_id, target_json, target_fingerprint,
         category, description, status, revision, created_at, updated_at)
       values
         ('restrict-case', $1, 'account', $2, $3::jsonb, 'restrict-fp', 'spam', 'restrict', 'resolved', '1', now(), now()),
         ('restrict-bare-case', $1, 'account', $4, $5::jsonb, 'restrict-bare-fp', 'spam', 'restrict', 'resolved', '1', now(), now())`,
      [knownAccountId, restrictedAccountId, target, bareAccountId, bareTarget],
    );
    await isolated.runtime.pool.query(
      `insert into moderation_actions(
         id, case_id, target_kind, target_id, target_json, target_fingerprint, action, reason,
         actor_account_id, state, revision, created_at)
       values
         ('restrict-action', 'restrict-case', 'account', $1, $2::jsonb, 'restrict-fp', 'restrict_publication', 'restrict', $3, 'active', '1', now()),
         ('restrict-bare-action', 'restrict-bare-case', 'account', $4, $5::jsonb, 'restrict-bare-fp', 'restrict_publication', 'restrict', $3, 'active', '1', now())`,
      [restrictedAccountId, target, knownAccountId, bareAccountId, bareTarget],
    );
    const port = createPostgresExploreCreatorsQueryPort(isolated.runtime.db);
    const facts = await port.findByOwnerSubjectIds([restrictedSubjectId, bareSubjectId, knownSubjectId]);
    const restricted = mapExploreCreatorDto(restrictedSubjectId, facts.get(restrictedSubjectId));
    const bare = mapExploreCreatorDto(bareSubjectId, facts.get(bareSubjectId));
    const visible = mapExploreCreatorDto(knownSubjectId, facts.get(knownSubjectId));
    assert.deepEqual(restricted, { id: 'unknown', name: 'Unknown', handle: null, avatar: null });
    assert.deepEqual(bare, restricted);
    assert.equal(visible.id, `account:${knownAccountId}`);
    const leaked = JSON.stringify({ restricted, bare });
    assert.equal(leaked.includes(restrictedAccountId), false);
    assert.equal(leaked.includes(restrictedSubjectId), false);
    assert.equal(leaked.includes(bareAccountId), false);
    assert.equal(leaked.includes(bareSubjectId), false);
    assert.equal(leaked.includes('secret_explore'), false);
    assert.equal(leaked.includes('Secret'), false);
  });
});
