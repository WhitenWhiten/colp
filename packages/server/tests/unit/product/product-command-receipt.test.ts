/**
 * Product command identity, replay headers, scheduled purge, and (P1-14) retention
 * cleanup → compact claim → expired / restore semantics via production evidence port.
 *
 * PostgreSQL retention is covered by product-command-receipt.integration.test.ts;
 * unit coverage uses createSimulatedProductCommandReceiptPort (no DB).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, test, vi } from 'vitest';
import {
  createSimulatedProductCommandReceiptPort,
  simulateCommandRetentionCleanupRestore,
} from '../../../scripts/evidence/index.js';
import {
  assertCanonicalCommandId,
  canonicalCommandFingerprint,
  canonicalJson,
  deleteAccountReceipts,
  stableReplayHeaders,
  scheduleReceiptPurge,
  type ProductCommandBinding,
  type ProductCommandResult,
} from '../../../src/modules/commands/index.js';

afterEach(() => { vi.useRealTimers(); });

function sampleBinding(overrides: Partial<ProductCommandBinding> = {}): ProductCommandBinding {
  return {
    principalId: 'principal-receipt-1',
    commandScope: 'collection:create',
    commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a',
    ...overrides,
  };
}

function sampleResult(overrides: Partial<ProductCommandResult> = {}): ProductCommandResult {
  return {
    status: 201,
    body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    stableHeaders: { 'content-type': 'application/json', etag: '"r1"' },
    mediaType: 'application/json',
    contractVersion: '1.0.0',
    targetIdentity: 'collection:new',
    ...overrides,
  };
}

describe('Product command identity and canonical fingerprint', () => {
  test('schedules bounded purge through a fresh port factory', async () => {
    vi.useFakeTimers();
    let factoryCalls = 0;
    let purges = 0;
    const handle = scheduleReceiptPurge(async () => {
      factoryCalls += 1;
      return {
        claim: async () => ({ kind: 'claimed' as const }),
        complete: async () => undefined,
        purgeExpired: async (options?: { readonly limit?: number }) => {
          assert.equal(options?.limit, 7);
          purges += 1;
          return 7;
        },
        deletePrincipalReceipts: async () => 0,
      };
    }, { intervalMs: 100, batchSize: 7 });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();
    assert.equal(factoryCalls, 2);
    assert.equal(purges, 2);
  });

  test('accepts only canonical lowercase UUID v4 command IDs', () => {
    const valid = '5de3947e-6271-4fdf-a946-d22e58a99c2a';
    assert.equal(assertCanonicalCommandId(valid), valid);

    for (const invalid of [
      valid.toUpperCase(),
      '{5de3947e-6271-4fdf-a946-d22e58a99c2a}',
      '5de3947e-6271-1fdf-a946-d22e58a99c2a',
      '5de3947e-6271-4fdf-7946-d22e58a99c2a',
      'not-a-uuid',
    ]) assert.throws(() => assertCanonicalCommandId(invalid), /canonical lowercase UUID v4/);
  });

  test('canonicalizes object keys recursively while preserving array order', () => {
    assert.equal(
      canonicalJson({ z: [{ b: 2, a: 1 }], omitted: undefined, a: true }),
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
    assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
  });

  test('rejects invalid Unicode in object keys and values and unsafe integers', () => {
    for (const invalid of [
      { ['\ud800']: 'key-high-surrogate' },
      { ['\udc00']: 'key-low-surrogate' },
      { value: '\ud800' },
      { value: '\udc00' },
    ]) assert.throws(() => canonicalJson(invalid), /valid Unicode/);

    for (const invalid of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      assert.throws(() => canonicalJson({ value: invalid }), /safe integers/);
    }
  });

  test('normalizes method, media type and key order into one fingerprint', () => {
    const first = canonicalCommandFingerprint({
      method: 'post', route: 'createCollection', resource: 'account:one',
      mediaType: 'APPLICATION/JSON', query: { view: 'editor', a: '1' },
      conditions: { ifMatch: '"r1"' }, body: { title: 'Known', kind: 'bookmarks' },
    });
    const same = canonicalCommandFingerprint({
      method: 'POST', route: 'createCollection', resource: 'account:one',
      mediaType: 'application/json', query: { a: '1', view: 'editor' },
      conditions: { ifMatch: '"r1"' }, body: { kind: 'bookmarks', title: 'Known' },
    });
    assert.equal(first, same);
    assert.match(first, /^[0-9a-f]{64}$/);
  });

  test('fingerprints every authoritative request dimension but excludes dynamic evidence', () => {
    const base = {
      method: 'PATCH', route: 'updateNode', resource: 'node:one',
      mediaType: 'application/merge-patch+json', query: { view: 'summary' },
      conditions: { ifMatch: '"r1"' }, body: { title: 'Known' },
    } as const;
    const fingerprint = canonicalCommandFingerprint(base);

    for (const changed of [
      { ...base, method: 'PUT' },
      { ...base, route: 'moveNode' },
      { ...base, resource: 'node:two' },
      { ...base, mediaType: 'application/json' },
      { ...base, query: { view: 'editor' } },
      { ...base, conditions: { ifMatch: '"r2"' } },
      { ...base, body: { title: 'Changed' } },
    ]) assert.notEqual(canonicalCommandFingerprint(changed), fingerprint);

    // Origin, CSRF, cookies, request IDs and tracing are deliberately absent from the API.
    assert.deepEqual(Object.keys(base).sort(), [
      'body', 'conditions', 'mediaType', 'method', 'query', 'resource', 'route',
    ]);
  });
});

describe('Product command stable replay headers', () => {
  test('normalizes the replay allowlist and removes per-request response headers', () => {
    assert.deepEqual(stableReplayHeaders({
      ETag: '"r2"',
      Location: '/api/v1/collections/collection-1',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'X-Request-Id': 'request-that-must-not-replay',
      Date: 'Wed, 01 Jan 2026 00:00:00 GMT',
      Traceparent: '00-trace-span-01',
      'RateLimit-Remaining': '1',
      'Retry-After': '1',
    }), {
      etag: '"r2"',
      location: '/api/v1/collections/collection-1',
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    });
  });

  test('rejects sensitive, hop-by-hop and unregistered response headers', () => {
    for (const name of ['set-cookie', 'connection', 'x-unreviewed-result']) {
      assert.throws(() => stableReplayHeaders({ [name]: 'must-not-persist' }), /safe for command replay/i);
    }
  });
});

describe('P1-14 command retention cleanup / compact / restore (evidence port)', () => {
  test('simulateCommandRetentionCleanupRestore passes and maps to command_result_expired', async () => {
    const evidence = await simulateCommandRetentionCleanupRestore();
    assert.equal(evidence.passed, true);
    assert.equal(evidence.fullResultRetentionDays, 30);
    assert.equal(evidence.sameFingerprintAfterPurge, 'expired');
    assert.equal(evidence.differentFingerprintAfterPurge, 'reused');
    assert.equal(evidence.mapsToProductError, 'command_result_expired');
    assert.equal(evidence.compactClaimRetained, true);
    assert.ok(evidence.steps.some((s) => s.step === 'purge_expired_full_result' && s.claimKind === 'purged'));
    assert.ok(evidence.steps.some((s) => s.step === 'same_fingerprint_after_compact' && s.claimKind === 'expired'));
  });

  test('full result replays until purge; after purge returns expired compact claim', async () => {
    const store = new Map();
    let now = Date.parse('2026-07-01T00:00:00.000Z');
    const port = createSimulatedProductCommandReceiptPort(store, { now: () => now });
    const binding = sampleBinding();
    const fingerprint = 'a'.repeat(64);
    const result = sampleResult();

    assert.deepEqual(await port.claim(binding, fingerprint), { kind: 'claimed' });
    await port.complete(binding, fingerprint, result);

    const replay = await port.claim(binding, fingerprint);
    assert.equal(replay.kind, 'replay');
    if (replay.kind === 'replay') {
      assert.equal(replay.result.status, 201);
      assert.equal(replay.result.contractVersion, '1.0.0');
    }

    // Still within 30-day window — purge is a no-op
    now = Date.parse('2026-07-15T00:00:00.000Z');
    assert.equal(await port.purgeExpired(), 0);
    assert.equal((await port.claim(binding, fingerprint)).kind, 'replay');

    // Past result_expires_at — compact permanent claim, body removed
    now = Date.parse('2026-08-01T00:00:01.000Z');
    assert.equal(await port.purgeExpired({ limit: 10 }), 1);
    assert.equal(await port.purgeExpired(), 0);

    const expired = await port.claim(binding, fingerprint);
    assert.equal(expired.kind, 'expired');
    if (expired.kind === 'expired') {
      assert.match(expired.resultDigest ?? '', /^[0-9a-f]{64}$/);
      const expectedDigest = createHash('sha256')
        .update(Buffer.from(result.body))
        .digest('hex');
      assert.equal(expired.resultDigest, expectedDigest);
    }

    // Same command id + different fingerprint still reused (permanent claim)
    assert.equal((await port.claim(binding, 'b'.repeat(64))).kind, 'reused');
  });

  test('purge respects batch limit and onPurged callback', async () => {
    const store = new Map();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const port = createSimulatedProductCommandReceiptPort(store, { now: () => now });
    const fingerprint = 'c'.repeat(64);

    for (let i = 0; i < 5; i += 1) {
      const binding = sampleBinding({
        commandId: `5de3947e-6271-4fdf-a946-d22e58a99c2${i}`,
      });
      assert.equal((await port.claim(binding, fingerprint)).kind, 'claimed');
      await port.complete(binding, fingerprint, sampleResult({
        body: new TextEncoder().encode(JSON.stringify({ i })),
      }));
    }

    now = Date.parse('2026-02-15T00:00:00.000Z');
    let reported = -1;
    const firstBatch = await port.purgeExpired({
      limit: 2,
      onPurged: (count) => { reported = count; },
    });
    assert.equal(firstBatch, 2);
    assert.equal(reported, 2);

    const secondBatch = await port.purgeExpired({ limit: 10 });
    assert.equal(secondBatch, 3);
  });

  test('deleteAccountReceipts removes all principal rows (restore-prep cleanup)', async () => {
    const store = new Map();
    const now = Date.parse('2026-07-22T00:00:00.000Z');
    const port = createSimulatedProductCommandReceiptPort(store, { now: () => now });
    const fingerprint = 'd'.repeat(64);
    const principalId = 'principal-to-delete';

    for (const scope of ['collection:a', 'collection:b']) {
      const binding = sampleBinding({
        principalId,
        commandScope: scope,
        commandId: scope === 'collection:a'
          ? '5de3947e-6271-4fdf-a946-d22e58a99c2a'
          : '5de3947e-6271-4fdf-a946-d22e58a99c2b',
      });
      assert.equal((await port.claim(binding, fingerprint)).kind, 'claimed');
      await port.complete(binding, fingerprint, sampleResult());
    }

    // Unrelated principal remains claimable for replay after delete
    const other = sampleBinding({
      principalId: 'principal-other',
      commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2c',
    });
    assert.equal((await port.claim(other, fingerprint)).kind, 'claimed');
    await port.complete(other, fingerprint, sampleResult());

    const deleted = await deleteAccountReceipts(port, principalId);
    assert.equal(deleted, 2);

    // Deleted principal can claim again (no compact leftover — full remove)
    const restoreBinding = sampleBinding({
      principalId,
      commandScope: 'collection:a',
      commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a',
    });
    assert.equal((await port.claim(restoreBinding, fingerprint)).kind, 'claimed');

    assert.equal((await port.claim(other, fingerprint)).kind, 'replay');
  });

  test('in_progress claim is not purged and does not surface as expired', async () => {
    const store = new Map();
    let now = Date.parse('2026-07-01T00:00:00.000Z');
    const port = createSimulatedProductCommandReceiptPort(store, { now: () => now });
    const binding = sampleBinding();
    const fingerprint = 'e'.repeat(64);

    assert.deepEqual(await port.claim(binding, fingerprint), { kind: 'claimed' });
    now = Date.parse('2026-09-01T00:00:00.000Z');
    assert.equal(await port.purgeExpired(), 0);
    assert.deepEqual(await port.claim(binding, fingerprint), {
      kind: 'in_progress',
      retryAfterSeconds: 1,
    });
  });
});

