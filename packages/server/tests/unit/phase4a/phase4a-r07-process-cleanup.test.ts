/**
 * P4A-R07 contract suite: runner process/resource cleanup registry.
 *
 * Every process/stream/client the I16 acceptance opens (R2 stores, PostgreSQL
 * runtimes, the isolated delivery host, the browser app origin) must be
 * closed before the evidence bundle is built; a resource that fails to close
 * makes the run fail closed (`process_cleanup_failed`) and can never be
 * sealed as `processesClosed: true`. The registry is the harness-observable
 * cleanup state: idempotent per resource, failure-reporting (never throwing
 * away the rest of the cleanup), and fail-closed (any unclosed resource keeps
 * `allClosed()` false).
 *
 * The independent validator is the backstop: a bundle whose post-run checks
 * claim `processesClosed: false` (or `residualPrefixClean: false`) is
 * rejected even if the runner-side gate were bypassed.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  I16ProcessRegistry,
  stableI16FailureCode,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  buildI16FixtureEvidence,
  i16PostRunChecks,
} from '../../support/phase4a-i16-test-helpers.js';

// The validator is plain Node ESM; vitest can import it directly.
const validator = await import('../../../scripts/phase4a-i16-validate-evidence.mjs');

function trackingResource(name: string, closeCounts: Map<string, number>, fail = false) {
  return {
    name,
    close: async (): Promise<void> => {
      closeCounts.set(name, (closeCounts.get(name) ?? 0) + 1);
      if (fail) throw new Error(`close boom ${name}`);
    },
  };
}

describe('P4A-R07 process cleanup registry', () => {
  test('registers and closes every resource exactly once', async () => {
    const counts = new Map<string, number>();
    const registry = new I16ProcessRegistry();
    registry.register('r2-rw-store', trackingResource('r2-rw-store', counts).close);
    registry.register('postgres-evidence-schema', trackingResource('postgres-evidence-schema', counts).close);
    registry.register('delivery-host', trackingResource('delivery-host', counts).close);

    assert.equal(registry.allClosed(), false, 'unclosed resources must be observable');
    const outcome = await registry.closeAll();
    assert.deepEqual(outcome.failures, []);
    assert.equal(registry.allClosed(), true);
    assert.equal(registry.isClosed('r2-rw-store'), true);
    assert.deepEqual([...counts.values()], [1, 1, 1]);
  });

  test('closeAll is idempotent and never re-closes a closed resource', async () => {
    const counts = new Map<string, number>();
    const registry = new I16ProcessRegistry();
    registry.register('a', trackingResource('a', counts).close);
    await registry.closeAll();
    await registry.closeAll();
    assert.deepEqual([...counts.values()], [1], 'the second closeAll must be a no-op');
    assert.equal(registry.allClosed(), true);

    // A resource registered AFTER the first closeAll is still closed exactly once.
    registry.register('late', trackingResource('late', counts).close);
    assert.equal(registry.allClosed(), false);
    await registry.closeAll();
    assert.equal(registry.allClosed(), true);
    assert.equal(counts.get('late'), 1);
    assert.equal(counts.get('a'), 1);
  });

  test('a failing close is reported, never thrown, and keeps allClosed false', async () => {
    const counts = new Map<string, number>();
    const registry = new I16ProcessRegistry();
    registry.register('broken', trackingResource('broken', counts, true).close);
    registry.register('healthy', trackingResource('healthy', counts).close);

    const outcome = await registry.closeAll();
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0]!.name, 'broken');
    assert.match(outcome.failures[0]!.reason, /close boom broken/);
    assert.equal(counts.get('healthy'), 1, 'other resources must still be closed');
    assert.equal(registry.allClosed(), false, 'an unclosed resource must keep the registry fail-closed');
    assert.equal(registry.isClosed('broken'), false);
  });

  test('duplicate or empty registrations are rejected', () => {
    const registry = new I16ProcessRegistry();
    registry.register('a', async () => {});
    assert.throws(() => registry.register('a', async () => {}), /process_cleanup_duplicate/);
    assert.throws(() => registry.register('   ', async () => {}), /process_cleanup_name_missing/);
    assert.throws(() => registry.register('', async () => {}), /process_cleanup_name_missing/);
  });

  test('closeAll awaits asynchronous close functions in registration order', async () => {
    const order: string[] = [];
    let firstStartedResolve!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const registry = new I16ProcessRegistry();
    registry.register('first', async () => {
      firstStartedResolve();
      await firstGate;
      order.push('first');
    });
    registry.register('second', async () => {
      order.push('second');
    });
    const closePromise = registry.closeAll();
    await firstStarted;
    assert.deepEqual(order, [], 'the next close must not start while the first remains pending');
    releaseFirst();
    await closePromise;
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(registry.allClosed(), true);
  });
});

describe('P4A-R07 cleanup fail-closed sealing', () => {
  test('a bundle claiming processesClosed:false can never be sealed by the independent validator', () => {
    const bundle = buildI16FixtureEvidence({ postRunChecks: i16PostRunChecks({ processesClosed: false }) });
    const result = validator.validateEvidenceBundle(bundle);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /postrun_not_converged/.test(error)));
  });

  test('a bundle claiming residualPrefixClean:false can never be sealed by the independent validator', () => {
    const bundle = buildI16FixtureEvidence({ postRunChecks: i16PostRunChecks({ residualPrefixClean: false }) });
    const result = validator.validateEvidenceBundle(bundle);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error: string) => /postrun_not_converged/.test(error)));
  });

  test('the schema guard alone permits a false processesClosed field; the validator is the backstop', () => {
    // The runner-side gate throws BEFORE building evidence; the fixed schema
    // still permits the field (it is a recorded fact), so the INDEPENDENT
    // validator must reject any bundle that tries to seal a failed cleanup.
    const bundle = buildI16FixtureEvidence({ postRunChecks: i16PostRunChecks({ processesClosed: false }) });
    assert.equal(bundle.postRunChecks.processesClosed, false);
    const result = validator.validateEvidenceBundle(bundle);
    assert.equal(result.ok, false);
  });

  test('the stable fail-closed codes for cleanup and publish failures are recognized', () => {
    assert.equal(stableI16FailureCode(new Error('process_cleanup_failed:r2-rw-store')), 'process_cleanup_failed');
    assert.equal(stableI16FailureCode(new Error('process_cleanup_duplicate:a')), 'process_cleanup_duplicate');
    assert.equal(stableI16FailureCode(new Error('process_cleanup_name_missing')), 'process_cleanup_name_missing');
    assert.equal(stableI16FailureCode(new Error('evidence_validation_failed:negative_control_missing:size_digest_mismatch')),
      'evidence_validation_failed');
    assert.equal(stableI16FailureCode(new Error('evidence_publish_failed:rename')), 'evidence_publish_failed');
    assert.equal(stableI16FailureCode(new Error('evidence_revision_unpinned')), 'evidence_revision_unpinned');
  });

  test('the registry-based processesClosed fact is a boolean derived from actual closure', async () => {
    const registry = new I16ProcessRegistry();
    registry.register('delivery-host', async () => {});
    registry.register('browser-app-origin', async () => {});
    assert.equal(registry.allClosed(), false, 'before closeAll the fact must be false');
    await registry.closeAll();
    assert.equal(registry.allClosed(), true, 'after closeAll the fact must be true');
  });
});
