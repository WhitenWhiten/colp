import assert from 'node:assert/strict';
import type { FastifyRequest } from 'fastify';
import { test } from 'vitest';
import { withCancellation } from '../../../src/transport/product/request-timeout.js';
import {
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/unit-of-work.js';
import { fakeKyselyDatabase } from '../../support/fake-kysely-database.js';

const FAVICON_TIMEOUT_MESSAGE = 'Favicon policy is temporarily unavailable.';

function timeoutHarness(): {
  readonly request: FastifyRequest;
  readonly work: (signal: AbortSignal) => Promise<string>;
  readonly aborted: () => boolean;
} {
  let aborted = false;
  const work = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(signal.reason);
    });
  });
  const noop = () => undefined;
  const request = {
    raw: { once: noop, off: noop, socket: { once: noop, off: noop } },
  } as unknown as FastifyRequest;
  return { request, work, aborted: () => aborted };
}

function isUnavailableTimeout(error: unknown, message: string): boolean {
  const failure = error as {
    readonly message?: string;
    readonly statusCode?: number;
    readonly productCode?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly retryAfterSeconds?: number | null;
  };
  return failure.statusCode === 503
    && failure.productCode === 'feature_temporarily_unavailable'
    && failure.message === message
    && failure.headers?.['Retry-After'] === '1'
    && failure.retryAfterSeconds === 1;
}

test('favicon withCancellation aborts the work signal on timeout', async () => {
  const harness = timeoutHarness();
  await assert.rejects(
    () => withCancellation(harness.request, 15, harness.work, FAVICON_TIMEOUT_MESSAGE),
    (error: unknown) => isUnavailableTimeout(error, FAVICON_TIMEOUT_MESSAGE),
  );
  assert.equal(harness.aborted(), true);
});



test('collections unit of work abort cancels the PostgreSQL backend by PID', async () => {
  const cancelled: number[] = [];
  const uow = createPostgresCollectionsUnitOfWork(fakeKyselyDatabase(4_242), {
    cancelBackend: async (pid) => { cancelled.push(pid); return true; },
  });
  const controller = new AbortController();
  const reason = new Error('request timed out');
  const work = uow.execute(async () => {
    controller.abort(reason);
    return 'finished anyway';
  }, { signal: controller.signal });
  await assert.rejects(() => work, /request timed out/);
  assert.deepEqual(cancelled, [4_242]);
});
