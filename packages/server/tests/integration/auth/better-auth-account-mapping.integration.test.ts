/**
 * Task A2 integration tests: business account mapping + concurrent account
 * establishment over REAL PostgreSQL (migrations through the current head).
 *
 * Each suite run uses a dedicated schema (createIsolatedPostgresRuntime), so
 * case isolation is per-schema and teardown drops the whole schema. Every
 * business account write goes through the same repositories the production
 * composition will use.
 *
 * 假阴性防护: the concurrent test uses a before-hook barrier so both
 * transactions read the missing mapping at the same time, then asserts final
 * row counts, the unique constraint and BOTH responses — never just "did not
 * throw".
 *
 * 假阳性防护:
 * - the "same email without proof" test fails if an email-fallback merge
 *   branch is ever added;
 * - account_identities / legacy_oidc_identity_archive rows must NOT resolve a
 *   Better Auth user (mapping_missing) nor be adopted by an unproved ensure;
 * - profile handle uniqueness and one-handle-per-account are asserted against
 *   the real database (SQLSTATE 23505), and the OIDC handle trigger surface
 *   is verified to exist while BA accounts (no identity rows) pass it.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import {
  BusinessAccountMappingError,
  ensureBusinessAccountForVerifiedEmail,
  resolveBusinessAccountForAuthUser,
  type EnsureBusinessAccountInput,
} from '../../../src/modules/auth/index.js';
import { HANDLE_ADJECTIVES, HANDLE_NOUNS, type MappedBusinessAccount } from '../../../src/modules/identity/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('A2 business account mapping PostgreSQL persistence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('a2_business_account_mapping', {
      maxConnections: 10,
      applicationName: 'known-a2-business-account-mapping-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  /** Every case starts from an empty identity surface (per-case database cleanup). */
  beforeEach(async () => {
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from legacy_oidc_identity_archive`);
    await isolated.runtime.pool.query(`delete from account_identities`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);
  });

  async function seedAuthUser(authUserId: string, email: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified")
       values ($1, $2, $3, true)`,
      [authUserId, `name-${authUserId}`, email],
    );
  }

  function unitOfWork(options: Parameters<typeof createPostgresBusinessAccountUnitOfWork>[1] = {}) {
    return createPostgresBusinessAccountUnitOfWork(isolated.runtime.db, options);
  }

  function ensure(input: EnsureBusinessAccountInput, uow = unitOfWork()) {
    return ensureBusinessAccountForVerifiedEmail(input, { unitOfWork: uow });
  }

  async function tableCount(table: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from ${table}`,
    );
    return result.rows[0]?.n ?? 0;
  }

  async function accountCountByEmail(email: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from accounts where email = $1`,
      [email],
    );
    return result.rows[0]?.n ?? 0;
  }

  function expectMappingError(error: unknown, code: BusinessAccountMappingError['code']): asserts error is BusinessAccountMappingError {
    assert.ok(error instanceof BusinessAccountMappingError, `expected BusinessAccountMappingError, got ${String(error)}`);
    assert.equal(error.code, code);
  }

  async function expectPgError(sqlText: string, code: string, reason: string): Promise<void> {
    await assert.rejects(
      () => isolated.runtime.pool.query(sqlText),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, code, `${reason} (expected SQLSTATE ${code})`);
        return true;
      },
    );
  }

  /** Seeds a legacy-style business account (account + profile + handle), optionally with OIDC identity + archive rows. */
  async function seedLegacyAccount(
    input: {
      readonly id: string;
      readonly email: string | null;
      readonly status?: 'active' | 'disabled' | 'deleted';
      readonly handle: string;
      readonly withOidcIdentity?: boolean;
    },
  ): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status, email) values ($1, $2, $3, $4)`,
      [input.id, `subj-${input.id}`, input.status ?? 'active', input.email],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name) values ($1, $2)`,
      [input.id, `Profile ${input.id}`],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles(handle, account_id) values ($1, $2)`,
      [input.handle, input.id],
    );
    if (input.withOidcIdentity) {
      // OIDC identity rows must be inserted AFTER the handle so the deferred
      // OIDC handle invariant (active account + identity ⇒ handle) commits cleanly.
      await isolated.runtime.pool.query(
        `insert into account_identities(id, account_id, issuer, subject)
         values ($1, $2, $3, $4)`,
        [`identity-${input.id}`, input.id, 'https://issuer.example', `subject-${input.id}`],
      );
      await isolated.runtime.pool.query(
        `insert into legacy_oidc_identity_archive(issuer, subject, account_id, migration_source, email_verified_claim)
         values ($1, $2, $3, $4, true)`,
        ['https://issuer.example', `subject-${input.id}`, input.id, 'legacy-oidc-import-v1'],
      );
    }
  }

  test('first verified email proof creates account, profile, handle and mapping atomically', async () => {
    await seedAuthUser('ba-first', 'first.ba@example.test');
    const ensured = await ensure({
      authUserId: 'ba-first',
      email: 'first@example.test',
      emailProofVerified: true,
      displayName: 'First User',
    });

    assert.equal(ensured.mapping.authUserId, 'ba-first');
    assert.equal(ensured.account.status, 'active');
    assert.equal(ensured.account.email, 'first@example.test');
    assert.equal(ensured.account.deletedAt, null);
    assert.equal(ensured.profile?.displayName, 'First User');
    assert.ok(ensured.handle, 'fresh account must receive a profile handle');
    // Readable `adjective-noun`, optionally `-NN` once the bare pair collides.
    assert.match(ensured.handle!.handle, /^[a-z]+-[a-z]+(?:-\d{2})?$/u);
    // Provenance, not a substring: the generator draws both words from a fixed
    // vocabulary that by contract never derives from the provider, email or
    // display name. A substring check is flaky here because 'first' is itself a
    // legitimate adjective in that vocabulary.
    const [adjective, noun] = ensured.handle!.handle.split('-');
    assert.ok(HANDLE_ADJECTIVES.includes(adjective!),
      `${ensured.handle!.handle} adjective must come from the automatic vocabulary`);
    assert.ok(HANDLE_NOUNS.includes(noun!),
      `${ensured.handle!.handle} noun must come from the automatic vocabulary`);

    assert.equal(await tableCount('accounts'), 1);
    assert.equal(await tableCount('profiles'), 1);
    assert.equal(await tableCount('profile_handles'), 1);
    assert.equal(await tableCount('auth_user_account_map'), 1);
    const identities = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from account_identities where account_id = $1`,
      [ensured.account.id],
    );
    assert.equal(identities.rows[0]?.n, 0, 'Better Auth business accounts must not mint account_identities rows');
  });

  test('repeat request for the same auth user is idempotent', async () => {
    await seedAuthUser('ba-repeat', 'repeat.ba@example.test');
    const input = { authUserId: 'ba-repeat', email: 'repeat@example.test', emailProofVerified: true };
    const first = await ensure(input);
    const second = await ensure(input);

    assert.equal(second.account.id, first.account.id);
    assert.equal(second.mapping.accountId, first.account.id);
    assert.equal(await tableCount('accounts'), 1);
    assert.equal(await tableCount('profiles'), 1);
    assert.equal(await tableCount('profile_handles'), 1);
    assert.equal(await tableCount('auth_user_account_map'), 1);
  });

  test('two concurrent first logins for the same auth user converge on one account (barrier)', async () => {
    await seedAuthUser('ba-concurrent', 'concurrent.ba@example.test');

    // Barrier: both transactions must read the missing mapping before either
    // proceeds, so the race window is real (both attempt the create).
    let arrived = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const uow = unitOfWork({
      faultInjector: {
        beforeCallback: async () => {
          arrived += 1;
          if (arrived === 2) release?.();
          await gate;
        },
      },
    });

    const input = { authUserId: 'ba-concurrent', email: 'concurrent@example.test', emailProofVerified: true };
    const results = await Promise.allSettled([
      ensureBusinessAccountForVerifiedEmail(input, { unitOfWork: uow }),
      ensureBusinessAccountForVerifiedEmail(input, { unitOfWork: uow }),
    ]);

    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(
        result.status,
        'fulfilled',
        `concurrent login must not throw: ${result.status === 'rejected' ? String(result.reason) : ''}`,
      );
    }
    const fulfilled = results as Array<PromiseFulfilledResult<MappedBusinessAccount>>;
    assert.equal(
      fulfilled[0]!.value.account.id,
      fulfilled[1]!.value.account.id,
      'both responses must resolve to the same account',
    );

    // Final state: exactly one account, profile, handle and mapping.
    assert.equal(await tableCount('accounts'), 1);
    assert.equal(await tableCount('profiles'), 1);
    assert.equal(await tableCount('profile_handles'), 1);
    assert.equal(await tableCount('auth_user_account_map'), 1);

    // The bidirectional unique constraints are real: re-inserting the exact
    // winner mapping row is rejected (auth_user_id primary key).
    await expectPgError(
      `insert into auth_user_account_map(auth_user_id, account_id)
       values ('ba-concurrent', '${fulfilled[0]!.value.account.id}')`,
      '23505',
      'duplicate mapping for the same auth user must be rejected',
    );
  });

  test('same email WITHOUT proof does NOT merge: a fresh account is created with no email stored', async () => {
    await seedAuthUser('ba-holder', 'holder.ba@example.test');
    await seedAuthUser('ba-unproved', 'unproved.ba@example.test');
    const holder = await ensure({
      authUserId: 'ba-holder',
      email: 'shared@example.test',
      emailProofVerified: true,
    });
    const fresh = await ensure({
      authUserId: 'ba-unproved',
      email: 'shared@example.test',
      emailProofVerified: false,
    });

    assert.notEqual(fresh.account.id, holder.account.id, 'unproved email must never adopt the existing account');
    assert.equal(fresh.account.email, null, 'unverified email must not be stored on the business account');
    assert.equal(await accountCountByEmail('shared@example.test'), 1);
    assert.equal(await tableCount('accounts'), 2);
    assert.equal(await tableCount('auth_user_account_map'), 2);
  });

  test('verified email proof adopts an existing unmapped account (mapping only)', async () => {
    await seedLegacyAccount({ id: 'acct-adopt-proof', email: 'adopt-proof@example.test', handle: 'handle-adopt-proof' });
    await seedAuthUser('ba-adopter-proof', 'adopter-proof.ba@example.test');
    const ensured = await ensure({
      authUserId: 'ba-adopter-proof',
      email: 'adopt-proof@example.test',
      emailProofVerified: true,
    });

    assert.equal(ensured.account.id, 'acct-adopt-proof');
    assert.equal(ensured.profile?.displayName, 'Profile acct-adopt-proof');
    assert.equal(ensured.handle?.handle, 'handle-adopt-proof');
    assert.equal(await tableCount('accounts'), 1, 'adoption must not create a second account');
    assert.equal(await tableCount('profiles'), 1);
    assert.equal(await tableCount('profile_handles'), 1);
    assert.equal(await tableCount('auth_user_account_map'), 1);
  });

  test('explicit link command adopts an existing unmapped account', async () => {
    await seedLegacyAccount({ id: 'acct-adopt-link', email: 'adopt-link@example.test', handle: 'handle-adopt-link' });
    await seedAuthUser('ba-linker', 'linker.ba@example.test');
    const ensured = await ensure({
      authUserId: 'ba-linker',
      email: 'adopt-link@example.test',
      emailProofVerified: false,
      explicitLink: true,
    });

    assert.equal(ensured.account.id, 'acct-adopt-link');
    assert.equal(await tableCount('accounts'), 1);
    assert.equal(await tableCount('auth_user_account_map'), 1);
    const mapping = await isolated.runtime.pool.query<{ auth_user_id: string }>(
      `select auth_user_id from auth_user_account_map where account_id = 'acct-adopt-link'`,
    );
    assert.equal(mapping.rows[0]?.auth_user_id, 'ba-linker');
  });

  test('an account already mapped to another auth user stays a stable duplicate_mapping error', async () => {
    await seedAuthUser('ba-owner', 'owner.ba@example.test');
    await seedAuthUser('ba-intruder', 'intruder.ba@example.test');
    await ensure({ authUserId: 'ba-owner', email: 'owned@example.test', emailProofVerified: true });

    await assert.rejects(
      () => ensure({ authUserId: 'ba-intruder', email: 'owned@example.test', emailProofVerified: true }),
      (error: unknown) => {
        expectMappingError(error, 'duplicate_mapping');
        return true;
      },
    );
    assert.equal(await tableCount('auth_user_account_map'), 1, 'conflicting adoption must not attach a second mapping');
  });

  test('disabled account is a stable error for resolution and repeat ensure', async () => {
    await seedAuthUser('ba-disable-after', 'disable-after.ba@example.test');
    const ensured = await ensure({
      authUserId: 'ba-disable-after',
      email: 'disable-after@example.test',
      emailProofVerified: true,
    });
    await isolated.runtime.pool.query(
      `update accounts set status = 'disabled' where id = $1`,
      [ensured.account.id],
    );

    await assert.rejects(
      () => unitOfWork().execute((ports) => resolveBusinessAccountForAuthUser(ports, 'ba-disable-after')),
      (error: unknown) => {
        expectMappingError(error, 'account_disabled');
        return true;
      },
    );
    await assert.rejects(
      () => ensure({ authUserId: 'ba-disable-after', email: 'disable-after@example.test', emailProofVerified: true }),
      (error: unknown) => {
        expectMappingError(error, 'account_disabled');
        return true;
      },
    );
  });

  test('deleted account is a stable error for adoption and resolution', async () => {
    await seedLegacyAccount({ id: 'acct-deleted', email: 'deleted@example.test', handle: 'handle-deleted', status: 'deleted' });
    await seedAuthUser('ba-deleted-adopter', 'deleted-adopter.ba@example.test');
    await assert.rejects(
      () => ensure({ authUserId: 'ba-deleted-adopter', email: 'deleted@example.test', emailProofVerified: true }),
      (error: unknown) => {
        expectMappingError(error, 'account_deleted');
        return true;
      },
    );

    await seedAuthUser('ba-delete-after', 'delete-after.ba@example.test');
    const ensured = await ensure({
      authUserId: 'ba-delete-after',
      email: 'delete-after@example.test',
      emailProofVerified: true,
    });
    await isolated.runtime.pool.query(
      `update accounts set status = 'deleted', deleted_at = now() where id = $1`,
      [ensured.account.id],
    );
    await assert.rejects(
      () => unitOfWork().execute((ports) => resolveBusinessAccountForAuthUser(ports, 'ba-delete-after')),
      (error: unknown) => {
        expectMappingError(error, 'account_deleted');
        return true;
      },
    );
  });

  test('handle collision is a stable error and rolls back the provisional account', async () => {
    await seedLegacyAccount({ id: 'acct-handle-owner', email: 'handle-owner@example.test', handle: 'taken-handle' });
    await seedAuthUser('ba-collide', 'collide.ba@example.test');
    await assert.rejects(
      () => ensure({
        authUserId: 'ba-collide',
        email: 'collide@example.test',
        emailProofVerified: true,
        handle: 'taken-handle',
      }),
      (error: unknown) => {
        expectMappingError(error, 'handle_collision');
        return true;
      },
    );

    assert.equal(await accountCountByEmail('collide@example.test'), 0, 'handle collision must roll back the account row');
    assert.equal(await tableCount('profiles'), 1, 'handle collision must roll back the profile row');
    assert.equal(await tableCount('profile_handles'), 1, 'handle collision must roll back the handle row');
    assert.equal(await tableCount('auth_user_account_map'), 0);
  });

  test('serialization failure and deadlock are retried transparently', async () => {
    for (const kind of ['serialization_failure', 'deadlock'] as const) {
      const authUserId = `ba-retry-${kind}`;
      await seedAuthUser(authUserId, `${authUserId}.ba@example.test`);
      let injected = false;
      const uow = unitOfWork({
        faultInjector: {
          beforeCallback: async () => {
            if (!injected) {
              injected = true;
              throw new DatabaseOperationError(kind, new Error(`injected ${kind}`));
            }
          },
        },
      });
      const ensured = await ensure(
        { authUserId, email: `retry-${kind}@example.test`, emailProofVerified: true },
        uow,
      );
      assert.equal(ensured.account.email, `retry-${kind}@example.test`, `${kind} must be retried to success`);
      assert.equal(await accountCountByEmail(`retry-${kind}@example.test`), 1);
    }
  });

  test('non-retryable failures are not masked by the retry loop', async () => {
    await seedAuthUser('ba-no-retry', 'no-retry.ba@example.test');
    const uow = unitOfWork({
      faultInjector: {
        beforeCallback: async () => {
          throw new Error('injected non-retryable failure');
        },
      },
    });
    await assert.rejects(
      () => ensure({ authUserId: 'ba-no-retry', email: 'no-retry@example.test', emailProofVerified: true }, uow),
      /injected non-retryable failure/,
    );
    assert.equal(await accountCountByEmail('no-retry@example.test'), 0);
  });

  test('mid-transaction failure rolls back the entire account creation', async () => {
    await seedAuthUser('ba-rollback', 'rollback.ba@example.test');
    const uow = unitOfWork({
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('force business account rollback');
        },
      },
    });
    await assert.rejects(
      () => ensure({ authUserId: 'ba-rollback', email: 'rollback@example.test', emailProofVerified: true }, uow),
      /force business account rollback/,
    );

    assert.equal(await accountCountByEmail('rollback@example.test'), 0, 'accounts must roll back');
    assert.equal(await tableCount('profiles'), 0, 'profiles must roll back');
    assert.equal(await tableCount('profile_handles'), 0, 'profile_handles must roll back');
    assert.equal(await tableCount('auth_user_account_map'), 0, 'auth_user_account_map must roll back');
    const authUsers = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where "id" = 'ba-rollback'`,
    );
    assert.equal(authUsers.rows[0]?.n, 1, 'the Better Auth user itself must survive (it is not part of this transaction)');
  });

  test('legacy OIDC archive and account_identities do not participate in runtime lookup', async () => {
    await seedLegacyAccount({
      id: 'acct-archive',
      email: 'archive@example.test',
      handle: 'handle-archive',
      withOidcIdentity: true,
    });
    await seedAuthUser('ba-archive-user', 'archive-user.ba@example.test');

    // account_identities + archive rows exist, but no mapping: resolution must
    // be mapping_missing — account_identities are never treated as Better Auth
    // accounts.
    await assert.rejects(
      () => unitOfWork().execute((ports) => resolveBusinessAccountForAuthUser(ports, 'ba-archive-user')),
      (error: unknown) => {
        expectMappingError(error, 'mapping_missing');
        return true;
      },
    );

    // An unproved ensure must NOT adopt the archive account even though the
    // archive holds a verified email claim for the same email.
    const fresh = await ensure({
      authUserId: 'ba-archive-user',
      email: 'archive@example.test',
      emailProofVerified: false,
    });
    assert.notEqual(fresh.account.id, 'acct-archive');
    assert.equal(fresh.account.email, null);
    const archiveMapping = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_user_account_map where account_id = 'acct-archive'`,
    );
    assert.equal(archiveMapping.rows[0]?.n, 0, 'archive account must stay unmapped');
  });

  test('mapping exists with proof fills a null product email; without proof it stays null', async () => {
    await seedAuthUser('ba-fill', 'fill.ba@example.test');
    const unproved = await ensure({
      authUserId: 'ba-fill',
      email: 'fill@example.test',
      emailProofVerified: false,
    });
    assert.equal(unproved.account.email, null, 'unproved occupancy must not store accounts.email');
    const filled = await ensure({
      authUserId: 'ba-fill',
      email: 'fill@example.test',
      emailProofVerified: true,
    });
    assert.equal(filled.account.id, unproved.account.id);
    assert.equal(filled.account.email, 'fill@example.test');
    assert.equal(await accountCountByEmail('fill@example.test'), 1);
  });

  test('filling a null product email held by another account is email_conflict', async () => {
    await seedLegacyAccount({ id: 'acct-holder', email: 'taken@example.test', handle: 'handle-taken' });
    await seedAuthUser('ba-empty', 'empty.ba@example.test');
    const empty = await ensure({
      authUserId: 'ba-empty',
      email: 'empty@example.test',
      emailProofVerified: false,
    });
    assert.equal(empty.account.email, null);
    await assert.rejects(
      () => ensure({ authUserId: 'ba-empty', email: 'taken@example.test', emailProofVerified: true }),
      (error: unknown) => {
        expectMappingError(error, 'email_conflict');
        return true;
      },
    );
    const stillEmpty = await isolated.runtime.pool.query<{ email: string | null }>(
      `select email from accounts where id = $1`, [empty.account.id],
    );
    assert.equal(stillEmpty.rows[0]?.email, null);
    assert.equal(await accountCountByEmail('taken@example.test'), 1);
  });

  test('profile handle uniqueness is enforced by the real database (constraint/trigger surface)', async () => {
    await seedAuthUser('ba-handles-a', 'handles-a.ba@example.test');
    await seedAuthUser('ba-handles-b', 'handles-b.ba@example.test');
    const first = await ensure({
      authUserId: 'ba-handles-a',
      email: 'handles-a@example.test',
      emailProofVerified: true,
    });
    const second = await ensure({
      authUserId: 'ba-handles-b',
      email: 'handles-b@example.test',
      emailProofVerified: true,
    });
    assert.ok(first.handle && second.handle);

    // Duplicate global handle → 23505 (profile_handles.handle primary key).
    await expectPgError(
      `insert into profile_handles(handle, account_id) values ('${first.handle.handle}', '${second.account.id}')`,
      '23505',
      'duplicate profile handle must be rejected by the database',
    );
    // Second handle for the same account → 23505 (profile_handles.account_id unique).
    await expectPgError(
      `insert into profile_handles(handle, account_id) values ('another-handle-x', '${first.account.id}')`,
      '23505',
      'one-handle-per-account must be rejected by the database',
    );

    // The OIDC handle trigger surface exists and BA accounts (no identity
    // rows) pass it — the trigger must not block Better Auth account creation.
    const trigger = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from pg_trigger
       where tgrelid = 'accounts'::regclass and tgname = 'accounts_require_oidc_handle'`,
    );
    assert.equal(trigger.rows[0]?.n, 1, 'accounts_require_oidc_handle trigger must exist');
    assert.equal(await tableCount('auth_user_account_map'), 2);
  });
});
