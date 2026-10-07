import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createBookmarkClassificationProvider } from '../../../src/infrastructure/collections/classification-provider-factory.js';
import { createClassificationRunCommands } from '../../../src/infrastructure/collections/classification-run-commands.js';
import { createPostgresClassificationRunRuntime } from '../../../src/infrastructure/collections/classification-run-runtime.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';
import { createCreditTestDatabase, grantCredits } from '../../support/credit-ledger-fixture.js';
import { classificationAuthHeaders, classificationHttpHarness } from '../../support/classification-http-harness.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('batch reserve refusal and retry HTTP contracts', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createCreditTestDatabase('credit_admission'); await runMigrations(isolated.runtime.db, 'latest'); }, 180000);
  afterAll(async () => isolated?.close());

  test.each(['expiry', 'busy', 'reconciling', 'unavailable'] as const)('%s during reserve preserves the correct retry contract', async scenario => {
    const fixture = await seedClassificationTaxonomy(isolated.runtime);
    // SQL injection below chooses a database fault boundary, not an HTTP mock.
    let injected = false;
    const options = { creditEnabled: true, cancelBackend: isolated.runtime.cancelBackend,
      credits: (tx: Parameters<typeof createPostgresAccountCreditsPort>[0], id: string) => {
        const port = createPostgresAccountCreditsPort(tx, id);
        return { ...port, async reserve(input: Parameters<typeof port.reserve>[0]) {
          if (!injected) {
            injected = true;
            if (scenario === 'expiry') {
              // Wait for the actual grant expiry after the application has quoted it.
              await sql`SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp()))::double precision+0.01)
                FROM credit_grants WHERE account_id=${id} AND expires_at IS NOT NULL`.execute(tx);
            } else {
              const fault = { busy: ['55P03', 'lock not available'], reconciling: ['P0001', 'credit_reconciliation_required'], unavailable: ['P0001', 'credit_integrity_blocked'] }[scenario];
              await sql.raw(`DO $$ BEGIN RAISE EXCEPTION '${fault[1]}' USING ERRCODE='${fault[0]}'; END $$`).execute(tx);
            }
          }
          return port.reserve(input);
        } };
      } };
    const provider = createBookmarkClassificationProvider(null);
    const commands = createClassificationRunCommands(isolated.runtime.db, provider, options);
    const runtime = createPostgresClassificationRunRuntime(isolated.runtime.db, provider, {
      ...options, enabled: () => true, tagsEnabled: () => false, onError: () => {},
    });
    const app = classificationHttpHarness({ preview: async () => ({ kind: 'in_progress', retryAfterSeconds: 1 }) }, {
      runs: { ...runtime, create: commands.create }, principalId: fixture.collectionId, subjectId: fixture.ownerSubjectId,
    });
    const document = { nodeIds: [fixture.nodeId], requested: { folder: true, tags: false }, maxItems: 1,
      billing: { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } };
    const commandId = randomUUID();
    const send = () => app.inject({ method: 'POST', url: `/api/v1/collections/${fixture.collectionId}/classification-runs`,
      headers: { ...classificationAuthHeaders, 'content-type': 'application/json', 'known-command-id': commandId }, payload: document });
    try {
      await app.ready();
      if (scenario === 'expiry') {
        await sql`SELECT * FROM known_credits.grant_credits(${fixture.collectionId},'expiring',1,clock_timestamp(),
          clock_timestamp()+interval '800 milliseconds','operator','manual_grant','admission test')`.execute(isolated.runtime.db);
      } else await grantCredits(isolated.runtime.db, { accountId: fixture.collectionId, grantKey: randomUUID(), amount: 1 });
      const first = await send();
      expect(injected).toBe(true);
      expect(first.statusCode).toBe(scenario === 'expiry' ? 409 : 503);
      expect(first.json().error).toMatchObject({ code: scenario === 'expiry' ? 'insufficient_credits' : `credits_${scenario}`,
        recovery: scenario === 'expiry' ? 'user_action' : 'same_request', sameRequestRetrySafe: scenario !== 'expiry' });
      const receipts = await isolated.runtime.pool.query('SELECT count(*)::int AS n FROM product_command_receipts WHERE principal_id=$1 AND command_id=$2', [fixture.collectionId, commandId]);
      expect(receipts.rows[0].n).toBe(scenario === 'expiry' ? 1 : 0);
      const residues = await isolated.runtime.pool.query('SELECT (SELECT count(*) FROM collection_classification_runs WHERE principal_id=$1)::int AS runs,(SELECT count(*) FROM credit_charges WHERE account_id=$1)::int AS charges', [fixture.collectionId]);
      expect(residues.rows[0]).toEqual({ runs: 0, charges: 0 });
      if (scenario === 'expiry') {
        expect(first.json().error.creditContext).toEqual({ requiredPoints: 1, availablePoints: 0, maxPoints: 1, priceVersion: 'bookmark-classify.v1' });
        await grantCredits(isolated.runtime.db, { accountId: fixture.collectionId, grantKey: 'later-funding', amount: 1 });
      }
      const retry = await send();
      expect(retry.statusCode).toBe(scenario === 'expiry' ? 409 : 201);
      if (scenario === 'expiry') expect(retry.body).toBe(first.body);
    } finally { await app.close(); }
  });
});
