import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicationSnapshotPageSeries, releasePublicationSnapshotPage } from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

function pages(): [Snapshot, Snapshot] {
  const first = JSON.parse(readFileSync(resolve(import.meta.dirname,
    '../../fixtures/protocol/examples/collection-snapshot.json'), 'utf8')) as Snapshot;
  const second = structuredClone(first);
  first.page = { sequence: 1, hasMore: true, nextCursor: 'cursor-2' };
  second.page = { sequence: 2, hasMore: false, nextCursor: null };
  return [first, second];
}
const scope = { principal: 'alice', query: {} };
const continuation = { principal: 'alice', query: { pageCursor: 'cursor-2' } };

describe('Snapshot page series and assembly context agree', () => {
  it('rejects a non-first frame at creation', () => {
    const [, second] = pages();
    expect(() => createPublicationSnapshotPageSeries(second, scope)).toThrow(TypeError);
  });
  it.each(['generatedAt', 'complete', 'collection', 'syncCursor'] as const)(
    'rejects changed logical %s metadata', field => {
      const [first, second] = pages();
      const series = createPublicationSnapshotPageSeries(first, scope).series;
      if (field === 'generatedAt') second.generatedAt = '2026-07-17T06:30:00Z';
      if (field === 'complete') second.complete = false;
      if (field === 'collection') second.collection.title = 'Changed collection';
      if (field === 'syncCursor') second.syncCursor = 'other-cursor';
      expect(() => releasePublicationSnapshotPage(series, second, continuation)).toThrow(TypeError);
    },
  );
  it('allows a matching continuation to be retried', () => {
    const [first, second] = pages();
    const series = createPublicationSnapshotPageSeries(first, scope).series;
    expect(releasePublicationSnapshotPage(series, second, continuation)).toEqual(second);
    expect(releasePublicationSnapshotPage(series, second, continuation)).toEqual(second);
  });
  it('keeps Principal binding and forgery rejection', () => {
    const [first, second] = pages();
    const series = createPublicationSnapshotPageSeries(first, scope).series;
    expect(() => releasePublicationSnapshotPage(series, second, { ...continuation, principal: 'bob' })).toThrow(TypeError);
    expect(() => releasePublicationSnapshotPage({} as typeof series, second, continuation)).toThrow(TypeError);
  });
});
