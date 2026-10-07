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

describeWithPostgres('anonymous DCR capacity (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('dcr_capacity');
    const result = await createMigrator(
      isolated.runtime.db,
      'migrations',
      isolated.schema,
    ).migrateToLatest();
    if (result.error) throw result.error;
  }, 120_000);
  afterAll(async () => isolated?.close());

  function store(maxAnonymousClients: number) {
    return createPostgresDcrRegistrationReservationStore({
      db: isolated.runtime.db,
      maxAnonymousClients,
      unusedClientRetentionSeconds: 60,
      maxOwnedClientsPerUser: 20,
      maxOwnedClients: 100_000,
    });
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

  function reservationId(result: DcrReserveResult): string {
    assert.equal(result.ok, true, 'expected an anonymous reservation');
    if (!result.ok) throw new Error('unreachable');
    return result.reservationId;
  }

  test('reservations enforce the cap and reclaim expired clients even when consent remains', async () => {
    const twoSlot = store(2);

    const first = reservationId(await twoSlot.reserveAnonymous());
    const second = reservationId(await twoSlot.reserveAnonymous());
    assert.equal((await twoSlot.reserveAnonymous()).ok, false, 'pending reservations must consume global capacity');

    await insertAnonymousClient('dcr-unused');
    await twoSlot.finalize(first, 'dcr-unused');
    await twoSlot.cancel(second);
    const replacement = reservationId(await twoSlot.reserveAnonymous());
    await twoSlot.cancel(replacement);

    await isolated.runtime.pool.query(
      `UPDATE "auth_oauth_dcr_registration"
       SET "expiresAt" = now() - interval '1 second'
       WHERE "clientId" = 'dcr-unused'`,
    );
    const afterUnusedExpiry = reservationId(await twoSlot.reserveAnonymous());
    const unusedClient = await isolated.runtime.pool.query(
      `SELECT 1 FROM "auth_oauth_client" WHERE "clientId" = 'dcr-unused'`,
    );
    assert.equal(unusedClient.rowCount, 0, 'client deletion must cascade its capacity row');
    await twoSlot.cancel(afterUnusedExpiry);

    const usedReservation = reservationId(await twoSlot.reserveAnonymous());
    await insertAnonymousClient('dcr-used');
    await twoSlot.finalize(usedReservation, 'dcr-used');
    await isolated.runtime.pool.query(
      `UPDATE "auth_oauth_dcr_registration"
       SET "expiresAt" = now() - interval '1 second'
       WHERE "clientId" = 'dcr-used'`,
    );
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_oauth_consent"
         ("id", "clientId", "userId", "referenceId", "resources",
          "requestedUserInfoClaims", "scopes", "createdAt", "updatedAt")
       VALUES ('consent-used', 'dcr-used', NULL, NULL, NULL, NULL, '[]'::jsonb, now(), now())`,
    );

    const oneSlotStore = store(1);
    const afterConsent = await oneSlotStore.reserveAnonymous();
    assert.equal(afterConsent.ok, true, 'consent without live tokens must not block reclaim after expiresAt');
    if (!afterConsent.ok) throw new Error('unreachable');
    const usedClient = await isolated.runtime.pool.query(
      `SELECT 1 FROM "auth_oauth_client" WHERE "clientId" = 'dcr-used'`,
    );
    assert.equal(usedClient.rowCount, 0, 'the expired client row must be gone');
    const consentGone = await isolated.runtime.pool.query(
      `SELECT 1 FROM "auth_oauth_consent" WHERE id = 'consent-used'`,
    );
    assert.equal(consentGone.rowCount, 0, 'consent must cascade away with the reclaimed client');
    await oneSlotStore.cancel(afterConsent.reservationId);

    const ownedReservation = reservationId(await oneSlotStore.reserveAnonymous());
    await isolated.runtime.pool.query(
      `INSERT INTO "auth_oauth_client"
         ("id", "clientId", "clientDiscoveryId", "userId", "referenceId",
          "redirectUris", "createdAt", "updatedAt")
       VALUES ('dcr-owned', 'dcr-owned', NULL, NULL, 'owner-reference',
               '[]'::jsonb, now(), now())`,
    );
    await oneSlotStore.finalize(ownedReservation, 'dcr-owned');
    const ownedRegistry = await isolated.runtime.pool.query(
      `SELECT 1 FROM "auth_oauth_dcr_registration" WHERE "clientId" = 'dcr-owned'`,
    );
    assert.equal(ownedRegistry.rowCount, 0, 'session/token-owned DCR clients are outside anonymous capacity');
  });

  test('migration backfill counts pre-existing unowned clients without making them reclaimable', async () => {
    const legacy = await createIsolatedPostgresRuntime('dcr_capacity_legacy');
    try {
      const migrator = createMigrator(legacy.runtime.db, 'migrations', legacy.schema);
      const previous = await migrator.migrateTo('202609260500_drop_redundant_indexes');
      if (previous.error) throw previous.error;
      await legacy.runtime.pool.query(
        `INSERT INTO "auth_oauth_client"
           ("id", "clientId", "clientDiscoveryId", "userId", "referenceId",
            "redirectUris", "createdAt", "updatedAt")
         VALUES ('legacy-unowned', 'legacy-unowned', NULL, NULL, NULL,
                 '[]'::jsonb, now() - interval '1 year', now())`,
      );
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;

      const registry = await legacy.runtime.pool.query(
        `SELECT "clientId", "reclaimable", "expiresAt"::text AS expires
         FROM "auth_oauth_dcr_registration"`,
      );
      assert.equal(registry.rowCount, 1);
      assert.equal(registry.rows[0]?.clientId, 'legacy-unowned');
      assert.equal(registry.rows[0]?.reclaimable, false);
      assert.equal(registry.rows[0]?.expires, 'infinity');

      const capacity = createPostgresDcrRegistrationReservationStore({
        db: legacy.runtime.db,
        maxAnonymousClients: 1,
        unusedClientRetentionSeconds: 60,
        maxOwnedClientsPerUser: 20,
        maxOwnedClients: 100_000,
      });
      assert.equal((await capacity.reserveAnonymous()).ok, false, 'a legacy row counts toward the cap');
      const client = await legacy.runtime.pool.query(
        `SELECT 1 FROM "auth_oauth_client" WHERE "clientId" = 'legacy-unowned'`,
      );
      assert.equal(client.rowCount, 1, 'the old client must not be auto-deleted');
    } finally {
      await legacy.close();
    }
  }, 120_000);
});
