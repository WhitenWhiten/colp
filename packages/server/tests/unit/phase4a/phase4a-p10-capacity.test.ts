/**
 * P4A-P10 capacity budget sample contract (plan §9 P10 item 6). The sample
 * schema is a FIXED, low-sensitivity shape: fixed object size / concurrency /
 * instance count plus RSS / FD / pool / Redis memory / DB query facts, with
 * cold-start and warm phases separated and latency marked diagnostic-only.
 * Local rehearsal numbers are NEVER a production SLO: every valid sample must
 * carry the fixed not-SLO limitation token, and any unknown/forbidden field
 * (keys, URLs, credentials, high-cardinality identifiers) is rejected.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CAPACITY_API_INSTANCES_MAX,
  CAPACITY_CONCURRENCY_MAX,
  CAPACITY_NOT_SLO_LIMITATION,
  CAPACITY_OBJECT_SIZE_MAX_BYTES,
  validateCapacitySample,
  type CapacitySample,
} from '../../../src/modules/attachments/index.js';

function validSample(overrides: Record<string, unknown> = {}): CapacitySample {
  return {
    schemaVersion: 1,
    phase: 'warm',
    objectSizeBytes: 8 * 1024,
    concurrency: 2,
    apiInstances: 1,
    process: { rssBytes: 200 * 1024 * 1024, fdCount: 128, activeHandles: 42 },
    postgresPool: { total: 10, idle: 6, active: 4, waiting: 0 },
    redis: { usedMemoryBytes: 2 * 1024 * 1024, connectedClients: 3 },
    dbQueries: 120,
    r2Calls: 60,
    latencyMs: { p50: 12, p95: 45 },
    limitations: [CAPACITY_NOT_SLO_LIMITATION],
    ...overrides,
  } as CapacitySample;
}

describe('P4A-P10 capacity sample schema', () => {
  test('a valid warm sample and a valid cold-start sample pass', () => {
    validateCapacitySample(validSample());
    validateCapacitySample(validSample({ phase: 'cold_start', process: { rssBytes: 300 * 1024 * 1024, fdCount: 64, activeHandles: 20 } }));
  });

  test('bounded fixed inputs: object size / concurrency / instance count have hard ceilings', () => {
    assert.throws(() => validateCapacitySample(validSample({ objectSizeBytes: CAPACITY_OBJECT_SIZE_MAX_BYTES + 1 })), /capacity_sample_object_size/);
    assert.throws(() => validateCapacitySample(validSample({ objectSizeBytes: 0 })), /capacity_sample_object_size/);
    assert.throws(() => validateCapacitySample(validSample({ concurrency: 0 })), /capacity_sample_concurrency/);
    assert.throws(() => validateCapacitySample(validSample({ concurrency: CAPACITY_CONCURRENCY_MAX + 1 })), /capacity_sample_concurrency/);
    assert.throws(() => validateCapacitySample(validSample({ apiInstances: 0 })), /capacity_sample_api_instances/);
    assert.throws(() => validateCapacitySample(validSample({ apiInstances: CAPACITY_API_INSTANCES_MAX + 1 })), /capacity_sample_api_instances/);
  });

  test('all numeric facts must be finite non-negative safe integers', () => {
    assert.throws(() => validateCapacitySample(validSample({ process: { rssBytes: -1, fdCount: 1, activeHandles: 1 } })), /capacity_sample/);
    assert.throws(() => validateCapacitySample(validSample({ process: { rssBytes: 1.5, fdCount: 1, activeHandles: 1 } })), /capacity_sample/);
    assert.throws(() => validateCapacitySample(validSample({ dbQueries: -1 })), /capacity_sample/);
    assert.throws(() => validateCapacitySample(validSample({ postgresPool: { total: 1, idle: 2, active: 1, waiting: 0 } })), /capacity_sample_pool/,
      'idle+active must not exceed total');
  });

  test('latency is diagnostic-only: a sample without the fixed not-SLO limitation is rejected', () => {
    assert.throws(() => validateCapacitySample(validSample({ limitations: [] })), /capacity_sample_limitation/);
    assert.throws(() => validateCapacitySample(validSample({ limitations: ['not an SLO'] })), /capacity_sample_limitation/,
      'only the fixed token satisfies the contract');
    validateCapacitySample(validSample({ latencyMs: null, limitations: [CAPACITY_NOT_SLO_LIMITATION] }),
      'latency may be omitted entirely (diagnostic only)');
  });

  test('phases are sealed to cold_start | warm; fdCount may be null (POSIX-only), activeHandles never', () => {
    assert.throws(() => validateCapacitySample(validSample({ phase: 'idle' })), /capacity_sample_phase/);
    validateCapacitySample(validSample({ process: { rssBytes: 100, fdCount: null, activeHandles: 7 } }),
      'fdCount is POSIX-only and may be null');
    assert.throws(() => validateCapacitySample(validSample({ process: { rssBytes: 100, fdCount: 1, activeHandles: null } })), /capacity_sample_process/);
  });

  test('unknown and forbidden fields are rejected (no keys/URLs/credentials/high-cardinality ids)', () => {
    assert.throws(() => validateCapacitySample(validSample({ blobId: '018f6f7a-8f2a-7a3d-a123-123456789001' })), /capacity_sample_field/);
    assert.throws(() => validateCapacitySample(validSample({ key: 'attachments/live/018f6f7a' })), /capacity_sample_field/);
    assert.throws(() => validateCapacitySample(validSample({ url: 'https://example.test/x?token=abc' })), /capacity_sample_field/);
    assert.throws(() => validateCapacitySample(validSample({ accessKeyId: 'AKIAEXAMPLE00000000' })), /capacity_sample_field/);
    assert.throws(() => validateCapacitySample(validSample({ schemaVersion: 2 })), /capacity_sample_schema/);
  });
});
