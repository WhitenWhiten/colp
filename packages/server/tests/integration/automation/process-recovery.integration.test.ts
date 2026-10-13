import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { sql } from 'kysely';
import { automationRuntimeFixture } from '../../support/automation-runtime-fixture.js';
import { automationMixedWorker } from '../../support/automation-mixed-worker.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/index.js';
import { createCollectionNode } from '../../../src/modules/collections/index.js';

describeWithPostgres('M1 real process crash recovery', () => {
  let f: Awaited<ReturnType<typeof automationRuntimeFixture>>;
  let child: ChildProcess | undefined;
  let replacement: ReturnType<typeof automationMixedWorker> | undefined;
  beforeEach(async () => { f = await automationRuntimeFixture('automation_process', true); });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await replacement?.worker.stop();
    await f?.isolated.close();
  });

  test('SIGKILL after effect commit and before ack restarts without a second canonical move', async () => {
    const canonical = createPostgresCanonicalMutationUnitOfWork(f.db, { automationOrigin: 'web' });
    await canonical.execute(ports => createCollectionNode(ports, { actor: f.actor, command: f.command(), collectionId: 'collection',
      parentId: 'root', nodeId: 'crash-paper', afterId: null, beforeId: null, intakeDisposition: 'userDefault',
      node: { kind: 'bookmark', title: 'Crash paper', url: 'https://arxiv.org/process', description: null, tags: [], visibility: 'inherit' } }));
    await f.db.updateTable('outbox_events').set({ available_at: new Date(0) }).where('state', '=', 'pending').execute();
    child = fork(fileURLToPath(new URL('../../support/automation-crash-worker.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, AUTOMATION_TEST_DATABASE_URL: f.isolated.databaseUrl },
    });
    let stderr = '';
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-4000); });
    const processHandle = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Crash window was not reached')), 30000);
      const onExit = () => finish(new Error(`Child exited before effect commit: ${stderr}`));
      const onError = (error: Error) => finish(error);
      const onMessage = (message: unknown) => {
        const signal = message as { type?: string; message?: string };
        if (signal.type === 'effect-committed') finish();
        if (signal.type === 'failure') finish(new Error(signal.message ?? 'Child worker failed'));
      };
      function finish(error?: Error) {
        clearTimeout(timer);
        processHandle.off('exit', onExit); processHandle.off('error', onError); processHandle.off('message', onMessage);
        if (error) reject(error); else resolve();
      }
      processHandle.on('exit', onExit); processHandle.on('error', onError); processHandle.on('message', onMessage);
    });
    const exited = once(processHandle, 'exit'); processHandle.kill('SIGKILL');
    expect((await exited)[1]).toBe('SIGKILL');
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(1);
    const cursor = (await sql<{ ordinal: string }>`SELECT last_inspected_ordinal::text AS ordinal FROM automation_source_positions`.execute(f.db)).rows[0]!.ordinal;
    // Simulate lease expiry only; the committed effect and cursor are not edited.
    await f.db.updateTable('outbox_events').set({ locked_until: new Date(0) }).where('state', '=', 'leased').execute();
    replacement = automationMixedWorker(f.db, f.isolated.runtime.pool);
    for (let pass = 0; pass < 100; pass++) {
      await f.db.updateTable('outbox_events').set({ available_at: new Date(0) }).where('state', 'in', ['pending', 'retryable']).execute();
      await replacement.worker.runOnce();
      if (!(await f.db.selectFrom('outbox_events').select('outbox_id').where('state', '!=', 'completed').execute()).length) break;
    }
    expect(await f.db.selectFrom('outbox_events').select('outbox_id').where('state', '!=', 'completed').execute()).toEqual([]);
    expect((await sql`SELECT id FROM automation_runs`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT id FROM automation_effect_receipts`.execute(f.db)).rows).toHaveLength(1);
    expect((await sql`SELECT operation_id FROM automation_event_facts WHERE facts_json->>'action'='move'`.execute(f.db)).rows).toHaveLength(1);
    expect((await f.db.selectFrom('nodes').select('parent_id').where('id', '=', 'crash-paper').executeTakeFirstOrThrow()).parent_id).toBe('academic');
    const after = (await sql<{ ordinal: string }>`SELECT last_inspected_ordinal::text AS ordinal FROM automation_source_positions`.execute(f.db)).rows[0]!.ordinal;
    expect(BigInt(after)).toBeGreaterThanOrEqual(BigInt(cursor));
  }, 90000);
});
