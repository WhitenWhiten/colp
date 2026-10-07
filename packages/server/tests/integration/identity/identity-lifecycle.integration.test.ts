import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { createUnitOfWork, databaseNow, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresIdentityPorts,
  createPostgresIdentityUnitOfWork,
} from '../../../src/infrastructure/identity/index.js';
import {
  IdentityError,
  authenticateSession,
  bootstrapBrowserSession,
  bumpAccountSecurityEpoch,
  consumeOidcLoginTransaction,
  createIdentityApplication,
  createOidcLoginTransaction,
  createSession,
  createTestOidcTransactionSecrets,
  ensureAccountFromOidcIdentity,
  getAccountWithProfile,
  hashSecret,
  revokeSession,
  rotateSession,
  SESSION_ROTATION_MIN_AGE_MS,
  type IdentityPorts,
} from '../../../src/modules/identity/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const IDENTITY_TABLES = [
  'accounts',
  'profiles',
  'profile_handles',
  'account_identities',
  'sessions',
  'oidc_login_transactions',
] as const;

const FORBIDDEN_TABLES = [
  'publications',
  'subscriptions',
  // Phase 4A attachments is a production module now: its migrations legitimately
  // create `attachments` (and the blob ledger tables), so it no longer belongs
  // in the future-table leak guard.
  'search_documents',
  'api_keys',
] as const;

function expectIdentityCode(error: unknown, code: string): asserts error is IdentityError {
  assert.ok(error instanceof IdentityError, `expected IdentityError, got ${String(error)}`);
  assert.equal(error.code, code);
}

