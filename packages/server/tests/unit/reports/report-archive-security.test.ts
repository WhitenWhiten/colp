import assert from 'node:assert/strict';
import { test } from 'vitest';
import { archiveDigestSeries, ReportsApplicationError } from '../../../src/modules/reports/application/report-commands.js';
import type { ReportTransactionPorts } from '../../../src/modules/reports/application/contracts.js';
import type { DigestSeries } from '../../../src/modules/reports/domain/index.js';

function fixture(role: 'editor' | 'viewer' | null = null) {
  const changed: string[] = [];
  const series: DigestSeries = { id: 'series', ownerSubjectId: 'owner', title: 'Digest', summary: null,
    slug: null, visibility: 'private', allowSearchIndexing: false, state: 'active',
    resourceRevision: 'r1', contentRevision: 'c1', policyRevision: 'p1' };
  const ports: ReportTransactionPorts = {
    receipts: { claim: async () => ({ kind: 'claimed' }), complete: async () => { changed.push('receipt'); }, purgeExpired: async () => 0, deletePrincipalReceipts: async () => 0 },
    revision: { next: () => 'next', etag: value => `"${value}"`, matches: (value, expected) => expected === `"${value}"` },
    ids: { nextResourceId: kind => `${kind}-1`, nextEventId: () => 'event', nextOutboxId: () => 'outbox' },
    clock: { now: () => new Date('2026-10-02T00:00:00Z') },
    series: { insert: async () => undefined, lockById: async () => series,
      update: async (_id, update) => { changed.push('update'); return { ...series, ...update }; },
      nextEditionOrdinal: async () => 1, disableSchedule: async () => { changed.push('schedule'); } },
    editions: { insert: async () => undefined, lockById: async () => null, update: async () => { throw new Error('unused'); } },
    members: { ensureOwner: async () => undefined, get: async (_id, subjectId) => role ? { seriesId: series.id, subjectId, role, revokedAt: null } : null },
    source: { get: async () => null, getMany: async () => [] },
    audit: { append: async () => { changed.push('audit'); } }, outbox: { append: async () => { changed.push('outbox'); } },
  };
  return { ports, changed, uow: { execute: <T>(fn: (p: ReportTransactionPorts) => Promise<T>) => fn(ports) } };
}
const input = { seriesId: 'series', expectedRevision: '"r1"', commandId: '123e4567-e89b-42d3-a456-426614174000' };

for (const role of ['editor', 'viewer', null] as const) {
  test(`a non-owner (${role ?? 'outsider'}) cannot archive or emit lifecycle side effects`, async () => {
    const f = fixture(role);
    await assert.rejects(() => archiveDigestSeries(f.uow, { ...input, actor: { principalId: 'p', subjectId: 'other' } }),
      (error: unknown) => error instanceof ReportsApplicationError && error.code === 'forbidden');
    assert.deepEqual(f.changed, []);
  });
}

test('the owner can archive with a matching revision and disables scheduling', async () => {
  const f = fixture();
  const result = await archiveDigestSeries(f.uow, { ...input, actor: { principalId: 'p', subjectId: 'owner' } });
  assert.equal(result.kind, 'succeeded');
  if (result.kind === 'succeeded') assert.equal(result.value.state, 'archived');
  assert.deepEqual(f.changed, ['update', 'schedule', 'audit', 'outbox', 'receipt']);
});

test('owner archival still enforces the revision precondition', async () => {
  const f = fixture();
  await assert.rejects(() => archiveDigestSeries(f.uow, { ...input, expectedRevision: '"stale"', actor: { principalId: 'p', subjectId: 'owner' } }),
    (error: unknown) => error instanceof ReportsApplicationError && error.code === 'precondition_failed');
  assert.deepEqual(f.changed, []);
});
