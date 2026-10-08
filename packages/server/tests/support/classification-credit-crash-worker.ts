import { createDatabaseRuntime } from '../../src/infrastructure/database/index.js';
import { createPostgresAccountCreditsPort } from '../../src/infrastructure/identity/index.js';
import { createPostgresClassificationExecutionStore } from '../../src/infrastructure/collections/classification-execution-postgres.js';
import { runClassificationExecution, type ClassificationExecutionSeed } from '../../src/modules/collections/index.js';
import { creditCrashProvider } from './classification-credit-crash-provider.js';

process.once('message', async (input: { databaseUrl: string; window: string; seed: ClassificationExecutionSeed }) => {
  let phase = 'reserve';
  const pause = async () => {
    process.send?.({ kind: 'paused' });
    await new Promise<void>(() => {});
  };
  const database = createDatabaseRuntime(input.databaseUrl, { maxConnections: 3, applicationName: 'credit-crash-worker' });
  try {
    const store = createPostgresClassificationExecutionStore(database.db, {
      creditEnabled: true, credits: createPostgresAccountCreditsPort, cancelBackend: database.cancelBackend,
      faultInjector: {
        async afterCallbackBeforeCommit() { if (input.window === phase + '_before') await pause(); },
        async afterCommitAcknowledged() { if (input.window === phase + '_after') await pause(); },
      },
    });
    const admitted = await store.admit(input.seed);
    if (admitted.kind !== 'accepted') throw new Error('admission_not_accepted');
    phase = 'work';
    const provider = creditCrashProvider(async () => {
      process.send?.({ kind: 'call' });
      if (input.window === 'dispatch_after') await pause();
    });
    await runClassificationExecution({ ...store, async finish(...args) {
      phase = 'finish';
      return store.finish(...args);
    } }, provider, admitted.executionId, { enabled: () => true, onError: () => {} });
    process.send?.({ kind: 'unexpected_completion' });
  } catch (error) {
    process.send?.({ kind: 'failed', reason: error instanceof Error ? error.message : 'unknown' });
  } finally { await database.close(); }
});