function randomHandle(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

const oidcTransactionSecrets = createTestOidcTransactionSecrets();

async function withPorts<Result>(
  isolated: IsolatedPostgresRuntime,
  work: (ports: IdentityPorts) => Promise<Result>,
  options: Parameters<typeof createUnitOfWork>[1] = {},
): Promise<Result> {
  return createUnitOfWork(isolated.runtime.db, options).execute(async ({ transaction }) => {
    const ports = createPostgresIdentityPorts(transaction, oidcTransactionSecrets);
    return work(ports);
  });
}

describeWithPostgres('identity lifecycle PostgreSQL persistence', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('identity', {
      maxConnections: 8,
      applicationName: 'known-identity-lifecycle-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  });

  afterAll(async () => {
    await isolated?.close();
  });

  test('migration applies identity tables and session/account security columns', async () => {
    const tables = await isolated.runtime.pool.query<{ relname: string }>(
      `select relname from pg_class
       where relkind = 'r' and relnamespace = current_schema()::regnamespace`,
    );
    const names = new Set(tables.rows.map((row) => row.relname));
    for (const table of IDENTITY_TABLES) assert.ok(names.has(table), `missing table ${table}`);
    for (const table of FORBIDDEN_TABLES) assert.ok(!names.has(table), `future table leaked: ${table}`);

    const sessionColumns = await isolated.runtime.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'sessions'`,
    );
    const sessionSet = new Set(sessionColumns.rows.map((row) => row.column_name));
    for (const column of [
      'idle_expires_at',
      'absolute_expires_at',
      'token_hash',
      'csrf_token_hash',
      'security_epoch',
      'revoked_at',
      'last_seen_at',
    ]) {
      assert.ok(sessionSet.has(column), `sessions.${column}`);
    }
    assert.equal(sessionSet.has('expires_at'), false, 'legacy sessions.expires_at must be dropped');

    const accountColumns = await isolated.runtime.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'accounts'`,
    );
    const accountSet = new Set(accountColumns.rows.map((row) => row.column_name));
    for (const column of ['security_epoch', 'email', 'status']) {
      assert.ok(accountSet.has(column), `accounts.${column}`);
    }

    const oidcColumns = await isolated.runtime.pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'oidc_login_transactions'`,
    );
    const oidcSet = new Set(oidcColumns.rows.map((row) => row.column_name));
    for (const column of [
      'return_to',
      'expires_at',
      'consumed_at',
      'code_challenge_method',
      // Contracted protected secret columns (required; no plaintext secrets).
      'state_hash',
      'nonce_hash',
      'pkce_verifier_ciphertext',
      'encryption_key_id',
      'encryption_key_version',
    ]) {
      assert.ok(oidcSet.has(column), `oidc_login_transactions.${column}`);
    }
    for (const column of ['state', 'nonce', 'code_verifier', 'dual_read_status']) {
      assert.equal(
        oidcSet.has(column),
        false,
        `contracted schema must not have ${column}`,
      );
    }

    const oidcNullability = await isolated.runtime.pool.query<{
      column_name: string;
      is_nullable: string;
    }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = current_schema() and table_name = 'oidc_login_transactions'
         and column_name = any($1::text[])`,
      [[
        'state_hash',
        'nonce_hash',
        'pkce_verifier_ciphertext',
        'encryption_key_id',
        'encryption_key_version',
      ]],
    );
    const nullability = new Map(
      oidcNullability.rows.map((row) => [row.column_name, row.is_nullable]),
    );
    for (const column of [
      'state_hash',
      'nonce_hash',
      'pkce_verifier_ciphertext',
      'encryption_key_id',
      'encryption_key_version',
    ]) {
      assert.equal(nullability.get(column), 'NO', `contract ${column} must be NOT NULL`);
    }

    const pk = await isolated.runtime.pool.query<{ column_name: string }>(
      `select a.attname as column_name
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
       where i.indrelid = 'oidc_login_transactions'::regclass and i.indisprimary`,
    );
    assert.deepEqual(
      pk.rows.map((row) => row.column_name),
      ['state_hash'],
    );
  });

  test('account OIDC identity is unique on (issuer, subject)', async () => {
    const issuer = 'https://issuer.example/realms/known';
    const subject = `subject-${randomUUID()}`;

    const first = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject,
        email: 'unique@example.test',
        emailVerified: true,
        displayName: 'Unique',
        handle: randomHandle('u'),
      }));
    assert.equal(first.identity?.subject, subject);

    const second = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject,
        email: 'unique-again@example.test',
        emailVerified: true,
      }));
    assert.equal(second.account.id, first.account.id);
    assert.equal(second.account.email, 'unique-again@example.test');

    await assert.rejects(
      () => withPorts(isolated, async (ports) => {
        await ports.accountIdentities.insert({
          id: randomUUID(),
          accountId: first.account.id,
          issuer,
          subject,
          createdAt: await databaseNow(isolated.runtime.db),
        });
      }),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        const kind = (error as { kind?: string }).kind;
        return code === '23505' || kind === 'unique_violation';
      },
    );
  });

  test('profile handle is unique and one-handle-per-account', async () => {
    const handle = randomHandle('h');
    const first = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `handle-a-${randomUUID()}`,
        handle,
        displayName: 'Handle A',
      }));
    assert.equal(first.handle?.handle, handle);

    await assert.rejects(
      () => withPorts(isolated, (ports) =>
        ensureAccountFromOidcIdentity(ports, {
          issuer: 'https://issuer.example',
          subject: `handle-b-${randomUUID()}`,
          handle,
          displayName: 'Handle B',
        })),
      (error: unknown) => {
        if (error instanceof IdentityError) {
          assert.equal(error.code, 'handle_taken');
          return true;
        }
        const code = (error as { code?: string }).code;
        const kind = (error as { kind?: string }).kind;
        return code === '23505' || kind === 'unique_violation';
      },
    );

    const secondAccount = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `handle-c-${randomUUID()}`,
        handle: randomHandle('h'),
        displayName: 'Handle C',
      }));

    await assert.rejects(
      () => withPorts(isolated, async (ports) => {
        await ports.handles.insert({
          handle: randomHandle('h2'),
          accountId: secondAccount.account.id,
          createdAt: await databaseNow(isolated.runtime.db),
        });
      }),
      (error: unknown) => {
        const code = (error as { code?: string }).code;
        const kind = (error as { kind?: string }).kind;
        return code === '23505' || kind === 'unique_violation';
      },
    );
  });

  test('session create uses database time and enforces idle/absolute expiry on authenticate', async () => {
    const before = await databaseNow(isolated.runtime.db);
    const { accountId, created } = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `session-time-${randomUUID()}`,
        handle: randomHandle('s'),
      });
      const session = await createSession(ports, { accountId: ensured.account.id });
      return { accountId: ensured.account.id, created: session };
    });
    const afterCreate = await databaseNow(isolated.runtime.db);

    assert.ok(created.session.createdAt.getTime() >= before.getTime() - 1_000);
    assert.ok(created.session.createdAt.getTime() <= afterCreate.getTime() + 1_000);
    assert.ok(created.session.idleExpiresAt.getTime() > created.session.createdAt.getTime());
    assert.ok(created.session.absoluteExpiresAt.getTime() >= created.session.idleExpiresAt.getTime());
    assert.equal(created.session.tokenHash, hashSecret(created.rawSessionToken));
    assert.notEqual(created.session.tokenHash, created.rawSessionToken);

    const authenticated = await withPorts(isolated, (ports) =>
      authenticateSession(ports, created.rawSessionToken, { touch: true }));
    assert.equal(authenticated.account.id, accountId);
    assert.ok(authenticated.session.idleExpiresAt.getTime() >= created.session.idleExpiresAt.getTime());

    // Force idle expiry while leaving absolute open (still satisfies idle <= absolute).
    await isolated.runtime.pool.query(
      `update sessions
       set idle_expires_at = current_timestamp - interval '1 second',
           absolute_expires_at = current_timestamp + interval '1 day'
       where id = $1`,
      [created.session.id],
    );
    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_expired');
        return true;
      },
    );

    // Absolute expiry with idle also past, keeping idle <= absolute for the check constraint.
    const absolute = await withPorts(isolated, async (ports) =>
      createSession(ports, { accountId }));
    await isolated.runtime.pool.query(
      `update sessions
       set idle_expires_at = current_timestamp - interval '30 seconds',
           absolute_expires_at = current_timestamp - interval '1 second'
       where id = $1`,
      [absolute.session.id],
    );
    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, absolute.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_expired');
        return true;
      },
    );
  });

  test('session revoke is idempotent', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `revoke-${randomUUID()}`,
        handle: randomHandle('r'),
      });
      return createSession(ports, { accountId: ensured.account.id });
    });

    const first = await withPorts(isolated, (ports) => revokeSession(ports, created.session.id));
    const second = await withPorts(isolated, (ports) => revokeSession(ports, created.session.id));
    assert.equal(first.revoked, true);
    assert.equal(second.revoked, false);

    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
  });

  test('session rotation rejects the old token, accepts the new token, and changes CSRF material', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `rotate-${randomUUID()}`,
        handle: randomHandle('t'),
      });
      return createSession(ports, { accountId: ensured.account.id });
    });

    const rotated = await withPorts(isolated, (ports) =>
      rotateSession(ports, created.session.id));

    assert.notEqual(rotated.rawSessionToken, created.rawSessionToken);
    assert.notEqual(rotated.rawCsrfToken, created.rawCsrfToken);
    assert.notEqual(rotated.session.csrfTokenHash, created.session.csrfTokenHash);
    assert.notEqual(rotated.session.tokenHash, created.session.tokenHash);
    assert.notEqual(rotated.session.id, created.session.id);
    assert.equal(rotated.session.rotatedFromSessionId, created.session.id);
    assert.equal(
      rotated.session.absoluteExpiresAt.getTime(),
      created.session.absoluteExpiresAt.getTime(),
    );

    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );

    const authenticated = await withPorts(isolated, (ports) =>
      authenticateSession(ports, rotated.rawSessionToken));
    assert.equal(authenticated.session.id, rotated.session.id);
    assert.equal(authenticated.session.tokenHash, rotated.session.tokenHash);
  });

  test('bootstrap below rotation threshold does not mint; above threshold rotates once', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `boot-${randomUUID()}`,
        handle: randomHandle('b'),
      });
      return createSession(ports, { accountId: ensured.account.id });
    });

    const below = await withPorts(isolated, (ports) =>
      bootstrapBrowserSession(ports, created.rawSessionToken, {
        rotationMinAgeMs: SESSION_ROTATION_MIN_AGE_MS,
      }));
    assert.equal(below.rotated, false);
    assert.equal(below.session.id, created.session.id);
    assert.equal(below.rawSessionToken, created.rawSessionToken);

    const above = await withPorts(isolated, (ports) =>
      bootstrapBrowserSession(ports, created.rawSessionToken, {
        rotationMinAgeMs: 0,
      }));
    assert.equal(above.rotated, true);
    assert.notEqual(above.session.id, created.session.id);
    assert.equal(above.session.rotatedFromSessionId, created.session.id);

    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );
  });

  test('concurrent PostgreSQL browser bootstrap resolves to one winner; replay fails', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `race-${randomUUID()}`,
        handle: randomHandle('x'),
      });
      return createSession(ports, { accountId: ensured.account.id });
    });

    // Separate transactions. The clock barrier ensures every contender has read
    // the same live predecessor before any transaction attempts the revoke CAS.
    let arrived = 0;
    let releaseRace: (() => void) | undefined;
    const raceGate = new Promise<void>((resolve) => { releaseRace = resolve; });
    const rotateWithBarrier = () => withPorts(isolated, (ports) => bootstrapBrowserSession({
      ...ports,
      clock: {
        async now() {
          const now = await ports.clock.now();
          arrived += 1;
          if (arrived === 4) releaseRace?.();
          await raceGate;
          return now;
        },
      },
    }, created.rawSessionToken, { rotationMinAgeMs: 0 }));
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, rotateWithBarrier),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<Awaited<ReturnType<typeof bootstrapBrowserSession>>>
    >;
    assert.equal(fulfilled.length, results.length, 'CAS losers must resolve to the winner');

    const winner = fulfilled[0]!.value;
    assert.equal(winner.session.rotatedFromSessionId, created.session.id);
    for (const result of fulfilled) {
      assert.equal(result.value.session.id, winner.session.id);
      assert.equal(result.value.rawSessionToken, winner.rawSessionToken);
      assert.equal(result.value.rawCsrfToken, winner.rawCsrfToken);
    }

    const successorCount = await isolated.runtime.pool.query<{ n: string }>(
      `select count(*)::text as n from sessions
       where rotated_from_session_id = $1`,
      [created.session.id],
    );
    assert.equal(successorCount.rows[0]?.n, '1');

    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_revoked');
        return true;
      },
    );

    const auth = await withPorts(isolated, (ports) =>
      authenticateSession(ports, winner.rawSessionToken));
    assert.equal(auth.session.id, winner.session.id);

    // Unique index belt-and-suspenders: a second insert with same rotated_from fails.
    await assert.rejects(async () => {
      await withPorts(isolated, async (ports) => {
        await ports.sessions.insert({
          ...winner.session,
          id: randomUUID(),
          tokenHash: hashSecret(randomUUID()),
          csrfTokenHash: hashSecret(randomUUID()),
          rotatedFromSessionId: created.session.id,
          revokedAt: null,
        });
      });
    });
  });

  test('idle and absolute expiry still reject authentication after rotation policy', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `exp-${randomUUID()}`,
        handle: randomHandle('p'),
      });
      return createSession(ports, {
        accountId: ensured.account.id,
        idleTtlMs: 5_000,
        absoluteTtlMs: 10_000,
      });
    });

    // Force absolute expiry via SQL (DB wall clock may not advance in tests).
    await isolated.runtime.pool.query(
      `update sessions
       set idle_expires_at = now() - interval '1 second',
           absolute_expires_at = now() - interval '1 second'
       where id = $1`,
      [created.session.id],
    );

    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_expired');
        return true;
      },
    );
  });

  test('rotation fault before commit rolls back CAS revoke; predecessor remains usable', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `fault-rot-${randomUUID()}`,
        handle: randomHandle('f'),
      });
      return createSession(ports, { accountId: ensured.account.id });
    });

    await assert.rejects(
      () => withPorts(
        isolated,
        async (ports) => {
          await rotateSession(ports, created.session.id);
        },
        {
          faultInjector: {
            afterCallbackBeforeCommit: async () => {
              throw new Error('force session rotation rollback');
            },
          },
        },
      ),
      /force session rotation rollback/,
    );

    const row = await isolated.runtime.pool.query<{ revoked_at: Date | null; n: string }>(
      `select revoked_at, (
         select count(*)::text from sessions where rotated_from_session_id = $1
       ) as n
       from sessions where id = $1`,
      [created.session.id],
    );
    assert.equal(row.rows[0]?.revoked_at, null, 'predecessor revoke must roll back');
    assert.equal(row.rows[0]?.n, '0', 'successor must not survive rollback');

    const auth = await withPorts(isolated, (ports) =>
      authenticateSession(ports, created.rawSessionToken, { touch: false }));
    assert.equal(auth.session.id, created.session.id);
  });

  test('account security_epoch bump invalidates existing sessions', async () => {
    const bootstrap = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `epoch-${randomUUID()}`,
        handle: randomHandle('e'),
      });
      const first = await createSession(ports, { accountId: ensured.account.id });
      const second = await createSession(ports, { accountId: ensured.account.id });
      return {
        accountId: ensured.account.id,
        first,
        second,
        epoch: ensured.account.securityEpoch,
      };
    });

    const bumped = await withPorts(isolated, (ports) =>
      bumpAccountSecurityEpoch(ports, bootstrap.accountId));
    assert.equal(bumped.securityEpoch, bootstrap.epoch + 1n);
    assert.equal(bumped.revokedSessions, 2);

    for (const raw of [bootstrap.first.rawSessionToken, bootstrap.second.rawSessionToken]) {
      await assert.rejects(
        () => withPorts(isolated, (ports) => authenticateSession(ports, raw)),
        (error: unknown) => {
          assert.ok(error instanceof IdentityError);
          assert.ok(
            error.code === 'session_security_epoch_mismatch'
            || error.code === 'session_revoked',
          );
          return true;
        },
      );
    }

    const fresh = await withPorts(isolated, async (ports) => {
      const session = await createSession(ports, { accountId: bootstrap.accountId });
      return authenticateSession(ports, session.rawSessionToken);
    });
    assert.equal(fresh.session.securityEpoch, bumped.securityEpoch);
  });

  test('OIDC secrets contract migration expands then contracts from representative old data', async () => {
    const CONTRACT = '202607222200_oidc_transaction_secrets_contract';
    // Dedicated schema so expand/contract churn cannot poison the suite schema.
    const path = await createIsolatedPostgresRuntime('oidc_contract', {
      maxConnections: 4,
      applicationName: 'known-oidc-contract-migration-test',
    });
    try {
      const historical = createHistoricalMigrator(path, CONTRACT);
      const atContract = await historical.migrateToLatest();
      if (atContract.error) throw atContract.error;
      const peeled = await historical.migrateDown();
      if (peeled.error) throw peeled.error;
      assert.deepEqual(peeled.results?.map(row => [row.migrationName, row.status]), [[CONTRACT, 'Success']]);

      // Expand window: plaintext + nullable protected columns.

      const expandColumns = await path.runtime.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = current_schema() and table_name = 'oidc_login_transactions'`,
      );
      const expandSet = new Set(expandColumns.rows.map((row) => row.column_name));
      for (const column of ['state', 'nonce', 'code_verifier', 'state_hash', 'dual_read_status']) {
        assert.ok(expandSet.has(column), `expand window missing ${column}`);
      }

      // Representative expand-window rows: protected dual-write + legacy plaintext-only.
      const protectedState = `contract-protected-${randomBytes(8).toString('hex')}`;
      const protectedHash = oidcTransactionSecrets.digestState(protectedState);
      const protectedNonce = randomBytes(16).toString('base64url');
      const protectedVerifier = randomBytes(32).toString('base64url');
      const sealed = oidcTransactionSecrets.encryptPkceVerifier(protectedVerifier);
      await path.runtime.pool.query(
        `insert into oidc_login_transactions (
           state, nonce, code_verifier, return_to, expires_at,
           state_hash, nonce_hash, pkce_verifier_ciphertext,
           encryption_key_id, encryption_key_version, dual_read_status
         ) values (
           $1, 'protected-nonce-not-stored',
           'prot-pkce-placeholder-0000000000000000000000',
           '/contract-protected', current_timestamp + interval '5 minutes',
           $2, $3, $4, $5, $6, 'protected'
         )`,
        [
          protectedHash,
          protectedHash,
          oidcTransactionSecrets.digestNonce(protectedNonce),
          sealed.ciphertext,
          sealed.keyId,
          sealed.keyVersion,
        ],
      );

      const legacyState = `contract-legacy-${randomBytes(8).toString('hex')}`;
      const legacyNonce = randomBytes(16).toString('base64url');
      const legacyVerifier = randomBytes(32).toString('base64url');
      await path.runtime.pool.query(
        `insert into oidc_login_transactions (
           state, nonce, code_verifier, return_to, expires_at
         ) values (
           $1, $2, $3, '/contract-legacy', current_timestamp + interval '5 minutes'
         )`,
        [legacyState, legacyNonce, legacyVerifier],
      );

      // Contract refuses to strand an active plaintext-only callback.
      await assert.rejects(
        () => runMigrations(path.runtime.db, 'up'),
        /unexpired legacy login transactions remain/i,
      );

      const stillExpandColumns = await path.runtime.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = current_schema() and table_name = 'oidc_login_transactions'`,
      );
      assert.ok(
        stillExpandColumns.rows.some((row) => row.column_name === 'state'),
        'failed contract must leave plaintext columns available for the active callback',
      );

      await path.runtime.pool.query(
        `update oidc_login_transactions
         set expires_at = current_timestamp - interval '1 second'
         where state = $1`,
        [legacyState],
      );

      // Once legacy rows are expired, contract deletes them, keeps protected rows,
      // and drops plaintext columns.
      const upContract = await runMigrations(path.runtime.db, 'up');
      assert.equal(upContract.results[0]?.migrationName, CONTRACT);
      assert.equal(upContract.results[0]?.status, 'Success');

      const contractedColumns = await path.runtime.pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = current_schema() and table_name = 'oidc_login_transactions'`,
      );
      const contractedSet = new Set(contractedColumns.rows.map((row) => row.column_name));
      for (const column of ['state', 'nonce', 'code_verifier', 'dual_read_status']) {
        assert.equal(contractedSet.has(column), false, `${column} must be dropped by contract`);
      }
      for (const column of [
        'state_hash',
        'nonce_hash',
        'pkce_verifier_ciphertext',
        'encryption_key_id',
        'encryption_key_version',
      ]) {
        assert.ok(contractedSet.has(column), `contract must keep ${column}`);
      }

      const surviving = await path.runtime.pool.query<{ state_hash: string }>(
        `select state_hash from oidc_login_transactions where state_hash = any($1::text[])`,
        [[protectedHash, oidcTransactionSecrets.digestState(legacyState)]],
      );
      assert.equal(surviving.rowCount, 1);
      assert.equal(surviving.rows[0]?.state_hash, protectedHash);

      // Reject inserting raw secret columns (they no longer exist).
      await assert.rejects(
        () => path.runtime.pool.query(
          `insert into oidc_login_transactions (state, nonce, code_verifier, return_to, expires_at)
           values ('raw-state-value-xx', 'raw-nonce-value-xx', $1, '/', current_timestamp + interval '1 minute')`,
          [randomBytes(32).toString('base64url')],
        ),
        /column .* does not exist|does not exist/i,
      );

      // Login flow on contracted schema: create + consume.
      const browserState = `contract-login-${randomBytes(8).toString('hex')}`;
      const browserNonce = randomBytes(16).toString('base64url');
      const codeVerifier = randomBytes(32).toString('base64url');
      const created = await withPorts(path, (ports) =>
        createOidcLoginTransaction(ports, {
          returnTo: '/contract-login',
          state: browserState,
          nonce: browserNonce,
          codeVerifier,
        }));
      assert.equal(created.transaction.state, browserState);

      const rawRow = await path.runtime.pool.query<{
        state_hash: string;
        nonce_hash: string;
        pkce_verifier_ciphertext: Buffer;
      }>(
        `select state_hash, nonce_hash, pkce_verifier_ciphertext
         from oidc_login_transactions where state_hash = $1`,
        [oidcTransactionSecrets.digestState(browserState)],
      );
      assert.equal(rawRow.rowCount, 1);
      assert.equal(rawRow.rows[0]?.state_hash, oidcTransactionSecrets.digestState(browserState));
      assert.equal(
        rawRow.rows[0]?.nonce_hash,
        oidcTransactionSecrets.digestNonce(browserNonce),
      );
      assert.notEqual(
        Buffer.from(rawRow.rows[0]!.pkce_verifier_ciphertext).toString('utf8'),
        codeVerifier,
      );

      const loaded = await withPorts(path, (ports) =>
        ports.oidcLoginTransactions.findByState(
          browserState,
          oidcTransactionSecrets.digestState(browserState),
        ));
      assert.ok(loaded);
      assert.equal(loaded.codeVerifier, '');
      assert.equal(
        oidcTransactionSecrets.decryptPkceVerifier(
          loaded.pkceVerifierCiphertext,
          loaded.encryptionKeyId,
          loaded.encryptionKeyVersion,
        ),
        codeVerifier,
      );

      const consumed = await withPorts(path, (ports) =>
        consumeOidcLoginTransaction(ports, browserState));
      assert.equal(consumed.codeVerifier, codeVerifier);
      assert.equal(consumed.state, browserState);
      assert.ok(
        oidcTransactionSecrets.verifyNonceDigest(browserNonce, consumed.nonceHash),
      );

      // Down of contract restores expand columns with placeholders for surviving protected rows.
      const downAgain = await runMigrations(path.runtime.db, 'down');
      assert.equal(downAgain.results[0]?.migrationName, CONTRACT);
      const restored = await path.runtime.pool.query<{
        state: string;
        nonce: string;
        code_verifier: string;
        dual_read_status: string | null;
      }>(
        `select state, nonce, code_verifier, dual_read_status
         from oidc_login_transactions where state_hash = $1`,
        [protectedHash],
      );
      assert.equal(restored.rowCount, 1);
      assert.equal(restored.rows[0]?.state, protectedHash);
      assert.equal(restored.rows[0]?.nonce, 'protected-nonce-not-stored');
      assert.equal(
        restored.rows[0]?.code_verifier,
        'prot-pkce-placeholder-0000000000000000000000',
      );
      assert.equal(restored.rows[0]?.dual_read_status, 'protected');
      assert.notEqual(restored.rows[0]?.state, protectedState);
      assert.notEqual(restored.rows[0]?.code_verifier, protectedVerifier);
      await historical.upgradeToCurrentLatest();
    } finally {
      await path.close();
    }
  }, 60_000);

  test('OIDC protected secrets: new writes omit raw secrets on contracted schema', async () => {
    const browserState = `protected-state-${randomBytes(12).toString('hex')}`;
    const browserNonce = randomBytes(16).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const created = await withPorts(isolated, (ports) =>
      createOidcLoginTransaction(ports, {
        returnTo: '/protected-contract',
        state: browserState,
        nonce: browserNonce,
        codeVerifier,
      }));

    assert.equal(created.transaction.state, browserState);
    assert.equal(created.codeVerifier, codeVerifier);

    const stateDigest = oidcTransactionSecrets.digestState(browserState);
    const loadedProtected = await withPorts(isolated, (ports) =>
      ports.oidcLoginTransactions.findByState(browserState, stateDigest));
    assert.ok(loadedProtected);
    assert.equal(loadedProtected.state, stateDigest);
    assert.equal(loadedProtected.nonce, '');
    assert.equal(loadedProtected.codeVerifier, '');
    assert.equal(loadedProtected.stateHash, stateDigest);
    assert.equal(
      loadedProtected.nonceHash,
      oidcTransactionSecrets.digestNonce(browserNonce),
    );
    assert.equal(
      oidcTransactionSecrets.decryptPkceVerifier(
        loadedProtected.pkceVerifierCiphertext,
        loadedProtected.encryptionKeyId,
        loadedProtected.encryptionKeyVersion,
      ),
      codeVerifier,
    );

    // Raw SQL: only protected columns; no plaintext secret fields exist.
    const rawProtected = await isolated.runtime.pool.query<{
      state_hash: string;
      nonce_hash: string;
    }>(
      `select state_hash, nonce_hash
       from oidc_login_transactions where state_hash = $1`,
      [stateDigest],
    );
    assert.equal(rawProtected.rowCount, 1);
    assert.equal(rawProtected.rows[0]?.state_hash, stateDigest);
    assert.notEqual(rawProtected.rows[0]?.state_hash, browserState);
    assert.notEqual(rawProtected.rows[0]?.nonce_hash, browserNonce);

    const consumedProtected = await withPorts(isolated, (ports) =>
      consumeOidcLoginTransaction(ports, browserState));
    assert.ok(consumedProtected.consumedAt);
    assert.equal(consumedProtected.codeVerifier, codeVerifier);
    assert.equal(consumedProtected.state, browserState);

    // Plaintext dual-read is gone: unknown digest is not found.
    await assert.rejects(
      () => withPorts(isolated, (ports) =>
        consumeOidcLoginTransaction(ports, `missing-${randomBytes(8).toString('hex')}`)),
      (error: unknown) => {
        expectIdentityCode(error, 'transaction_not_found');
        return true;
      },
    );
  });

  test('OIDC login transaction is one-shot; second consume fails', async () => {
    const created = await withPorts(isolated, (ports) =>
      createOidcLoginTransaction(ports, {
        returnTo: '/dashboard',
        nonce: randomBytes(16).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
      }));

    const first = await withPorts(isolated, (ports) =>
      consumeOidcLoginTransaction(ports, created.transaction.state));
    assert.ok(first.consumedAt);

    await assert.rejects(
      () => withPorts(isolated, (ports) =>
        consumeOidcLoginTransaction(ports, created.transaction.state)),
      (error: unknown) => {
        expectIdentityCode(error, 'transaction_consumed');
        return true;
      },
    );
  });

  test('concurrent OIDC consume elects exactly one winner', async () => {
    const created = await withPorts(isolated, (ports) =>
      createOidcLoginTransaction(ports, {
        returnTo: '/concurrent',
        nonce: randomBytes(16).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
      }));

    const outcomes = await Promise.allSettled([
      withPorts(isolated, (ports) =>
        consumeOidcLoginTransaction(ports, created.transaction.state)),
      withPorts(isolated, (ports) =>
        consumeOidcLoginTransaction(ports, created.transaction.state)),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one consumer must win');
    assert.equal(rejected.length, 1, 'exactly one consumer must lose');
    const rejection = (rejected[0] as PromiseRejectedResult).reason;
    if (rejection instanceof IdentityError) {
      assert.equal(rejection.code, 'transaction_consumed');
    } else {
      const code = (rejection as { code?: string }).code;
      const kind = (rejection as { kind?: string }).kind;
      assert.ok(
        code === '23505' || kind === 'unique_violation',
        `unexpected concurrent loser error: ${String(rejection)}`,
      );
    }

    const rows = await isolated.runtime.pool.query<{ consumed_at: Date | null }>(
      `select consumed_at from oidc_login_transactions where state_hash = $1`,
      [oidcTransactionSecrets.digestState(created.transaction.state)],
    );
    assert.equal(rows.rowCount, 1);
    assert.ok(rows.rows[0]?.consumed_at);
  });

  test('expired OIDC transaction cannot be consumed', async () => {
    const created = await withPorts(isolated, (ports) =>
      createOidcLoginTransaction(ports, {
        returnTo: '/expired',
        nonce: randomBytes(16).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
      }));
    await isolated.runtime.pool.query(
      `update oidc_login_transactions
       set expires_at = current_timestamp - interval '1 second'
       where state_hash = $1`,
      [oidcTransactionSecrets.digestState(created.transaction.state)],
    );

    await assert.rejects(
      () => withPorts(isolated, (ports) =>
        consumeOidcLoginTransaction(ports, created.transaction.state)),
      (error: unknown) => {
        expectIdentityCode(error, 'transaction_expired');
        return true;
      },
    );
  });

  test('mid-transaction failure rolls back partial account/profile/identity writes', async () => {
    const issuer = 'https://issuer.example';
    const subject = `rollback-${randomUUID()}`;
    const handle = randomHandle('rb');

    await assert.rejects(
      () => createUnitOfWork(isolated.runtime.db, {
        faultInjector: {
          afterCallbackBeforeCommit: () => {
            throw new Error('force identity bootstrap rollback');
          },
        },
      }).execute(async ({ transaction }) => {
        const ports = createPostgresIdentityPorts(transaction, oidcTransactionSecrets);
        await ensureAccountFromOidcIdentity(ports, {
          issuer,
          subject,
          email: 'rollback@example.test',
          emailVerified: true,
          displayName: 'Rollback',
          handle,
        });
      }),
      /force identity bootstrap rollback/,
    );

    const identityRows = await isolated.runtime.pool.query(
      `select 1 from account_identities where issuer = $1 and subject = $2`,
      [issuer, subject],
    );
    assert.equal(identityRows.rowCount, 0, 'account_identities leaked after rollback');

    const handleRows = await isolated.runtime.pool.query(
      `select 1 from profile_handles where handle = $1`,
      [handle],
    );
    assert.equal(handleRows.rowCount, 0, 'profile_handles leaked after rollback');

    const accountRows = await isolated.runtime.pool.query(
      `select 1 from accounts where email = $1`,
      ['rollback@example.test'],
    );
    assert.equal(accountRows.rowCount, 0, 'accounts leaked after rollback');
  });

  test('repository contract: postgres ports and IdentityUnitOfWork round-trip', async () => {
    const subject = `repo-${randomUUID()}`;
    const handleValue = randomHandle('repo');
    const unitOfWork = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets,
    });
    const app = createIdentityApplication({ unitOfWork });

    const ensured = await app.ensureAccountFromOidcIdentity({
      issuer: 'https://issuer.example',
      subject,
      email: 'repo@example.test',
      emailVerified: true,
      displayName: 'Repo User',
      handle: handleValue,
    });

    await withPorts(isolated, async (ports) => {
      const byId = await ports.accounts.findById(ensured.account.id);
      assert.ok(byId);
      assert.equal(byId.id, ensured.account.id);

      const profile = await ports.profiles.findByAccountId(ensured.account.id);
      assert.ok(profile);

      const handle = await ports.handles.findByAccountId(ensured.account.id);
      assert.ok(handle);
      assert.equal(handle.handle, handleValue);

      const identity = await ports.accountIdentities.findByIssuerSubject(
        'https://issuer.example',
        subject,
      );
      assert.ok(identity);
      assert.equal(identity.accountId, ensured.account.id);

      const session = await createSession(ports, { accountId: ensured.account.id });
      const byHash = await ports.sessions.findByTokenHash(session.session.tokenHash);
      assert.ok(byHash);
      assert.equal(byHash.id, session.session.id);

      const oidc = await createOidcLoginTransaction(ports, {
        returnTo: '/repo-check',
        nonce: randomBytes(16).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
      });
      const loaded = await ports.oidcLoginTransactions.findByState(
        oidc.transaction.state,
        oidcTransactionSecrets.digestState(oidc.transaction.state),
      );
      assert.ok(loaded);
      assert.equal(loaded.returnTo, '/repo-check');
      assert.equal(loaded.consumedAt, null);
      assert.equal(loaded.codeVerifier, '');
      assert.ok(loaded.pkceVerifierCiphertext.length > 0);
      assert.equal(loaded.stateHash, oidcTransactionSecrets.digestState(oidc.transaction.state));

      // Touch via SQL clock remains coherent with repository update path.
      const now = await ports.clock.now();
      assert.ok(now instanceof Date);

      const me = await getAccountWithProfile(ports, ensured.account.id);
      assert.equal(me.account.email, 'repo@example.test');
      assert.equal(me.profile.displayName, 'Repo User');
      assert.equal(me.handle?.handle, handle.handle);
    });
  });

  test('absolute expiry is enforced even when idle window is still open', async () => {
    const created = await withPorts(isolated, async (ports) => {
      const ensured = await ensureAccountFromOidcIdentity(ports, {
        issuer: 'https://issuer.example',
        subject: `abs-${randomUUID()}`,
        handle: randomHandle('abs'),
      });
      return createSession(ports, {
        accountId: ensured.account.id,
        idleTtlMs: 60_000,
        absoluteTtlMs: 120_000,
      });
    });

    // Keep idle ahead of absolute to satisfy check constraint while both are past "now".
    await sql`
      update sessions set
        idle_expires_at = current_timestamp - interval '30 seconds',
        absolute_expires_at = current_timestamp - interval '1 second'
      where id = ${created.session.id}
    `.execute(isolated.runtime.db);

    await assert.rejects(
      () => withPorts(isolated, (ports) => authenticateSession(ports, created.rawSessionToken)),
      (error: unknown) => {
        expectIdentityCode(error, 'session_expired');
        return true;
      },
    );
  });

  test('verified email is required to store email; repeated login syncs trusted claims', async () => {
    const issuer = 'https://issuer.example';
    const subject = `claims-${randomUUID()}`;
    const emailA = `claims-a-${randomUUID()}@example.test`;
    const emailB = `claims-b-${randomUUID()}@example.test`;

    const untrusted = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject,
        email: emailA,
        emailVerified: false,
        displayName: 'Untrusted',
        avatarUrl: 'https://cdn.example/old.png',
      }));
    assert.equal(untrusted.account.email, null);

    const trusted = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject,
        email: emailA,
        emailVerified: true,
        displayName: 'Trusted Name',
        avatarUrl: 'https://cdn.example/new.png',
      }));
    assert.equal(trusted.account.id, untrusted.account.id);
    assert.equal(trusted.account.email, emailA);
    assert.equal(trusted.profile.displayName, 'Trusted Name');
    assert.equal(trusted.profile.avatarUrl, 'https://cdn.example/new.png');

    const synced = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject,
        email: emailB,
        emailVerified: true,
        displayName: 'Synced Name',
        avatarUrl: 'https://cdn.example/synced.png',
      }));
    assert.equal(synced.account.id, trusted.account.id);
    assert.equal(synced.account.email, emailB);
    assert.equal(synced.profile.displayName, 'Synced Name');
    assert.equal(synced.profile.avatarUrl, 'https://cdn.example/synced.png');
  });

  test('email conflict rejects and rolls back claim updates in the same transaction', async () => {
    const issuer = 'https://issuer.example';
    const takenEmail = `taken-${randomUUID()}@example.test`;
    const moverEmail = `mover-${randomUUID()}@example.test`;

    await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject: `holder-${randomUUID()}`,
        email: takenEmail,
        emailVerified: true,
        displayName: 'Holder',
      }));

    const moverSubject = `mover-${randomUUID()}`;
    const mover = await withPorts(isolated, (ports) =>
      ensureAccountFromOidcIdentity(ports, {
        issuer,
        subject: moverSubject,
        email: moverEmail,
        emailVerified: true,
        displayName: 'Mover Before',
        avatarUrl: 'https://cdn.example/before.png',
      }));

    await assert.rejects(
      () => withPorts(isolated, (ports) =>
        ensureAccountFromOidcIdentity(ports, {
          issuer,
          subject: moverSubject,
          email: takenEmail,
          emailVerified: true,
          displayName: 'Mover After',
          avatarUrl: 'https://cdn.example/after.png',
        })),
      (error: unknown) => {
        expectIdentityCode(error, 'email_conflict');
        return true;
      },
    );

    const after = await withPorts(isolated, (ports) =>
      getAccountWithProfile(ports, mover.account.id));
    assert.equal(after.account.email, moverEmail);
    assert.equal(after.profile.displayName, 'Mover Before');
    assert.equal(after.profile.avatarUrl, 'https://cdn.example/before.png');
  });
});
