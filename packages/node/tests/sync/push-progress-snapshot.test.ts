import { describe, expect, it, vi } from 'vitest';

import { snapshotPushPartialProgress } from '../../src/sync/push-partial-progress.js';
import type { PushPartialProgress } from '../../src/sync/index.js';

function progress() {
  return {
    batchId: 'batch-1', serverCursor: 'cursor-1',
    failed: { index: 1, opId: 'denied', replicaId: 'replica-1',
      sequenceScope: 'collection-1', sequence: 1, digest: 'denied-digest' },
    results: [{ opId: 'op-1', sequence: 1, status: 'rebased' as const,
      revision: 'r2', cursor: 'cursor-1', warnings: [], transform: { value: 'before' } }],
  };
}

describe('Push partial-progress snapshot trust boundary', () => {
  it('owns and freezes the frame and individual results', () => {
    const input = progress();
    const owned = snapshotPushPartialProgress(input);
    input.results[0]!.transform.value = 'after';
    input.failed.opId = 'changed';
    expect(owned.results[0]).toMatchObject({ transform: { value: 'before' } });
    expect(owned.failed.opId).toBe('denied');
    expect(Object.isFrozen(owned.results)).toBe(true);
    expect(Object.isFrozen(owned.results[0])).toBe(true);
    expect(Object.isFrozen(owned.failed)).toBe(true);
  });

  it('rejects Proxy and accessor containers without running hooks', () => {
    const hook = vi.fn(() => { throw new Error('must not invoke input hooks'); });
    expect(() => snapshotPushPartialProgress(new Proxy(progress(), { ownKeys: hook }))).toThrow(TypeError);
    const input = progress();
    Object.defineProperty(input.results, '0', { enumerable: true, get: hook });
    expect(() => snapshotPushPartialProgress(input)).toThrow(TypeError);
    expect(() => snapshotPushPartialProgress({ ...progress(),
      results: new Proxy(progress().results, { ownKeys: hook }) })).toThrow(TypeError);
    expect(hook).not.toHaveBeenCalled();
  });

  it('rejects sparse, oversized and individually over-budget prefixes', () => {
    const input = progress();
    expect(() => snapshotPushPartialProgress({ ...input,
      results: new Array<PushPartialProgress['results'][number]>(1) })).toThrow(TypeError);
    expect(() => snapshotPushPartialProgress({ ...input,
      results: Array.from({ length: 1_001 }, () => input.results[0]!) })).toThrow(TypeError);
    const transform = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`k${index}`, index]));
    expect(() => snapshotPushPartialProgress({ ...input,
      results: [{ ...input.results[0]!, transform }] })).toThrow(/maximum JSON member count/);
  });
});
