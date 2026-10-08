import { afterEach, expect, test, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import type { BookmarkClassificationProvider } from '../../../src/modules/collections/index.js';
import { createPostgresClassificationRuntime } from '../../../src/infrastructure/collections/classification-runtime.js';

const store = vi.hoisted(() => ({ reap: vi.fn(async () => 0), pending: vi.fn(async () => []) }));
vi.mock('../../../src/infrastructure/collections/classification-execution-postgres.js', () => ({
  createPostgresClassificationExecutionStore: () => store,
}));
vi.mock('../../../src/infrastructure/collections/classification-evidence-postgres.js', () => ({
  pruneClassificationEvidence: async () => {},
}));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

test('blocked credit observation neither delays recovery nor overlaps, and shutdown drains it', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const observe = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const runtime = createPostgresClassificationRuntime({} as Kysely<DatabaseSchema>, {} as BookmarkClassificationProvider,
    { enabled: true, tagsEnabled: false, observeCredits: observe, onError: vi.fn() });
  runtime.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(store.pending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.pending).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = runtime.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await shutdown;
    expect(stopped).toBe(true);
  } finally { finish?.(); await runtime.stop(); }
});
