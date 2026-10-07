import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createReadingProgressCursorSigner, getReadingProgressItem, getReadingProgressPage,
  ReadingProgressQueryError, readingProgressEtag, type ReadingProgressReadPorts } from '../../../src/modules/reading-progress/index.js';

const now = new Date('2026-07-25T12:00:00.000Z');
const signer = createReadingProgressCursorSigner({ current: { id: 'rp-v1', key: 'reading-progress-test-secret' } });
const rows = [
  { resourceType: 'node' as const, resourceId: 'n1', status: 'completed' as const, progress: 1, revision: 3,
    completedAt: new Date('2026-07-25T11:00:00.000Z'), createdAt: new Date('2026-07-20T00:00:00.000Z'), updatedAt: new Date('2026-07-25T11:00:00.000Z') },
  { resourceType: 'node' as const, resourceId: 'n2', status: 'in_progress' as const, progress: .42, revision: 2,
    completedAt: null, createdAt: new Date('2026-07-20T00:00:00.000Z'), updatedAt: new Date('2026-07-25T10:00:00.000Z') },
  { resourceType: 'collection' as const, resourceId: 'c1', status: 'not_started' as const, progress: 0, revision: 1,
    completedAt: null, createdAt: new Date('2026-07-20T00:00:00.000Z'), updatedAt: new Date('2026-07-25T09:00:00.000Z') },
];
function ports(accountId = 'account-a'): ReadingProgressReadPorts {
  return { cursorSigner: signer, clock: { async now() { return now; } }, reads: {
    async get(input) { const row = rows.find((candidate) => candidate.resourceType === input.resourceType && candidate.resourceId === input.resourceId); return row ? { ...row, accountId } : null; },
    async list(input) { const selected = rows.filter((row) => !input.status || row.status === input.status); return selected.slice(0, input.limit + 1).map((row) => ({ ...row, accountId })); },
    async hydrateAccessible(input) { return input.targets.filter((target) => target.resourceId !== 'n2').map((target) => ({ ...target,
      collectionId: target.resourceType === 'collection' ? target.resourceId : 'c1', title: `Title ${target.resourceId}`, url: null })); },
  } };
}
const actor = { accountId: 'account-a', principalId: 'account-a', subjectId: 'subject-a' };

test('P2B-19 item distinguishes absent, explicit not_started and unavailable target without creating rows', async () => {
  let reads = 0; const base = ports(); const p: ReadingProgressReadPorts = { ...base, reads: { ...base.reads,
    async get(input) { reads += 1; return base.reads.get(input); } } };
  const missing = await getReadingProgressItem(p, { actor, resourceType: 'node', resourceId: 'missing' });
  assert.equal(missing, null); assert.equal(reads, 1);
  const notStarted = await getReadingProgressItem(p, { actor, resourceType: 'collection', resourceId: 'c1' });
  assert.equal(notStarted?.status, 'not_started'); assert.equal(notStarted?.progress, 0);
  const unavailable = await getReadingProgressItem(p, { actor, resourceType: 'node', resourceId: 'n2' });
  assert.deepEqual(unavailable?.target, { availability: 'unavailable', collectionId: null, title: null, url: null });
  assert.equal(Object.hasOwn(unavailable!, 'accountId'), false); assert.equal(Object.hasOwn(unavailable!, 'revision'), false);
});

test('P2B-19 list filters status, uses exclusive keyset and batch hydration placeholders', async () => {
  const first = await getReadingProgressPage(ports(), { actor, status: 'in_progress', limit: 1 });
  assert.equal(first.items.length, 1); assert.equal(first.items[0]!.status, 'in_progress');
  assert.deepEqual(first.items[0]!.target, { availability: 'unavailable', collectionId: null, title: null, url: null });
  const all = await getReadingProgressPage(ports(), { actor, limit: 2 });
  assert.deepEqual(all.items.map((item) => item.resourceId), ['n1', 'n2']); assert.ok(all.page.nextCursor);
  await assert.rejects(() => getReadingProgressPage(ports('account-b'), { actor: { ...actor, accountId: 'account-b' }, cursor: all.page.nextCursor! }),
    (error: unknown) => error instanceof ReadingProgressQueryError && error.code === 'invalid_cursor');
});

