import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  persistSnapshotOpenConflicts, snapshotOpenConflictDigest, type SnapshotOpenConflict,
} from '../src/snapshot-conflict-recovery.js';

const OPEN = {
  id: 'conflict-open', collectionId: 'collection-1', targetId: 'node-1', type: 'concurrent_field_update',
  field: '/title', incomingOpId: 'op-open', createdAt: '2026-10-03T00:00:00.000Z', status: 'open' as const,
  allowedResolutions: ['server', 'incoming'], revision: 'conflict-r1',
};
const LATER = { ...OPEN, id: 'conflict-later', incomingOpId: 'op-later', revision: 'conflict-r2' };

describe('snapshot open conflict recovery', () => {
  test('persists every page before confirm and keeps the same facts on restart', async () => {
    const persisted: SnapshotOpenConflict[] = [];
    const calls: string[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      calls.push(`${init.method ?? 'GET'}:${parsed.pathname}:${parsed.searchParams.get('offset') ?? ''}`);
      if (init.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { conflictDigest: string };
        assert.equal(body.conflictDigest, snapshotOpenConflictDigest([OPEN, LATER]));
        const latest = persisted.slice(-2).map((conflict) => conflict.id).join(',');
        assert.equal(latest, 'conflict-open,conflict-later');
        return json({ confirmed: true });
      }
      const offset = Number(parsed.searchParams.get('offset'));
      const conflicts = offset === 0 ? [OPEN] : [LATER];
      return json({
        snapshotId: 'snap-1', offset, limit: 50, conflictCount: 2, conflicts,
        nextOffset: offset === 0 ? 1 : null,
      });
    };
    const first = await persistSnapshotOpenConflicts({
      snapshotUrl: 'https://known.example/v1/snapshot', sessionId: 'session-1', snapshotId: 'snap-1',
      headers: { Authorization: 'Bearer test' }, fetch, maxBytes: 64_000,
      persist: async (conflict) => { persisted.push(conflict); },
    });
    assert.equal(first.conflictCount, 2);
    assert.deepEqual(calls, [
      'GET:/v1/snapshot/conflicts:0', 'GET:/v1/snapshot/conflicts:1', 'POST:/v1/snapshot/conflicts:',
    ]);
    const again = await persistSnapshotOpenConflicts({
      snapshotUrl: 'https://known.example/v1/snapshot', sessionId: 'session-1', snapshotId: 'snap-1',
      headers: {}, fetch, maxBytes: 64_000,
      persist: async (conflict) => { persisted.push(conflict); },
    });
    assert.equal(again.conflictDigest, first.conflictDigest);
    assert.deepEqual(persisted.map((conflict) => conflict.id), [
      'conflict-open', 'conflict-later', 'conflict-open', 'conflict-later',
    ]);
  });

  test('does not confirm an empty cut and refuses a private field', async () => {
    const posts: string[] = [];
    await persistSnapshotOpenConflicts({
      snapshotUrl: 'https://known.example/v1/snapshot', sessionId: 'session-1', snapshotId: 'snap-1',
      headers: {}, fetch: async () => json({
        snapshotId: 'snap-1', offset: 0, limit: 50, conflictCount: 0, conflicts: [], nextOffset: null,
      }), maxBytes: 64_000, persist: async () => { throw new Error('unexpected persist'); },
    });
    await assert.rejects(persistSnapshotOpenConflicts({
      snapshotUrl: 'https://known.example/v1/snapshot', sessionId: 'session-1', snapshotId: 'snap-1',
      headers: {}, fetch: async (_url, init) => {
        if (init.method === 'POST') posts.push('post');
        return json({
          snapshotId: 'snap-1', offset: 0, limit: 50, conflictCount: 1,
          conflicts: [{ ...OPEN, base: { title: 'hidden' } }], nextOffset: null,
        });
      }, maxBytes: 64_000, persist: async () => undefined,
    }), /snapshot_conflict_page_invalid/u);
    assert.deepEqual(posts, []);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
