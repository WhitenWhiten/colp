import { describe, expect, it } from 'vitest';
import { queryCaptureExistence } from '../src/capture/existence.js';
import { transitionCapture } from '../src/capture/state.js';
import { projectFeedback } from '../src/capture/feedback-state.js';
import type { CaptureFeedback } from '../src/capture/contracts.js';

import { location, task } from './fixtures/capture.js';

describe('capture contracts', () => {
  it('checks browser duplicates without a cloud provider and reports its limited coverage', async () => {
    const ports = { local: async () => [] as typeof location[], now: () => 12 };
    expect(await queryCaptureExistence(location.url, ports)).toMatchObject({ kind: 'not-found',
      coverage: { local: 'complete', cloud: 'not-checked' } });
    expect(await queryCaptureExistence(location.url, { ...ports, local: async () => [location] })).toMatchObject({ kind: 'local', exact: [location] });
    expect(await queryCaptureExistence(location.url, { ...ports, local: async () => { throw new Error('permission_required'); } }))
      .toMatchObject({ kind: 'unavailable', coverage: { local: 'unavailable', cloud: 'not-checked' } });
  });
  it('preserves exact query/hash identity, merges mapped nodes and exposes multiple locations', async () => {
    const result = await queryCaptureExistence(location.url, {
      local: async () => [location], now: () => 12,
      cloud: async () => ({ locations: [{ ...location, nativeId: null },
        { ...location, nodeId: 'second', nativeId: null, writable: false },
        { ...location, nodeId: 'similar', url: 'https://example.org/?id=2#section' }],
      collectionIds: ['c'], complete: true, stale: false }),
    });
    expect(result.kind).toBe('multiple');
    expect(result.exact.map(item => [item.nativeId, item.writable])).toEqual([['1', true], [null, false]]);
    expect(result.similar).toHaveLength(1);
    expect(result.coverage.checkedAt).toBe(12);
  });
  it('does not interpret unavailable or partial queries as absence', async () => {
    const offline = await queryCaptureExistence(location.url, {
      local: async () => [], cloud: async () => { throw new Error('offline'); }, now: () => 0,
    });
    expect(offline.kind).toBe('unavailable');
    expect(offline.coverage.cloud).toBe('unavailable');
    const partial = await queryCaptureExistence(location.url, { local: async () => [], now: () => 0,
      cloud: async () => ({ locations: [], collectionIds: ['c'], complete: false, stale: false }) });
    expect(partial.kind).toBe('unavailable');
  });
  it('keeps a lost create receipt unknown and prohibits a second create', () => {
    const pending = transitionCapture(task, { kind: 'submitted', intentId: 'intent' }, 1);
    expect(pending.save).toBe('unknown');
    expect(() => transitionCapture(pending, { kind: 'submitted', intentId: 'other' }, 2)).toThrow();
    expect(() => transitionCapture(pending, { kind: 'save-failed', reason: 'timeout' }, 2)).toThrow();
    const saved = transitionCapture(pending, { kind: 'saved', nativeId: '1', location, sync: 'pending' }, 3);
    expect(transitionCapture(saved, { kind: 'deferred', reason: 'offline' }, 4).save).toBe('local-saved');
  });
  it('blocks late classification after manual editing and across collection/control boundaries', () => {
    const running = { ...task, save: 'local-saved' as const, classification: 'running' as const, executionId: 'e' };
    const apply = { kind: 'applied' as const, decisionId: 'd', revision: 'r', location, manualFence: 0, controlGeneration: 0 };
    expect(() => transitionCapture(transitionCapture(running, { kind: 'manual-edit' }, 1), apply, 2)).toThrow();
    expect(() => transitionCapture(running, { ...apply, controlGeneration: 1 }, 2)).toThrow();
    expect(() => transitionCapture(running, { ...apply, location: { ...location, collectionId: 'other' } }, 2)).toThrow();
    expect(() => transitionCapture(running, { ...apply, location: { ...location, writable: false } }, 2)).toThrow();
    expect(transitionCapture(running, apply, 2)).toMatchObject({ classification: 'applied', sync: 'syncing', localLocation: null });
  });
  it('deduplicates feedback and lets explicit corrections supersede positive ratings', () => {
    const event = (kind: CaptureFeedback['kind'], revision: number): CaptureFeedback => ({ kind, revision,
      eventId: `e${revision}`, captureId: 'c', decisionId: 'd', learningEligible: true, evidenceGeneration: 0 });
    const events = [event('implicit_positive', 1), event('explicit_positive', 2), event('implicit_positive', 3)];
    expect(projectFeedback([...events, events[1]!])?.attitude).toBe(1);
    expect(projectFeedback([...events, event('correction_applied', 4)])?.attitude).toBe(-1);
    expect(projectFeedback([...events, event('withdrawn', 4)])?.attitude).toBeNull();
  });
});
