import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  createPostgresDcrRegistrationReservationStore,
  type DcrReserveResult,
} from '../../../src/infrastructure/auth/dcr-registration-capacity.js';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('DCR live-token reclaim and owned quotas (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('dcr_capacity_owned');
    const result = await createMigrator(
      isolated.runtime.db,
      'migrations',
      isolated.schema,
    ).migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);
  afterAll(async () => isolated?.close());

  async function reset(): Promise<void> {
    await isolated.runtime.pool.query(
      `TRUNCATE "auth_oauth_access_token", "auth_oauth_refresh_token",
                "auth_oauth_consent", "auth_oauth_dcr_registration",
                "auth_oauth_client", "auth_users" CASCADE`,
    );
  }

  function store(overrides: {
    readonly maxAnonymousClients?: number;
    readonly unusedClientRetentionSeconds?: number;
    readonly maxOwnedClientsPerUser?: number;
    readonly maxOwnedClients?: number;
  } = {}) {
    return createPostgresDcrRegistrationReservationStore({
      db: isolated.runtime.db,
      maxAnonymousClients: 1,
      unusedClientRetentionSeconds: 60,
      maxOwnedClientsPerUser: 20,
      maxOwnedClients: 100_000,
      ...overrides,
    });
  }

  function reservationId(result: DcrReserveResult): string {
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) throw new Error('unreachable');
    return result.reservationId;
  }

  async function insertUser(userId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_users" ("id", "name", "email", "emailVerified")
       VALUES ($1, $1, $2, true)`,
      [userId, `${userId}@example.test`],
    );
  }

  async function insertAnonymousClient(clientId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_oauth_client"
         ("id", "clientId", "clientDiscoveryId", "userId", "referenceId",
          "redirectUris", "createdAt", "updatedAt")
       VALUES ($1, $1, NULL, NULL, NULL, '[]'::jsonb, now(), now())`,
      [clientId],
    );
  }

  async function insertOwnedClient(input: {
    readonly clientId: string;
    readonly userId?: string | null;
    readonly referenceId?: string | null;
    readonly clientDiscoveryId?: string | null;
    readonly createdAtSql?: string;
  }): Promise<void> {
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_oauth_client"
         ("id", "clientId", "clientDiscoveryId", "userId", "referenceId",
          "redirectUris", "createdAt", "updatedAt")
       VALUES ($1, $1, $2, $3, $4, '[]'::jsonb, ${input.createdAtSql ?? 'now()'}, now())`,
      [
        input.clientId,
        input.clientDiscoveryId ?? null,
        input.userId ?? null,
        input.referenceId ?? null,
      ],
    );
  }

  async function expireAnonymous(clientId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `UPDATE "auth_oauth_dcr_registration"
       SET "expiresAt" = now() - interval '1 second'
       WHERE "clientId" = $1`,
      [clientId],
    );
  }

  async function insertAccessToken(input: {
    readonly id: string;
    readonly clientId: string;
    readonly expiresSql: string;
    readonly revokedSql?: string;
  }): Promise<void> {
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_oauth_access_token"
         ("id", "token", "clientId", "expiresAt", "createdAt", "revoked", "scopes")
       VALUES ($1, $1, $2, ${input.expiresSql}, now(), ${input.revokedSql ?? 'NULL'}, '[]'::jsonb)`,
      [input.id, input.clientId],
    );
  }

  async function insertRefreshToken(input: {
    readonly id: string;
    readonly clientId: string;
    readonly userId: string;
    readonly expiresSql: string;
    readonly revokedSql?: string;
  }): Promise<void> {
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_oauth_refresh_token"
         ("id", "token", "clientId", "userId", "expiresAt", "createdAt", "revoked", "scopes")
       VALUES ($1, $1, $2, $3, ${input.expiresSql}, now(), ${input.revokedSql ?? 'NULL'}, '[]'::jsonb)`,
      [input.id, input.clientId, input.userId],
    );
  }

  async function finalizeExpiredAnonymous(clientId: string): Promise<void> {
    const capacity = store({ maxAnonymousClients: 10 });
    const reservation = reservationId(await capacity.reserveAnonymous());
    await insertAnonymousClient(clientId);
    await capacity.finalize(reservation, clientId);
    await expireAnonymous(clientId);
  }

  async function clientExists(clientId: string): Promise<boolean> {
    const result = await isolated.runtime.pool.query(
      `SELECT 1 FROM "auth_oauth_client" WHERE "clientId" = $1`,
      [clientId],
    );
    return result.rowCount === 1;
  }

  async function pendingOwned(userId: string): Promise<number> {
    const result = await isolated.runtime.pool.query(
      `SELECT count(*)::int AS n FROM "auth_oauth_dcr_registration"
       WHERE "ownerUserId" = $1 AND "clientId" IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  test('unexpired access blocks reclaim; expired and revoked access do not', async () => {
    await reset();
    const capacity = store({ maxAnonymousClients: 1 });
    await finalizeExpiredAnonymous('dcr-live-access');
    await insertAccessToken({
      id: 'access-live',
      clientId: 'dcr-live-access',
      expiresSql: "now() + interval '1 hour'",
    });
    assert.equal((await capacity.reserveAnonymous()).ok, false);
    assert.equal(await clientExists('dcr-live-access'), true);

    await isolated.runtime.pool.query(`DELETE FROM "auth_oauth_access_token" WHERE id = 'access-live'`);
    await insertAccessToken({
      id: 'access-expired',
      clientId: 'dcr-live-access',
      expiresSql: "now() - interval '1 minute'",
    });
    const afterExpired = await capacity.reserveAnonymous();
    assert.equal(afterExpired.ok, true);
    assert.equal(afterExpired.reclaimedAnonymous, 1);
    assert.equal(await clientExists('dcr-live-access'), false);
    if (afterExpired.ok) await capacity.cancel(afterExpired.reservationId);

    await finalizeExpiredAnonymous('dcr-revoked-access');
    await insertAccessToken({
      id: 'access-revoked',
      clientId: 'dcr-revoked-access',
      expiresSql: "now() + interval '1 hour'",
      revokedSql: 'now()',
    });
    const afterRevoked = await capacity.reserveAnonymous();
    assert.equal(afterRevoked.ok, true);
    assert.equal(await clientExists('dcr-revoked-access'), false);
    if (afterRevoked.ok) await capacity.cancel(afterRevoked.reservationId);
  });

  test('live refresh blocks reclaim; expired and revoked refresh do not', async () => {
    await reset();
    await insertUser('refresh-owner');
    const capacity = store({ maxAnonymousClients: 1 });
    await finalizeExpiredAnonymous('dcr-live-refresh');
    await insertRefreshToken({
      id: 'refresh-live',
      clientId: 'dcr-live-refresh',
      userId: 'refresh-owner',
      expiresSql: "now() + interval '1 hour'",
    });
    assert.equal((await capacity.reserveAnonymous()).ok, false);
    assert.equal(await clientExists('dcr-live-refresh'), true);

    await isolated.runtime.pool.query(`DELETE FROM "auth_oauth_refresh_token" WHERE id = 'refresh-live'`);
    await insertRefreshToken({
      id: 'refresh-expired',
      clientId: 'dcr-live-refresh',
      userId: 'refresh-owner',
      expiresSql: "now() - interval '1 minute'",
    });
    const afterExpired = await capacity.reserveAnonymous();
    assert.equal(afterExpired.ok, true);
    assert.equal(await clientExists('dcr-live-refresh'), false);
    if (afterExpired.ok) await capacity.cancel(afterExpired.reservationId);

    await finalizeExpiredAnonymous('dcr-revoked-refresh');
    await insertRefreshToken({
      id: 'refresh-revoked',
      clientId: 'dcr-revoked-refresh',
      userId: 'refresh-owner',
      expiresSql: "now() + interval '1 hour'",
      revokedSql: 'now()',
    });
    const afterRevoked = await capacity.reserveAnonymous();
    assert.equal(afterRevoked.ok, true);
    assert.equal(await clientExists('dcr-revoked-refresh'), false);
    if (afterRevoked.ok) await capacity.cancel(afterRevoked.reservationId);
  });

  test('owned reserve ignores a full anonymous cap until per-user and global owned caps', async () => {
    await reset();
    await insertUser('owner-a');
    const capacity = store({
      maxAnonymousClients: 1,
      maxOwnedClientsPerUser: 2,
      maxOwnedClients: 10,
    });
    const anonymous = reservationId(await capacity.reserveAnonymous());
    await insertAnonymousClient('anon-full');
    await capacity.finalize(anonymous, 'anon-full');
    assert.equal((await capacity.reserveAnonymous()).ok, false);

    const owned = await capacity.reserveOwned({ userId: 'owner-a' });
    assert.equal(owned.ok, true, 'session-owned DCR must not consume anonymous slots');
  });

  test('per-user owned cap denies the same user and still admits a different user', async () => {
    await reset();
    await insertUser('user-one');
    await insertUser('user-two');
    await insertOwnedClient({ clientId: 'owned-user-one', userId: 'user-one' });
    const capacity = store({ maxOwnedClientsPerUser: 1, maxOwnedClients: 10 });

    const sameUser = await capacity.reserveOwned({ userId: 'user-one' });
    assert.equal(sameUser.ok, false);
    if (!sameUser.ok) assert.equal(sameUser.reason, 'owned_user');

    const otherUser = await capacity.reserveOwned({ userId: 'user-two' });
    assert.equal(otherUser.ok, true);
  });

  test('global owned cap denies a second user when maxOwned is 1', async () => {
    await reset();
    await insertUser('global-one');
    await insertUser('global-two');
    await insertOwnedClient({ clientId: 'owned-global-one', userId: 'global-one' });
    const capacity = store({ maxOwnedClientsPerUser: 20, maxOwnedClients: 1 });

    const second = await capacity.reserveOwned({ userId: 'global-two' });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, 'owned_global');
  });

  test('owned unused clients without live tokens are reclaimed; CIMD clients are not', async () => {
    await reset();
    await insertUser('reclaim-owner');
    await insertOwnedClient({
      clientId: 'owned-stale',
      userId: 'reclaim-owner',
      createdAtSql: "now() - interval '2 minutes'",
    });
    await insertOwnedClient({
      clientId: 'cimd-stale',
      userId: 'reclaim-owner',
      clientDiscoveryId: 'https://cimd.example.test/.well-known/oauth-client',
      createdAtSql: "now() - interval '2 minutes'",
    });
    const capacity = store({
      maxOwnedClientsPerUser: 1,
      maxOwnedClients: 10,
      unusedClientRetentionSeconds: 60,
    });
    const reclaimed = await capacity.reserveOwned({ userId: 'reclaim-owner' });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.reclaimedOwned, 1);
    assert.equal(await clientExists('owned-stale'), false);
    assert.equal(await clientExists('cimd-stale'), true);
    if (reclaimed.ok) await capacity.cancel(reclaimed.reservationId);
  });

  test('in-flight owned occupancy denies a second reserve for the same user until cancel', async () => {
    await reset();
    await insertUser('user-a');
    const capacity = store({ maxOwnedClientsPerUser: 1, maxOwnedClients: 10 });
    const first = await capacity.reserveOwned({ userId: 'user-a' });
    assert.equal(first.ok, true);
    assert.equal(await pendingOwned('user-a'), 1);

    const second = await capacity.reserveOwned({ userId: 'user-a' });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, 'owned_user');

    if (!first.ok) throw new Error('unreachable');
    await capacity.cancel(first.reservationId);
    assert.equal(await pendingOwned('user-a'), 0);
    const third = await capacity.reserveOwned({ userId: 'user-a' });
    assert.equal(third.ok, true);
    if (third.ok) await capacity.cancel(third.reservationId);
  });

  test('in-flight owned occupancy denies a second user when the global cap is 1', async () => {
    await reset();
    await insertUser('pending-one');
    await insertUser('pending-two');
    const capacity = store({ maxOwnedClientsPerUser: 20, maxOwnedClients: 1 });
    const first = await capacity.reserveOwned({ userId: 'pending-one' });
    assert.equal(first.ok, true);

    const second = await capacity.reserveOwned({ userId: 'pending-two' });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason, 'owned_global');
    if (first.ok) await capacity.cancel(first.reservationId);
  });

  test('pending owned occupancy does not fill the anonymous cap', async () => {
    await reset();
    await insertUser('anon-peer');
    const capacity = store({
      maxAnonymousClients: 1,
      maxOwnedClientsPerUser: 20,
      maxOwnedClients: 10,
    });
    const owned = await capacity.reserveOwned({ userId: 'anon-peer' });
    assert.equal(owned.ok, true);
    const anonymous = await capacity.reserveAnonymous();
    assert.equal(anonymous.ok, true, 'owned pending must not count toward anonymous capacity');
    if (owned.ok) await capacity.cancel(owned.reservationId);
    if (anonymous.ok) await capacity.cancel(anonymous.reservationId);
  });

  test('expired pending owned occupancy is deleted on the next admission', async () => {
    await reset();
    await insertUser('expire-owner');
    const capacity = store({ maxOwnedClientsPerUser: 1, maxOwnedClients: 10 });
    const first = reservationId(await capacity.reserveOwned({ userId: 'expire-owner' }));
    await isolated.runtime.pool.query(
      `UPDATE "auth_oauth_dcr_registration"
       SET "expiresAt" = now() - interval '1 second'
       WHERE "id" = $1`,
      [first],
    );
    const second = await capacity.reserveOwned({ userId: 'expire-owner' });
    assert.equal(second.ok, true);
    const stale = await isolated.runtime.pool.query(
      `SELECT 1 FROM "auth_oauth_dcr_registration" WHERE "id" = $1`,
      [first],
    );
    assert.equal(stale.rowCount, 0);
    if (second.ok) await capacity.cancel(second.reservationId);
  });

  test('completeOwned drops pending occupancy only for an owned client', async () => {
    await reset();
    await insertUser('complete-owner');
    const capacity = store({ maxOwnedClientsPerUser: 1, maxOwnedClients: 10 });
    const pending = reservationId(await capacity.reserveOwned({ userId: 'complete-owner' }));
    await insertOwnedClient({ clientId: 'owned-complete', userId: 'complete-owner' });
    await capacity.completeOwned(pending, 'owned-complete');
    assert.equal(await pendingOwned('complete-owner'), 0);
    assert.equal((await capacity.reserveOwned({ userId: 'complete-owner' })).ok, false);

    await isolated.runtime.pool.query(`DELETE FROM "auth_oauth_client" WHERE "clientId" = 'owned-complete'`);
    const held = reservationId(await capacity.reserveOwned({ userId: 'complete-owner' }));
    await insertAnonymousClient('unowned-201');
    await assert.rejects(
      () => capacity.completeOwned(held, 'unowned-201'),
      /owned DCR 201 did not persist an owned client/u,
    );
    assert.equal(await pendingOwned('complete-owner'), 1);
    await capacity.cancel(held);
  });
});