test('P2B-19 ETags are strong, representation-derived and account isolated', () => {
  const record = { ...rows[1]!, accountId: 'account-a' };
  const etag = readingProgressEtag(record); assert.match(etag, /^"reading-progress:[A-Za-z0-9_-]+"$/);
  assert.notEqual(etag, readingProgressEtag({ ...record, accountId: 'account-b' }));
  assert.notEqual(etag, readingProgressEtag({ ...record, progress: .43 }));
});

test('P2B-19 list rejects the invalid status/limit/cursor matrix before touching reads', async () => {
  const first = await getReadingProgressPage(ports(), { actor, limit: 2 });
  const validCursor = first.page.nextCursor!;
  const cases: Array<{ input: Parameters<typeof getReadingProgressPage>[1]; code: ReadingProgressQueryError['code'] }> = [
    { input: { actor, status: 'bogus' as never }, code: 'invalid_reading_progress_query' },
    { input: { actor, limit: 0 }, code: 'invalid_reading_progress_query' },
    { input: { actor, limit: 101 }, code: 'invalid_reading_progress_query' },
    { input: { actor, cursor: 'x'.repeat(2049) }, code: 'invalid_cursor' },
    { input: { actor, cursor: validCursor, limit: 1 }, code: 'invalid_reading_progress_query' },
    { input: { actor: { ...actor, accountId: '' } }, code: 'invalid_reading_progress_query' },
  ];
  for (const { input, code } of cases) {
    let lists = 0; const base = ports(); const p: ReadingProgressReadPorts = { ...base, reads: { ...base.reads,
      async list(listInput) { lists += 1; return base.reads.list(listInput); } } };
    await assert.rejects(() => getReadingProgressPage(p, input),
      (error: unknown) => error instanceof ReadingProgressQueryError && error.code === code);
    assert.equal(lists, 0, `reads.list must not be called for ${JSON.stringify(input)}`);
  }
  let lists = 0; const base = ports(); const p: ReadingProgressReadPorts = { ...base, reads: { ...base.reads,
    async list(listInput) { lists += 1; return base.reads.list(listInput); } } };
  await assert.rejects(() => getReadingProgressPage(p, { actor, cursor: validCursor, status: 'completed' }),
    (error: unknown) => error instanceof ReadingProgressQueryError && error.code === 'invalid_cursor');
  assert.equal(lists, 0, 'reads.list must not be called for a cursor bound to a different status filter');
});

test('P2B-19 item rejects unknown or blank resource type/id before touching reads', async () => {
  const cases: Array<{ input: Parameters<typeof getReadingProgressItem>[1]; code: ReadingProgressQueryError['code'] }> = [
    { input: { actor, resourceType: 'book' as never, resourceId: 'b1' }, code: 'invalid_reading_progress_query' },
    { input: { actor, resourceType: 'collection', resourceId: '' }, code: 'invalid_reading_progress_query' },
    { input: { actor, resourceType: 'node', resourceId: '  ' }, code: 'invalid_reading_progress_query' },
    { input: { actor, resourceType: 'collection', resourceId: ' x ' }, code: 'invalid_reading_progress_query' },
  ];
  for (const { input, code } of cases) {
    let gets = 0; const base = ports(); const p: ReadingProgressReadPorts = { ...base, reads: { ...base.reads,
      async get(getInput) { gets += 1; return base.reads.get(getInput); } } };
    await assert.rejects(() => getReadingProgressItem(p, input),
      (error: unknown) => error instanceof ReadingProgressQueryError && error.code === code);
    assert.equal(gets, 0, `reads.get must not be called for ${JSON.stringify(input)}`);
  }
});
