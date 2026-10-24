import { beforeEach, expect, test, vi } from 'vitest';

const f = vi.hoisted(() => ({ resume: vi.fn(), scope: vi.fn(), run: vi.fn(), pending: vi.fn(),
  credential: vi.fn(), restore: vi.fn() }));
vi.mock('../src/sw/runtime.js', () => ({ store: { loadCredential: f.credential }, sw: {}, syncState: {},
  extensionOrigin: () => 'chrome-extension://test', hasBookmarkPermission: async () => true,
  workCoordinator: { run: f.run } }));
vi.mock('../src/sw/scope-rebuild.js', () => ({ replicaRebuilder: () => ({ hasPending: f.pending, resume: f.resume }) }));
vi.mock('../src/sw/scope.js', () => ({ restoredSyncScope: f.scope, currentSyncScope: f.scope,
  createRuntimeAuth: () => ({ ensureFreshCredential: f.restore }), loadConfig: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ runSyncEngine: vi.fn() }));
import { reportReplicaHealth } from '../src/sw/replica-health.js';

beforeEach(() => {
  vi.clearAllMocks();
  f.pending.mockResolvedValue(true);
  f.scope.mockRejectedValue(new Error('not_connected'));
  f.resume.mockResolvedValue(true);
  f.credential.mockResolvedValue({ subject: 'same-account' });
  f.restore.mockResolvedValue({ subject: 'same-account' });
  f.run.mockImplementation(async (_lane: string, work: () => Promise<unknown>) => work());
});

test('the health heartbeat resumes a pending reset before looking for its missing scope', async () => {
  await reportReplicaHealth();
  expect(f.run).toHaveBeenCalledWith('engine', expect.any(Function));
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.scope).toHaveBeenCalledOnce();
  expect(f.resume.mock.invocationCallOrder[0]).toBeLessThan(f.scope.mock.invocationCallOrder[0]!);
});

test('an offline registration is tried on the next heartbeat without an engine wake', async () => {
  f.resume.mockRejectedValueOnce(new Error('network_unavailable'));
  await reportReplicaHealth();
  expect(f.scope).not.toHaveBeenCalled();
  await reportReplicaHealth();
  expect(f.resume).toHaveBeenCalledTimes(2);
  expect(f.scope).toHaveBeenCalledOnce();
});

test('the heartbeat restores the browser-session credential before resuming a durable reset', async () => {
  f.credential.mockResolvedValue(null);
  f.restore.mockRejectedValueOnce(new Error('network_unavailable'));
  await reportReplicaHealth();
  expect(f.resume).not.toHaveBeenCalled();
  expect(f.scope).not.toHaveBeenCalled();
  await reportReplicaHealth();
  expect(f.restore).toHaveBeenCalledTimes(2);
  expect(f.resume).toHaveBeenCalledOnce();
  expect(f.restore.mock.invocationCallOrder[1]).toBeLessThan(f.resume.mock.invocationCallOrder[0]!);
});
