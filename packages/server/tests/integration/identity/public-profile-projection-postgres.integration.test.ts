import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresSharedExposureFactsPort, createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildPublicProfileFactsStatement,
  createPostgresPublicProfileFactsReadPort,
} from '../../../src/infrastructure/identity/index.js';
import {
  buildPublicationDirectoryStatement,
  createPostgresPublicationDirectoryReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  PublicProfileNotFoundError,
  getPublicProfileProjection,
} from '../../../src/bootstrap/public-profile-projection.js';
import { createPublicationCursorKeyring } from '../../../src/modules/publication/index.js';
import { ABOUT_MAX } from '../../../src/modules/identity/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PROFILE_OWNER = 'profile-owner-subject';

describeWithPostgres('Phase 2B PostgreSQL public Profile projection contract', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase2b_public_profile', {
      maxConnections: 6,
      applicationName: 'known-phase2b-public-profile',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedProfiles(isolated);
    await seedCollections(isolated);
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('empty database reaches the P2B-01 migration with its constraints and indexes', async () => {
    const catalog = await isolated.runtime.pool.query<{ name: string }>(`
      select indexname as name from pg_indexes
       where schemaname = current_schema()
         and indexname in ('profile_handles_canonical_handle_unique', 'collections_public_profile_owner_order_idx')
      union all
      select conname as name from pg_constraint
       where connamespace = current_schema()::regnamespace
         and conname = 'profile_handles_handle_canonical_format'
    `);
    assert.deepEqual(new Set(catalog.rows.map((row) => row.name)), new Set([
      'profile_handles_canonical_handle_unique',
      'collections_public_profile_owner_order_idx',
      'profile_handles_handle_canonical_format',
    ]));
  });

  test('profiles.about defaults to empty and enforces the ABOUT_MAX character check', async () => {
    const catalog = await isolated.runtime.pool.query<{ conname: string }>(`
      select conname from pg_constraint
       where connamespace = current_schema()::regnamespace
         and conrelid = 'profiles'::regclass
         and conname = 'profiles_about_length'
    `);
    assert.equal(catalog.rows[0]?.conname, 'profiles_about_length');

    await isolated.runtime.pool.query(`
      insert into accounts(id, subject_id) values ('Nzc3Nzc3Nzc3Nzc3Nzc3Nw', 'about-default-owner');
      insert into profiles(account_id, display_name) values ('Nzc3Nzc3Nzc3Nzc3Nzc3Nw', 'About Default')
    `);
    const defaults = await isolated.runtime.pool.query<{ about: string }>(
      `select about from profiles where account_id = 'Nzc3Nzc3Nzc3Nzc3Nzc3Nw'`,
    );
    assert.equal(defaults.rows[0]?.about, '');

    await isolated.runtime.pool.query(
      `update profiles set about = $1 where account_id = 'Nzc3Nzc3Nzc3Nzc3Nzc3Nw'`,
      ['x'.repeat(ABOUT_MAX)],
    );
    await assert.rejects(
      () => isolated.runtime.pool.query(
        `update profiles set about = $1 where account_id = 'Nzc3Nzc3Nzc3Nzc3Nzc3Nw'`,
        ['x'.repeat(ABOUT_MAX + 1)],
      ),
      /profiles_about_length|check constraint/i,
    );
    const stored = await isolated.runtime.pool.query<{ about: string }>(
      `select about from profiles where account_id = 'Nzc3Nzc3Nzc3Nzc3Nzc3Nw'`,
    );
    assert.equal(stored.rows[0]?.about.length, ABOUT_MAX);
  });

  test('upgrades the previous stable migration by canonicalizing existing handle spelling', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase2b_profile_upgrade');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo('202607242100_publication_directory_indexes');
      if (previous.error) throw previous.error;
      await upgrade.runtime.pool.query(`
        insert into accounts(id, subject_id) values ('MzMzMzMzMzMzMzMzMzMzMw', 'upgrade-subject');
        insert into profiles(account_id, display_name) values ('MzMzMzMzMzMzMzMzMzMzMw', 'Upgrade');
        insert into profile_handles(handle, account_id) values ('Upgrade_User', 'MzMzMzMzMzMzMzMzMzMzMw')
      `);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const row = await upgrade.runtime.pool.query<{ handle: string }>(
        `select handle from profile_handles where account_id = 'MzMzMzMzMzMzMzMzMzMzMw'`,
      );
      assert.equal(row.rows[0]?.handle, 'upgrade_user');
      const facts = await createPostgresPublicProfileFactsReadPort(upgrade.runtime)
        .findByCanonicalHandle('upgrade_user');
      assert.equal(facts?.handle, 'upgrade_user');
      assert.equal(facts?.about, '');
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('latest migration backfills active OIDC accounts and enforces the handle invariant at commit', async () => {
    const upgrade = await createIsolatedPostgresRuntime('oidc_handle_invariant');
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo('202607242200_public_profile_projection');
      if (previous.error) throw previous.error;
      await upgrade.runtime.pool.query(`
        insert into accounts(id, subject_id, status) values
          ('legacy-active-oidc', 'opaque-owner-one', 'active'),
          ('legacy-disabled-oidc', 'opaque-owner-two', 'disabled');
        insert into profiles(account_id, display_name) values
          ('legacy-active-oidc', 'Historical Active'),
          ('legacy-disabled-oidc', 'Historical Disabled');
        insert into account_identities(id, account_id, issuer, subject) values
          ('legacy-identity-one', 'legacy-active-oidc', 'https://issuer.example', 'secret-subject-one'),
          ('legacy-identity-two', 'legacy-disabled-oidc', 'https://issuer.example', 'secret-subject-two')
      `);
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;

      const rows = await upgrade.runtime.pool.query<{ account_id: string; handle: string }>(
        `select account_id, handle from profile_handles where account_id like 'legacy-%' order by account_id`,
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]?.account_id, 'legacy-active-oidc');
      assert.match(rows.rows[0]!.handle, /^[a-z0-9._~-]{1,64}$/u);
      assert.equal(rows.rows[0]!.handle.includes('secret-subject'), false);

      await assert.rejects(
        () => upgrade.runtime.pool.query(`
          begin;
          insert into accounts(id, subject_id, status) values ('invalid-active-oidc', 'opaque-owner-three', 'active');
          insert into profiles(account_id, display_name) values ('invalid-active-oidc', 'Invalid');
          insert into account_identities(id, account_id, issuer, subject)
            values ('invalid-identity', 'invalid-active-oidc', 'https://issuer.example', 'secret-subject-three');
          commit
        `),
      );
      await upgrade.runtime.pool.query('rollback');

      await upgrade.runtime.pool.query(`
        begin;
        delete from profile_handles where account_id = 'legacy-active-oidc';
        insert into profile_handles(handle, account_id) values ('historical_renamed', 'legacy-active-oidc');
        commit
      `);
      assert.equal(await upgrade.runtime.pool.query(
        `select 1 from profile_handles where handle = 'historical_renamed'`,
      ).then((result) => result.rowCount), 1);

      await assert.rejects(() => upgrade.runtime.pool.query(`
        begin;
        delete from profile_handles where account_id = 'legacy-active-oidc';
        commit
      `));
      await upgrade.runtime.pool.query('rollback');
      assert.equal(await upgrade.runtime.pool.query(
        `select 1 from profile_handles where handle = 'historical_renamed'`,
      ).then((result) => result.rowCount), 1, 'failed delete must roll back');

      await assert.rejects(() => upgrade.runtime.pool.query(`
        begin;
        insert into accounts(id, subject_id, status) values ('identity-without-handle', 'opaque-owner-four', 'active');
        insert into profiles(account_id, display_name) values ('identity-without-handle', 'No Handle');
        insert into account_identities(id, account_id, issuer, subject)
          values ('identity-without-handle-id', 'identity-without-handle', 'https://issuer.example', 'secret-subject-four');
        commit
      `));
      await upgrade.runtime.pool.query('rollback');
      assert.equal(await upgrade.runtime.pool.query(
        `select 1 from accounts where id = 'identity-without-handle'`,
      ).then((result) => result.rowCount), 0, 'failed identity insert must roll back the account');

      await assert.rejects(() => upgrade.runtime.pool.query(`
        begin;
        update accounts set status = 'active' where id = 'legacy-disabled-oidc';
        commit
      `));
      await upgrade.runtime.pool.query('rollback');
      assert.equal(await upgrade.runtime.pool.query<{ status: string }>(
        `select status from accounts where id = 'legacy-disabled-oidc'`,
      ).then((result) => result.rows[0]?.status), 'disabled', 'failed reactivation must roll back');

      await assert.rejects(() => upgrade.runtime.pool.query(`
        begin;
        insert into profile_handles(handle, account_id) values ('historical_renamed', 'legacy-disabled-oidc');
        commit
      `));
      await upgrade.runtime.pool.query('rollback');
    } finally {
      await upgrade.close();
    }
  }, 120_000);

  test('canonical lookup distinguishes handle from displayName and conceals missing/deleted/private profiles', async () => {
    const read = createPostgresPublicProfileFactsReadPort(isolated.runtime);
    const alice = await read.findByCanonicalHandle('alice');
    assert.deepEqual(alice, {
      profileId: 'IiIiIiIiIiIiIiIiIiIiIg',
      handle: 'alice', displayName: 'Shared Name', avatarUrl: 'https://cdn.example.test/alice.png',
      about: 'I collect bookmarks.',
      ownerSubjectId: PROFILE_OWNER,
    });
    assert.equal(await read.findByCanonicalHandle('shared_name'), null);
    assert.equal(await read.findByCanonicalHandle('deleted_user'), null);
    assert.equal(await read.findByCanonicalHandle('private_user'), null);
    assert.equal(await read.findByCanonicalHandle('profile_missing'), null);
    assert.equal(await read.findByCanonicalHandle('missing'), null);
  });

  test('projects only published live public collections and never enumerates unlisted', async () => {
    const queryPorts = ports(isolated);
    try {
      const result = await getPublicProfileProjection(queryPorts, { handle: '%41LICE', limit: 20 });
      assert.deepEqual(result.collections.slice(0, 4).map((row) => row.id), [
        'profile-public-new', 'profile-public-A', 'profile-public-a', 'profile-public-old',
      ]);
      for (const hidden of ['profile-unlisted', 'profile-protected', 'profile-private', 'profile-unpublished', 'profile-deleted']) {
        assert.equal(result.collections.some((row) => row.id === hidden), false);
      }
      assert.equal(result.profile.avatarUrl, 'https://cdn.example.test/alice.png');
      assert.equal(result.profile.about, 'I collect bookmarks.');
    } finally {
      queryPorts.cursors.destroy();
    }
  });

  test('uses safe avatar fallback and preserves an empty display name', async () => {
    const queryPorts = ports(isolated);
    try {
      const result = await getPublicProfileProjection(queryPorts, { handle: 'empty-profile' });
      assert.equal(result.profile.displayName, '');
      assert.equal(result.profile.avatarUrl, null);
      assert.equal(result.profile.about, '');
    } finally {
      queryPorts.cursors.destroy();
    }
  });

  test('returns the same application 404 shape for unknown and concealed profiles', async () => {
    for (const handle of ['missing', 'profile_missing', 'deleted_user', 'private_user']) {
      const queryPorts = ports(isolated);
      try {
        await assert.rejects(
          () => getPublicProfileProjection(queryPorts, { handle }),
          (error: unknown) => {
            assert.ok(error instanceof PublicProfileNotFoundError);
            assert.equal(error.code, 'resource_not_found');
            assert.equal(error.message, 'Public Profile was not found.');
            return true;
          },
        );
      } finally {
        queryPorts.cursors.destroy();
      }
    }
  });

  test('traverses the complete stable collection keyset without duplicates or omissions', async () => {
    const queryPorts = ports(isolated);
    try {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await getPublicProfileProjection(queryPorts, {
          handle: 'alice', limit: 37, ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.collections.map((row) => row.id));
        cursor = page.page.cursor ?? undefined;
      } while (cursor);
      const expected = [
        'profile-public-new', 'profile-public-A', 'profile-public-a', 'profile-public-old',
        ...Array.from({ length: 800 }, (_, index) => `profile-plan-${String(index + 1).padStart(4, '0')}`),
      ];
      assert.deepEqual(ids, expected);
      assert.equal(new Set(ids).size, ids.length);
    } finally {
      queryPorts.cursors.destroy();
    }
  });

  test('uses canonical-handle and owner-public keyset indexes on sufficient fixtures', async () => {
    const profileStatement = buildPublicProfileFactsStatement('alice');
    const profilePlan = await isolated.runtime.pool.query<{ 'QUERY PLAN': readonly ExplainPlan[] }>(
      `explain (analyze, buffers, format json) ${profileStatement.text}`,
      [...profileStatement.values],
    );
    assertPlanUsesIndex(profilePlan.rows[0]?.['QUERY PLAN'][0], 'profile_handles_canonical_handle_unique', 'profile_handles');

    const anchors = [
      { id: undefined, allowBoundedFinalSort: false },
      { id: 'profile-plan-0400', allowBoundedFinalSort: false },
      { id: 'profile-plan-0790', allowBoundedFinalSort: true },
    ] as const;
    for (const anchor of anchors) {
      const anchorId = anchor.id;
      let after;
      if (anchorId) {
        const row = await isolated.runtime.pool.query<{ micros: string; locator: string }>(
          `select (extract(epoch from updated_at) * 1000000)::bigint::text as micros,
                  publication_locator_sha256_128(id) as locator
             from collections where id = $1`,
          [anchorId],
        );
        after = {
          orderingUpdatedAtMicros: row.rows[0]!.micros,
          idLocator: row.rows[0]!.locator,
        };
      }
      const statement = buildPublicationDirectoryStatement({
        principal: 'anonymous', filter: { creator: PROFILE_OWNER }, limit: 50,
        ...(after ? { after } : {}),
      }, anchorId);
      const collectionPlan = await isolated.runtime.pool.query<{ 'QUERY PLAN': readonly ExplainPlan[] }>(
        `explain (analyze, buffers, format json) ${statement.text}`,
        [...statement.values],
      );
      assertPlanUsesIndex(
        collectionPlan.rows[0]?.['QUERY PLAN'][0],
        'collections_public_profile_owner_order_idx',
        'collections',
        anchor.allowBoundedFinalSort,
      );
    }
  });
});

