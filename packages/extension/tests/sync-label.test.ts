import { afterEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { signedInSyncStatus } from '../src/sync-label.js';

afterEach(() => vi.unstubAllGlobals());

function ports(responses: Readonly<Record<string, unknown>>) {
  const storage = new MemoryStorageArea();
  const sendMessage = vi.fn(async (request: { kind: string }) => {
    const result = responses[request.kind];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`unexpected_status_request:${request.kind}`);
    return result;
  });
  vi.stubGlobal('chrome', { storage: { local: storage }, runtime: { sendMessage } });
  return { storage, sendMessage };
}

test.each([['paused', 'paused'], ['disconnected', 'local-only'], ['target-unavailable', 'action-required']])(
  'the persisted personal connection %s is reflected by both signed-in status surfaces', async (mode, kind) => {
    const { sendMessage } = ports({ 'known.personalSync.status': { ok: true, policy: { mode } } });
    expect((await signedInSyncStatus()).kind).toBe(kind);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

test('a failed optional personal-status read retains a completed durable result and an unresolved rejection', async () => {
  ports({ 'known.personalSync.status': new Error('worker restarting'),
    'known.firstRun.status': { ok: true, firstRun: 'completed', phase: 'completed' },
    'known.sync.engine.status': { ok: true, engine: { phase: 'sleeping', hasPendingWork: false, rejectedPending: true } } });
  expect((await signedInSyncStatus()).kind).toBe('action-required');
});

test.each(['response', 'exception'])('unavailable durable status (%s) cannot promote a local deferred draft to Synced', async mode => {
  const failure = mode === 'response' ? { ok: false } : new Error('worker restarting');
  const { storage } = ports({ 'known.personalSync.status': { ok: false },
    'known.firstRun.status': failure, 'known.sync.engine.status': failure });
  await storage.set({ 'known.firstRun.draft.v1': { deferred: true, libraryId: 'library', selected: [], excluded: [] } });
  expect((await signedInSyncStatus()).kind).toBe('setup-required');
});

test('a first-run needs-attention phase is visible even before optional engine status becomes available', async () => {
  ports({ 'known.personalSync.status': {},
    'known.firstRun.status': { ok: true, firstRun: 'running', phase: 'needs_attention',
      attention: { reportId: 'pending-merge', candidateCount: 1, conflictCount: 0, pendingCount: 1 } },
    'known.sync.engine.status': { ok: false } });
  expect((await signedInSyncStatus()).kind).toBe('action-required');
});
