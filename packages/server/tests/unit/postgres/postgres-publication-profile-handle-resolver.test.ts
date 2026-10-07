import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresPublicationPublicProfileHandleResolver } from '../../../src/infrastructure/outbox/index.js';

test('profile purge handle lookup cancels its exact PostgreSQL backend and rejects with signal.reason', async () => {
  let rejectLookup!: (error: unknown) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const lookup = new Promise<never>((_resolve, reject) => { rejectLookup = reject; });
  let released = 0;
  const cancelled: number[] = [];
  const client = {
    async query(input: string) {
      if (input === 'select pg_backend_pid() as pid') return { rows: [{ pid: 4242 }] };
      lookupStarted();
      return lookup;
    },
    release() { released += 1; },
  };
  const runtime = {
    pool: { async connect() { return client; } },
    async cancelBackend(pid: number) {
      cancelled.push(pid);
      rejectLookup(Object.assign(new Error('query canceled'), { code: '57014' }));
      return true;
    },
  } as unknown as Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>;
  const controller = new AbortController();
  const reason = new Error('purge timeout');
  const resolving = createPostgresPublicationPublicProfileHandleResolver(runtime)(
    'collection-1',
    controller.signal,
  );
  await started;
  controller.abort(reason);
  await assert.rejects(resolving, (error) => error === reason);
  assert.deepEqual(cancelled, [4242]);
  assert.equal(released, 1);
});
