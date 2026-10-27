import { expect, test } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createSiteActivity, currentSiteProblem } from '../src/site-adapters/activity.js';

const adapter = { adapterId: 'fixture.posts', version: '1.0.0', siteKey: 'posts', origin: 'https://private.example/account' };
const environment = { extensionVersion: 'test', browserMajor: 150 };
test('problem snapshots survive reconstruction and retain the first failure through retries and recovery', async () => {
  let now = 1;
  const storage = new MemoryStorageArea(), create = () => createSiteActivity(storage, adapter, environment, () => now);
  const first = await create().record({ kind: 'problem', operation: 'save', code: 'nativeOutcomeUnknown', taskId: 'private-task',
    commandId: 'f48a3478-1a3f-4816-8b2e-987dab3c700a', counts: { read: 12, saved: 4, skipped: 2 },
    reviewSamples: [{ itemId: 'private-item', collectionId: 'private-list', reason: 'primarySourceCollectionRequired' }] });
  now++;
  const retry = await create().record({ kind: 'problem', operation: 'save', code: 'nativeOutcomeUnknown', taskId: 'private-task', counts: { read: 12, saved: 5, skipped: 2 } });
  expect(retry.id).toBe(first.id); expect(retry.occurrences).toBe(2);
  expect(retry.counts?.saved).toBe(4); expect(retry.latestCounts?.saved).toBe(5);
  expect(retry.commandRef).toBe('f48a3478-1a3f-4816-8b2e-987dab3c700a');
  now++;
  await create().resolve('private-task', 'save');
  const copied = await create().report(first.id);
  expect(copied.incident).toMatchObject({ id: first.id, firstAt: 1, resolvedAt: 3, counts: { saved: 4 } });
  expect(copied.adapter).toEqual({ adapterId: adapter.adapterId, version: adapter.version, siteKey: adapter.siteKey });
  expect(JSON.stringify(copied)).not.toContain('private-task');
  expect(copied.incident?.review).toEqual([{ code: 'primarySourceCollectionRequired', itemRef: expect.any(String), collectionRef: expect.any(String) }]);
  expect(JSON.stringify(copied)).not.toContain('private-item'); expect(JSON.stringify(copied)).not.toContain('private-list');
  expect(JSON.stringify(copied)).not.toContain('private.example');
});
test('parallel records do not overwrite each other; installations and ordinary reports are isolated', async () => {
  const storage = new MemoryStorageArea();
  const a = createSiteActivity(storage, adapter, environment), b = createSiteActivity(storage, { ...adapter, adapterId: 'other' }, environment);
  await storage.set({ credential: { token: 'do-not-copy-this' } });
  await Promise.all(Array.from({ length: 12 }, () => a.record({ kind: 'started', operation: 'read' })));
  await b.record({ kind: 'problem', operation: 'read', code: 'signedOut' });
  expect(await a.list()).toHaveLength(12); expect(await b.list()).toHaveLength(1);
  const report = JSON.stringify(await a.report());
  expect(report).not.toContain('do-not-copy-this'); expect(report).not.toContain('signedOut');
});
test('retention stays bounded while keeping unresolved problems and never copies arbitrary exception messages', async () => {
  let now = 0;
  const journal = createSiteActivity(new MemoryStorageArea(), adapter, environment, () => ++now);
  const problem = await journal.record({ kind: 'problem', operation: 'read', code: 'token=secret https://private.example/' });
  for (let i = 0; i < 100; i++) await journal.record({ kind: 'saved', operation: 'save', counts: { read: 1, saved: 1, skipped: 0 } });
  expect(await journal.list()).toHaveLength(80);
  const report = await journal.report(problem.id);
  expect(report.incident?.code).toBe('unclassified'); expect(report.incident?.family).toBe('unknown');
  expect(JSON.stringify(report)).not.toContain('secret');
});
test('expected waits remain distinct from failures and close when the original task makes progress', async () => {
  let now = 1;
  const journal = createSiteActivity(new MemoryStorageArea(), adapter, environment, () => now);
  const waiting = await journal.record({ kind: 'waiting', operation: 'save', code: 'sourceSyncPending', taskId: 'original-task',
    automatic: true, retryAt: 3000, counts: { read: 12, saved: 4, skipped: 2 } });
  now++;
  const again = await journal.record({ kind: 'waiting', operation: 'save', code: 'sourceSyncPending', taskId: 'original-task',
    automatic: true, retryAt: 6000, counts: { read: 12, saved: 4, skipped: 2 } });
  expect(again).toMatchObject({ id: waiting.id, kind: 'waiting', retryAt: 3000, latestRetryAt: 6000, occurrences: 2 });
  expect((await journal.list()).filter(e => e.kind === 'problem')).toEqual([]);
  await journal.resolve('original-task', 'save');
  expect((await journal.report(waiting.id)).incident).toMatchObject({ id: waiting.id, resolvedAt: 2, resolution: 'recovered' });
});
test('recovering connection or configuration errors never clears an uncertain native write', async () => {
  const journal = createSiteActivity(new MemoryStorageArea(), adapter, environment);
  const connection = await journal.record({ kind: 'problem', operation: 'save', taskId: 'task', code: 'sourceAuthorizationChanged' });
  const unknown = await journal.record({ kind: 'problem', operation: 'save', taskId: 'task', code: 'nativeOutcomeUnknown' });
  await journal.resolve('task', 'save', ['sourceAuthorizationChanged', 'previewStale']);
  expect((await journal.report(connection.id)).incident?.resolution).toBe('recovered');
  expect((await journal.report(unknown.id)).incident?.resolvedAt).toBeUndefined();
});
test('recovery progress hides previous task errors while retaining their unresolved history and new configuration failures', async () => {
  const journal = createSiteActivity(new MemoryStorageArea(), adapter, environment);
  const task = await journal.record({ kind: 'problem', operation: 'save', taskId: 'task', phase: 'attention', code: 'sourceDestinationNeedsReview' });
  const scope = { taskId: 'task', phase: 'preparing' };
  expect(currentSiteProblem(await journal.list(), scope)).toBeNull();
  expect((await journal.report(task.id)).incident?.resolvedAt).toBeUndefined();
  const configure = await journal.record({ kind: 'problem', operation: 'configure', taskId: 'management:configure', code: 'sourceAccountChanged' });
  expect(currentSiteProblem(await journal.list(), scope)?.id).toBe(configure.id);
});
test('a new check leaves old incidents in history while failed management retries remain visible until they recover', async () => {
  let now = 1;
  const journal = createSiteActivity(new MemoryStorageArea(), adapter, environment, () => now++);
  await journal.record({ kind: 'problem', operation: 'read', taskId: 'old-check', connectionId: 'current-connection', phase: 'paused', code: 'rateLimited' });
  const scope = { taskId: 'new-check', connectionId: 'current-connection' };
  expect(currentSiteProblem(await journal.list(), scope)).toBeNull();
  const failure = await journal.record({ kind: 'problem', operation: 'recover', taskId: 'management:recover', code: 'sourceStoreUnavailable' });
  expect(currentSiteProblem(await journal.list(), scope)?.id).toBe(failure.id);
  await journal.resolve('management:recover', 'recover');
  expect(currentSiteProblem(await journal.list(), scope)).toBeNull();
  await journal.record({ kind: 'problem', operation: 'save', taskId: 'original-save', connectionId: 'another-connection', code: 'nativeOutcomeUnknown' });
  expect(currentSiteProblem(await journal.list(), scope)).toBeNull();
});
