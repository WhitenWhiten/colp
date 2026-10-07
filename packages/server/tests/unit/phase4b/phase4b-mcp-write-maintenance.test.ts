import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  McpWriteMaintenanceJob,
  type Phase4bMcpWriteMaintenanceJobLike,
  type Phase4bMcpWriteMaintenancePort,
  type Phase4bMcpWriteRetentionPurgeResult,
} from '../../../src/modules/mcp/index.js';

const EMPTY_PURGE: Phase4bMcpWriteRetentionPurgeResult = Object.freeze({
  receipts: 0,
  approvals: 0,
  plans: 0,
});

afterEach(() => {
  vi.useRealTimers();
});

test('MCP Write maintenance tick expires plans before purging retained rows', async () => {
  const order: string[] = [];
  const results: Array<{
    expiredPlans: number;
    purge: Phase4bMcpWriteRetentionPurgeResult;
  }> = [];
  const operations: Phase4bMcpWriteMaintenancePort = {
    async expireDuePlans() {
      order.push('expire');
      return 2;
    },
    async purgeRetained() {
      order.push('purge');
      return Object.freeze({ receipts: 3, approvals: 2, plans: 1 });
    },
  };
  const job = new McpWriteMaintenanceJob(operations, {
    intervalMs: 60_000,
    onResult(result) {
      results.push(result);
    },
  });

  await job.tick();

  assert.deepEqual(order, ['expire', 'purge']);
  assert.deepEqual(results, [{
    expiredPlans: 2,
    purge: { receipts: 3, approvals: 2, plans: 1 },
  }]);
});

test('MCP Write maintenance job is non-reentrant, reports errors, and retries', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const errors: unknown[] = [];
  const operations: Phase4bMcpWriteMaintenancePort = {
    async expireDuePlans() {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (calls === 2) throw new Error('temporary maintenance failure');
      return 0;
    },
    async purgeRetained() {
      return EMPTY_PURGE;
    },
  };
  const job = new McpWriteMaintenanceJob(operations, {
    intervalMs: 60_000,
    onError(error) {
      errors.push(error);
    },
  });

  const first = job.tick();
  await Promise.resolve();
  await job.tick();
  assert.equal(calls, 1, 'a second tick must not re-enter while the first is active');
  release?.();
  await first;
  await job.tick();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /temporary maintenance failure/u);
  await job.tick();
  assert.equal(calls, 3, 'a later tick must retry after an error');
});

test('MCP Write maintenance job starts, stops, and unrefs its timer', async () => {
  vi.useFakeTimers();
  let ticks = 0;
  const operations: Phase4bMcpWriteMaintenancePort = {
    async expireDuePlans() {
      ticks += 1;
      return 0;
    },
    async purgeRetained() {
      return EMPTY_PURGE;
    },
  };
  const job = new McpWriteMaintenanceJob(operations, { intervalMs: 1_000 });

  job.start();
  job.start();
  await vi.advanceTimersByTimeAsync(2_500);
  assert.equal(ticks, 2);

  job.stop();
  const stoppedTicks = ticks;
  await vi.advanceTimersByTimeAsync(100);
  assert.equal(ticks, stoppedTicks);
});

test('MCP Write maintenance job rejects unbounded or zero intervals', () => {
  const operations: Phase4bMcpWriteMaintenancePort = {
    async expireDuePlans() {
      return 0;
    },
    async purgeRetained() {
      return EMPTY_PURGE;
    },
  };

  for (const intervalMs of [0, 999, 3_600_001]) {
    assert.throws(
      () => new McpWriteMaintenanceJob(operations, { intervalMs }),
      /maintenance interval/u,
      `${intervalMs} must be rejected`,
    );
  }
});

test('buildWorker starts and stops an injected MCP Write maintenance job', async () => {
  vi.useFakeTimers();
  const starts: string[] = [];
  const stops: string[] = [];
  const job: Phase4bMcpWriteMaintenanceJobLike = {
    start() {
      starts.push('start');
    },
    stop() {
      stops.push('stop');
    },
  };
  const worker = buildWorker(
    loadConfig({
      DATABASE_URL: 'postgres://localhost/known',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
      KNOWN_FEATURE_MCP_WRITE: 'true',
    }),
    undefined,
    new InMemoryMetrics(),
    { mcpWriteMaintenanceJob: job },
  );

  await worker.start();
  assert.deepEqual(starts, ['start']);
  await worker.stop();
  assert.deepEqual(stops, ['stop']);
});

test('production worker source wires MCP Write maintenance and stops it', async () => {
  const source = await readFile(
    new URL('../../../src/bootstrap/worker.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /config\.mcpWriteEnabled && database/u);
  assert.match(source, /createPostgresMcpWriteOperationsStore\(database\.db\)/u);
  assert.match(source, /McpWriteMaintenanceJob\(/u);
  assert.match(source, /mcpWriteMaintenanceJob\?\.stop\(\)/u);
});