interface ExplainNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly 'Index Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Actual Total Time'?: number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly 'Sort Space Type'?: string;
  readonly Plans?: readonly ExplainNode[];
}
interface ExplainPlan { readonly Plan: ExplainNode }

function flattenPlan(node: ExplainNode): readonly ExplainNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenPlan)];
}

function assertPlanUsesIndex(
  plan: ExplainPlan | undefined,
  index: string,
  relation: string,
  allowBoundedFinalSort = false,
): void {
  assert.ok(plan);
  const nodes = flattenPlan(plan.Plan);
  assert.ok(
    nodes.some((node) => node['Index Name'] === index),
    `expected ${index} in plan: ${JSON.stringify(plan.Plan)}`,
  );
  const sorts = nodes.filter((node) => node['Node Type'] === 'Sort');
  if (!allowBoundedFinalSort) {
    assert.equal(sorts.length, 0, `unexpected Sort in plan: ${JSON.stringify(plan.Plan)}`);
  } else {
    for (const sort of sorts) {
      assert.ok((sort['Actual Rows'] ?? Number.POSITIVE_INFINITY) <= 51);
      assert.equal(sort['Sort Space Type'], 'Memory');
    }
  }
  assert.equal(
    nodes.some((node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === relation),
    false,
    `unexpected ${relation} Seq Scan in plan: ${JSON.stringify(plan.Plan)}`,
  );
  assert.ok((plan.Plan['Actual Rows'] ?? 0) <= 51);
  assert.ok((plan.Plan['Actual Total Time'] ?? Number.POSITIVE_INFINITY) < 5_000);
  const blocks = nodes.reduce(
    (sum, node) => sum + (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
    0,
  );
  assert.ok(blocks > 0);
  assert.ok(blocks < 20_000);
}

function ports(runtime: IsolatedPostgresRuntime) {
  return {
    profiles: createPostgresPublicProfileFactsReadPort(runtime.runtime),
    collections: createPostgresPublicationDirectoryReadPort(runtime.runtime),
    cursors: createPublicationCursorKeyring({
      active: { id: 'profile-pg-v1', secret: Buffer.alloc(32, 73).toString('base64') },
      retained: [],
    }),
    sharedExposure: createPostgresSharedExposureFactsPort(runtime.runtime),
  };
}

async function seedProfiles(runtime: IsolatedPostgresRuntime): Promise<void> {
  await runtime.runtime.pool.query(`
    insert into accounts(id, subject_id, status, deleted_at) values
      ('IiIiIiIiIiIiIiIiIiIiIg', '${PROFILE_OWNER}', 'active', null),
      ('EREREREREREREREREREREQ', 'empty-owner', 'active', null),
      ('account-deleted', 'deleted-owner', 'deleted', current_timestamp),
      ('account-private', 'private-owner', 'disabled', null),
      ('account-profile-missing', 'profile-missing-owner', 'active', null);
    insert into profiles(account_id, display_name, avatar_url, about) values
      ('IiIiIiIiIiIiIiIiIiIiIg', 'Shared Name', 'https://cdn.example.test/alice.png', 'I collect bookmarks.'),
      ('EREREREREREREREREREREQ', '', 'http://unsafe.example/avatar.png', ''),
      ('account-deleted', 'Deleted', 'https://cdn.example.test/deleted.png', ''),
      ('account-private', 'Private', 'https://cdn.example.test/private.png', '');
    insert into profile_handles(handle, account_id) values
      ('alice', 'IiIiIiIiIiIiIiIiIiIiIg'),
      ('empty-profile', 'EREREREREREREREREREREQ'),
      ('deleted_user', 'account-deleted'),
      ('private_user', 'account-private'),
      ('profile_missing', 'account-profile-missing')
  `);
  await runtime.runtime.pool.query(`
    insert into accounts(id, subject_id)
    select 'bulk-account-' || n, 'bulk-subject-' || n from generate_series(1, 2000) n;
    insert into profiles(account_id, display_name)
    select 'bulk-account-' || n, 'Bulk ' || n from generate_series(1, 2000) n;
    insert into profile_handles(handle, account_id)
    select 'bulk_user_' || lpad(n::text, 4, '0'), 'bulk-account-' || n from generate_series(1, 2000) n;
    analyze profile_handles; analyze accounts; analyze profiles
  `);
}

async function seedCollections(runtime: IsolatedPostgresRuntime): Promise<void> {
  const client = await runtime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    const fixtures = [
      ['profile-public-new', 'public', '2026-07-24T00:00:00.000900Z', true, false],
      ['profile-public-A', 'public', '2026-07-24T00:00:00.000800Z', true, false],
      ['profile-public-a', 'public', '2026-07-24T00:00:00.000800Z', true, false],
      ['profile-public-old', 'public', '2026-07-24T00:00:00.000700Z', true, false],
      ['profile-unlisted', 'unlisted', '2026-07-24T00:00:00.000600Z', true, false],
      ['profile-protected', 'protected', '2026-07-24T00:00:00.000500Z', true, false],
      ['profile-private', 'private', '2026-07-24T00:00:00.000400Z', true, false],
      ['profile-unpublished', 'protected', '2026-07-24T00:00:00.000300Z', false, false],
      ['profile-deleted', 'public', '2026-07-24T00:00:00.000200Z', true, true],
    ] as const;
    for (const [index, [id, visibility, updatedAt, published, deleted]] of fixtures.entries()) {
      await insertCollection(client, { id, owner: PROFILE_OWNER, visibility, updatedAt, published, deleted, slug: `profile-fixture-${index}` });
    }
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'profile-plan-' || lpad(n::text, 4, '0'), 'collection' from generate_series(1, 800) n
      union all
      select 'profile-plan-root-' || lpad(n::text, 4, '0'), 'node' from generate_series(1, 800) n
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at)
      select 'profile-plan-' || lpad(n::text, 4, '0'), $1, 'Plan ' || n, 'bookmarks', 'public',
             'profile-plan-root-' || lpad(n::text, 4, '0'), 'r1', 'c1', 'p1',
             'profile-plan-' || lpad(n::text, 4, '0'), '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz - n * interval '1 second'
        from generate_series(1, 800) n
    `, [PROFILE_OWNER]);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'profile-plan-root-' || lpad(n::text, 4, '0'), 'profile-plan-' || lpad(n::text, 4, '0'),
             'folder', true, 'Root ' || n, 'r1', 'ch1' from generate_series(1, 800) n
    `);
    await client.query(`
      insert into resource_id_ledger(resource_id, resource_type)
      select 'other-plan-' || lpad(n::text, 5, '0'), 'collection' from generate_series(1, 4000) n
      union all
      select 'other-plan-root-' || lpad(n::text, 5, '0'), 'node' from generate_series(1, 4000) n
    `);
    await client.query(`
      insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
         content_revision, policy_revision, publication_slug, published_at, updated_at)
      select 'other-plan-' || lpad(n::text, 5, '0'), 'other-owner-' || (n % 40),
             'Other Plan ' || n, 'bookmarks', 'public',
             'other-plan-root-' || lpad(n::text, 5, '0'), 'r1', 'c1', 'p1',
             'other-plan-' || lpad(n::text, 5, '0'), '2026-01-01T00:00:00Z'::timestamptz,
             '2026-01-01T00:00:00Z'::timestamptz - (n % 800 + 1) * interval '1 second'
        from generate_series(1, 4000) n
    `);
    await client.query(`
      insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision)
      select 'other-plan-root-' || lpad(n::text, 5, '0'), 'other-plan-' || lpad(n::text, 5, '0'),
             'folder', true, 'Other Root ' || n, 'r1', 'ch1' from generate_series(1, 4000) n
    `);
    await client.query('commit');
    await runtime.runtime.pool.query('analyze collections');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function insertCollection(client: import('pg').PoolClient, input: {
  readonly id: string;
  readonly owner: string;
  readonly visibility: 'public' | 'unlisted' | 'protected' | 'private';
  readonly updatedAt: string;
  readonly published: boolean;
  readonly deleted: boolean;
  readonly slug: string;
}): Promise<void> {
  await client.query(
    `insert into resource_id_ledger(resource_id, resource_type) values ($1, 'collection'), ($2, 'node')`,
    [input.id, `${input.id}-root`],
  );
  await client.query(
    `insert into collections
      (id, owner_subject_id, title, kind, visibility, root_node_id, resource_revision,
       content_revision, policy_revision, publication_slug, published_at, deleted_at, updated_at)
     values ($1, $2, $1, 'bookmarks', $3, $4, 'r1', 'c1', 'p1', $5,
             case when $6 then $7::timestamptz else null end,
             case when $8 then $7::timestamptz else null end, $7::timestamptz)`,
    [input.id, input.owner, input.visibility, `${input.id}-root`, input.slug, input.published, input.updatedAt, input.deleted],
  );
  await client.query(
    `insert into nodes(id, collection_id, kind, is_root, title, resource_revision, children_revision, deleted_at)
     values ($1, $2, 'folder', true, $2, 'r1', 'ch1', case when $3 then $4::timestamptz else null end)`,
    [`${input.id}-root`, input.id, input.deleted, input.updatedAt],
  );
}
