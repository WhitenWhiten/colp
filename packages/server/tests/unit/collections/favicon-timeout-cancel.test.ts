import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyRequest } from 'fastify';
import { test } from 'vitest';
import { withCancellation } from '../../../src/transport/product/request-timeout.js';
import {
  createPostgresCollectionsUnitOfWork,
  createPostgresCollectionChildrenReadUnitOfWork,
} from '../../../src/infrastructure/collections/unit-of-work.js';
import { fakeKyselyDatabase } from '../../support/fake-kysely-database.js';
import { FAVICON_JOB_CANDIDATE_LIMIT } from '../../../src/infrastructure/collections/favicon-job-items-postgres.js';

const FAVICON_TIMEOUT_MESSAGE = 'Favicon policy is temporarily unavailable.';
const CHILDREN_TIMEOUT_MESSAGE = 'Collection children are temporarily unavailable.';

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
    () => withCancellation(harness.request, 15, harness.work),
    (error: unknown) => isUnavailableTimeout(error, FAVICON_TIMEOUT_MESSAGE),
  );
  assert.equal(harness.aborted(), true);
});

test('children withCancellation timeout is not the favicon sentence', async () => {
  const harness = timeoutHarness();
  await assert.rejects(
    () => withCancellation(harness.request, 15, harness.work, CHILDREN_TIMEOUT_MESSAGE),
    (error: unknown) => isUnavailableTimeout(error, CHILDREN_TIMEOUT_MESSAGE)
      && (error as { readonly message?: string }).message !== FAVICON_TIMEOUT_MESSAGE,
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

test('children read unit of work abort cancels the PostgreSQL backend by PID', async () => {
  const cancelled: number[] = [];
  const uow = createPostgresCollectionChildrenReadUnitOfWork(fakeKyselyDatabase(5_151), {
    cursorSigner: { sign: () => 'cursor', verify: () => ({}) },
    cancelBackend: async (pid) => { cancelled.push(pid); return true; },
  } as never);
  const controller = new AbortController();
  const reason = new Error('request timed out');
  const work = uow.execute(async () => {
    controller.abort(reason);
    return 'finished anyway';
  }, { signal: controller.signal });
  await assert.rejects(() => work, /request timed out/);
  assert.deepEqual(cancelled, [5_151]);
});

test('listCandidates SQL is bounded and production UoW wires cancelBackend', () => {
  const listCandidates = readFileSync(fileURLToPath(new URL(
    '../../../src/infrastructure/collections/favicon-job-items-postgres.ts', import.meta.url,
  )), 'utf8');
  const apiPorts = readFileSync(fileURLToPath(new URL(
    '../../../src/bootstrap/api-postgres-ports.ts', import.meta.url,
  )), 'utf8');
  const selector = listCandidates.slice(
    listCandidates.indexOf('async listCandidates(input)'),
    listCandidates.indexOf('interface RestoreRow'),
  );
  assert.match(selector, /order by n\.id/);
  assert.match(selector, /limit \$\{FAVICON_JOB_CANDIDATE_LIMIT\}/);
  assert.equal(FAVICON_JOB_CANDIDATE_LIMIT, 10_000);
  assert.match(apiPorts, /cancelBackend: database\.cancelBackend/);
  assert.equal([...apiPorts.matchAll(/cancelBackend: database\.cancelBackend/g)].length >= 2, true);
  const childrenRoute = readFileSync(fileURLToPath(new URL(
    '../../../src/transport/product/collection-children-routes.ts', import.meta.url,
  )), 'utf8');
  assert.match(childrenRoute, /withCancellation\(request, deps\.timeoutMs, \(signal\) =>/);
  assert.match(childrenRoute, /\{ signal \}/);
  assert.match(childrenRoute, /\{ signal \}\), UNAVAILABLE_MESSAGE\)/);
  assert.match(childrenRoute, /const UNAVAILABLE_MESSAGE = 'Collection children are temporarily unavailable\.'/);
  assert.doesNotMatch(childrenRoute, /Favicon policy is temporarily unavailable\./);
  const helpers = readFileSync(fileURLToPath(new URL(
    '../../../src/transport/colp-sync/sync-favicon-helper-routes.ts', import.meta.url,
  )), 'utf8');
  assert.equal([...helpers.matchAll(/withCancellation\(/g)].length, 4);
  assert.equal([...helpers.matchAll(/\{ signal \}/g)].length, 4);
});
