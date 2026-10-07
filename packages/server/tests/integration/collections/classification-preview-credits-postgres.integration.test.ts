import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createPostgresAccountCreditsPort } from '../../../src/infrastructure/identity/index.js';
import { createPostgresClassificationExecutionStore } from '../../../src/infrastructure/collections/classification-execution-postgres.js';
import { CLASSIFICATION_POLICY, loadClassificationContext, runClassificationExecution, type ClassificationExecutionSeed } from '../../../src/modules/collections/index.js';
import { createCloudflareJevClassificationProvider, createCloudflareUpstream } from '../../../src/infrastructure/collections/classification-provider-cloudflare-jev.js';
import { canonicalCommandFingerprint } from '../../../src/modules/commands/index.js';
import { runMigrations, type DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import { createPostgresClassificationTaxonomyReadPort } from '../../../src/infrastructure/collections/classification-taxonomy-read.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';
import { seedClassificationTaxonomy } from '../../support/classification-database-fixture.js';

describeWithPostgres('CR-02 managed preview execution billing', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('classification_preview_credits', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());

  const credits = (transaction: DatabaseTransaction, accountId: string) =>
    createPostgresAccountCreditsPort(transaction, accountId);

  async function seedExecution(overrides: Partial<Pick<ClassificationExecutionSeed, 'billing' | 'deadlineAt'>> & { readonly rejectAllFolders?: boolean } = {}) {
    const input = await seedClassificationTaxonomy(isolated.runtime);
    const document = { source: 'web' as const, nodeId: input.nodeId, requested: { folder: true, tags: false },
      ...(overrides.rejectAllFolders ? { rejectedFolderIds: [input.folderId] } : {}) };
    const context = await loadClassificationContext({ ...input, preview: document, tagsEnabled: false },
      createPostgresClassificationTaxonomyReadPort(isolated.runtime.db));
    if (!context) throw new Error('classification context fixture was not created');
    const commandId = randomUUID();
    return {
      input,
      seed: {
        binding: { principalId: input.collectionId, commandScope: 'collections:classification-preview:v1', commandId },
        collectionId: input.collectionId, ownerSubjectId: input.ownerSubjectId, requestId: randomUUID(), context,
        fingerprint: canonicalCommandFingerprint({ method: 'POST', route: `/collections/${input.collectionId}/classification/preview`,
          mediaType: 'application/json', body: { ...document, billing: overrides.billing ?? { priceVersion: 'bookmark-classify.v1', maxPoints: 1 } } }),
        providerId: 'cloudflare_jev', model: 'typesafe/jev', policyVersion: CLASSIFICATION_POLICY.version,
        promptVersion: CLASSIFICATION_POLICY.promptVersion, deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 20_000).toISOString(),
        billing: overrides.billing ?? { priceVersion: 'bookmark-classify.v1', maxPoints: 1 }, source: 'web' as const,
      } satisfies ClassificationExecutionSeed,
    };
  }

  async function grant(accountId: string, amount = 1, expiresAt: Date | null = null) {
    await sql`SELECT * FROM ${sql.id(isolated.schema)}.credit_grant_credits(
      ${accountId}, ${`preview-${randomUUID()}`}, ${amount}::bigint, current_timestamp,
      ${expiresAt}::timestamptz, 'operator', 'manual_grant', 'CR02 preview fixture'
    )`.execute(isolated.runtime.db);
  }

  function store(options: { readonly faultInjector?: { afterCallbackBeforeCommit?(): void } } = {}) {
    return createPostgresClassificationExecutionStore(isolated.runtime.db, {
      creditEnabled: true, credits, ...options,
    });
  }

  test('exhausted alternatives skip the provider and release the managed preview reservation', async () => {
    const { input, seed } = await seedExecution({ rejectAllFolders: true });
    await grant(input.collectionId);
    const executionStore = store(), admission = await executionStore.admit(seed);
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') throw new Error('preview not admitted');
    const transport = vi.fn<typeof fetch>();
    const provider = createCloudflareJevClassificationProvider(createCloudflareUpstream({ accountId: 'a'.repeat(32),
      accessKey: 'fixture-key' }), transport);
    const onError = vi.fn();
    await runClassificationExecution(executionStore, provider, admission.executionId, { enabled: () => true, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    const replay = await executionStore.lookup(seed);
    expect(replay?.kind).toBe('replay');
    if (replay?.kind !== 'replay') throw new Error('preview receipt missing');
    expect(replay.result.status).toBe(200);
    expect(JSON.parse(Buffer.from(replay.result.body).toString())).toMatchObject({ folder: { decision: 'later' },
      creditUsage: { chargedPoints: 0, reservedPoints: 0, releasedPoints: 1 } });
    expect(await isolated.runtime.db.selectFrom('classification_call_attempts').select('execution_id')
      .where('execution_id', '=', admission.executionId).execute()).toHaveLength(0);
    expect((await isolated.runtime.db.selectFrom('credit_charges').select('state')
      .where('account_id', '=', input.collectionId).executeTakeFirstOrThrow()).state).toBe('released');
    expect((await isolated.runtime.db.selectFrom('credit_ledger_entries').select('kind')
      .where('account_id', '=', input.collectionId).execute()).map(row => row.kind)).not.toContain('spend');
  });

  test('stable insufficient receipt commits after claim and creates no execution or charge', async () => {
    const { input, seed } = await seedExecution();
    const result = await store().admit(seed);
    expect(result.kind).toBe('replay');
    if (result.kind === 'replay') {
      expect(result.result.status).toBe(409);
      expect(JSON.parse(Buffer.from(result.result.body).toString()).error.code).toBe('insufficient_credits');
    }
    expect(await isolated.runtime.db.selectFrom('classification_provider_executions').select('id').where('command_id', '=', seed.binding.commandId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('credit_charges').select('id').where('account_id', '=', input.collectionId).execute()).toHaveLength(0);
    expect((await isolated.runtime.db.selectFrom('product_command_receipts').select('completed_at').where('command_id', '=', seed.binding.commandId).executeTakeFirstOrThrow()).completed_at).toBeTruthy();
  });

  test('managed A1 reserves one point and S1 settles it atomically', async () => {
    const { input, seed } = await seedExecution();
    await grant(input.collectionId);
    const admission = await store().admit(seed);
    expect(admission.kind).toBe('accepted');
    if (admission.kind !== 'accepted') return;
    const lease = await store().lease(admission.executionId);
    expect(lease).not.toBeNull();
    await store().prepare(lease!, 'l1', 0, 'digest');
    await store().dispatch(lease!, 'l1', 0);
    await store().completeCall(lease!, 'l1', 0, { answer: {}, modelVersion: 'jev-1.13.0', inputTokens: 10, outputTokens: 1 });
    const success = { status: 200, contractVersion: '1.0.0', mediaType: 'application/json',
      stableHeaders: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' },
      body: Buffer.from('{"ok":true}') };
    expect(await store().finish(lease!, 'succeeded', success)).toBe(true);
    expect(await store().finish(lease!, 'succeeded', success)).toBe(false);
    const receipt = await isolated.runtime.db.selectFrom('product_command_receipts').select('result_bytes')
      .where('command_id', '=', seed.binding.commandId).executeTakeFirstOrThrow();
    expect(JSON.parse(Buffer.from(receipt.result_bytes!).toString()).creditUsage).toMatchObject({
      mode: 'managed', quotedPoints: 1, reservedPoints: 0, chargedPoints: 1, releasedPoints: 0,
    });
    const charge = await isolated.runtime.db.selectFrom('credit_charges').select(['state', 'settled_amount', 'refunded_amount'])
      .where('account_id', '=', input.collectionId).executeTakeFirstOrThrow();
    expect(charge.state).toBe('settled');
    expect(String(charge.settled_amount)).toBe('1');
    expect(String(charge.refunded_amount)).toBe('0');
    expect((await isolated.runtime.db.selectFrom('credit_ledger_entries').select('kind').where('account_id', '=', input.collectionId).execute()).map(row => row.kind))
      .toEqual(['grant', 'reserve', 'spend']);

    await grant(input.collectionId);
    const noCallSeed = { ...seed, binding: { ...seed.binding, commandId: randomUUID() }, requestId: randomUUID() };
    const noCallAdmission = await store().admit(noCallSeed);
    expect(noCallAdmission.kind).toBe('accepted');
    if (noCallAdmission.kind === 'accepted') {
      const noCallLease = await store().lease(noCallAdmission.executionId);
      await store().finish(noCallLease!, 'succeeded', success);
      const noCallReceipt = await isolated.runtime.db.selectFrom('product_command_receipts').select('result_bytes')
        .where('command_id', '=', noCallSeed.binding.commandId).executeTakeFirstOrThrow();
      expect(JSON.parse(Buffer.from(noCallReceipt.result_bytes!).toString()).creditUsage).toMatchObject({
        mode: 'managed', quotedPoints: 1, reservedPoints: 0, chargedPoints: 0, releasedPoints: 1,
      });
    }
  });

  test('two admissions racing for the final point produce one reserve and one stable refusal', async () => {
    const first = await seedExecution();
    await grant(first.input.collectionId);
    const secondSeed = { ...first.seed, binding: { ...first.seed.binding, commandId: randomUUID() }, requestId: randomUUID() };
    const [left, right] = await Promise.all([store().admit(first.seed), store().admit(secondSeed)]);
    expect([left, right].filter(result => result.kind === 'accepted')).toHaveLength(1);
    expect([left, right].filter(result => result.kind === 'replay' && result.result.status === 409)).toHaveLength(1);
    expect(await isolated.runtime.db.selectFrom('credit_charges').select('id').where('account_id', '=', first.input.collectionId).execute()).toHaveLength(1);
  });

  test('F1 releases a managed reservation and the reaper uses the same charge owner', async () => {
    const { input, seed } = await seedExecution();
    await grant(input.collectionId);
    const execution = await store().admit(seed);
    expect(execution.kind).toBe('accepted');
    if (execution.kind !== 'accepted') return;
    const lease = await store().lease(execution.executionId);
    expect(lease).not.toBeNull();
    await store().finish(lease!, 'failed', {
      status: 503, contractVersion: '1.0.0', mediaType: 'application/json',
      stableHeaders: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' }, body: Buffer.from('{}'),
    }, 'unavailable');
    expect((await isolated.runtime.db.selectFrom('credit_charges').select('state').where('account_id', '=', input.collectionId).executeTakeFirstOrThrow()).state)
      .toBe('released');
    const replay = await store().lookup(seed);
    expect(replay?.kind).toBe('replay');

    const reapSeed = { ...seed, binding: { ...seed.binding, commandId: randomUUID() }, requestId: randomUUID() };
    const queued = await store().admit(reapSeed);
    expect(queued.kind).toBe('accepted');
    if (queued.kind === 'accepted') {
      await sql`UPDATE classification_provider_executions SET deadline_at=clock_timestamp()-interval '1 second'
        WHERE id=${queued.executionId}`.execute(isolated.runtime.db);
      expect(await store().reap()).toBeGreaterThanOrEqual(1);
      expect((await isolated.runtime.db.selectFrom('credit_charges').select('state').where('account_id', '=', input.collectionId)
        .orderBy('created_at', 'desc').executeTakeFirstOrThrow()).state).toBe('released');
    }
  });

  test('admission fault before COMMIT rolls back receipt, execution and reserve together', async () => {
    const { input, seed } = await seedExecution();
    await grant(input.collectionId);
    const broken = store({ faultInjector: { afterCallbackBeforeCommit() { throw new Error('preview commit fault'); } } });
    await expect(broken.admit(seed)).rejects.toThrow('preview commit fault');
    expect(await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id').where('command_id', '=', seed.binding.commandId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('classification_provider_executions').select('id').where('command_id', '=', seed.binding.commandId).execute()).toHaveLength(0);
    expect(await isolated.runtime.db.selectFrom('credit_charges').select('id').where('account_id', '=', input.collectionId).execute()).toHaveLength(0);
  });
});
