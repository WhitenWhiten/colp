import { afterEach, expect, test, vi } from 'vitest';
import { createFirstRunConfirmationSession, FIRST_RUN_DELIVERY_TIMEOUT_MS } from '../src/first-run-confirmation-session.js';
import type { FirstRunConfirmRequest, FirstRunOrScopeResponse } from '../src/types.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const request: FirstRunConfirmRequest = { kind: 'known.firstRun.confirm', previewId: 'preview',
  confirmationId: 'one-reviewed-command', libraryId: 'library' };
const noRun = { ok: true, firstRun: 'none', phase: 'draft' } as const;
function storage() {
  const saved: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: saved[key] }),
    set: async (patch: Record<string, unknown>) => { Object.assign(saved, patch); } } } });
  return saved;
}

test('a reopened page resumes the durable user command with its original id', async () => {
  const saved = storage();
  const page = createFirstRunConfirmationSession({ send: async () => ({ ok: false, error: 'extension_unavailable' }),
    pending: vi.fn(), result: vi.fn() });
  await page.submit(request);
  expect(saved['known.firstRun.confirmation.v1']).toEqual(request);
  page.reset();
  const send = vi.fn(async () => ({ ok: true, firstRun: 'running', phase: 'syncing' } as const));
  const result = vi.fn();
  const reopened = createFirstRunConfirmationSession({ send, pending: vi.fn(), result });
  expect(await reopened.restore('another-library', noRun)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(await reopened.restore('library', noRun)).toBe(true);
  await vi.waitFor(() => expect(result).toHaveBeenCalled());
  expect(send).toHaveBeenCalledExactlyOnceWith(request);
  expect(saved['known.firstRun.confirmation.v1']).toBeNull();
});

test('an empty status while delivery is in flight does not undo submission ownership', async () => {
  storage(); let resolve!: (response: FirstRunOrScopeResponse) => void;
  const result = vi.fn();
  const session = createFirstRunConfirmationSession({ send: () => new Promise(done => { resolve = done; }),
    pending: vi.fn(), result });
  const pending = session.submit(request);
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  expect(session.observeStatus(noRun)).toBe(true);
  expect(session.pending).toBe(true);
  resolve({ ok: true, firstRun: 'running', phase: 'syncing' }); await pending;
  expect(result).toHaveBeenCalledExactlyOnceWith(request, { ok: true, firstRun: 'running', phase: 'syncing' });
});


test('another page running is not a receipt for an unadmitted confirmation', async () => {
  storage(); const result = vi.fn();
  const session = createFirstRunConfirmationSession({ send: async () => ({ ok: false, error: 'extension_unavailable' }),
    pending: vi.fn(), result });
  await session.submit(request);
  const authority = { ok: true, firstRun: 'running', phase: 'syncing',
    confirmation: { confirmationId: request.confirmationId, state: 'missing' } } as const;
  expect(session.statusRequest()).toEqual({ kind: 'known.firstRun.status', confirmationId: request.confirmationId });
  session.observeStatus(authority);
  await vi.waitFor(() => expect(result).toHaveBeenCalledExactlyOnceWith(request,
    { ok: false, error: 'confirmation_superseded' }, authority));
  expect(session.pending).toBe(false);
});

test('an undelivered hanging message retries the same command after a bounded wait and ignores its late callback', async () => {
  storage(); vi.useFakeTimers(); let firstReply!: (response: FirstRunOrScopeResponse) => void;
  const accepted = { ok: true, firstRun: 'running', phase: 'syncing' } as const;
  const send = vi.fn<(request: FirstRunConfirmRequest) => Promise<FirstRunOrScopeResponse>>()
    .mockImplementationOnce(() => new Promise(resolve => { firstReply = resolve; }))
    .mockResolvedValueOnce(accepted);
  const result = vi.fn();
  const session = createFirstRunConfirmationSession({ send, pending: vi.fn(), result });
  const pending = session.submit(request);
  await vi.advanceTimersByTimeAsync(FIRST_RUN_DELIVERY_TIMEOUT_MS - 1);
  session.observeStatus({ ...noRun, confirmation: { confirmationId: request.confirmationId, state: 'missing' } });
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); await pending;
  session.observeStatus({ ...noRun, confirmation: { confirmationId: request.confirmationId, state: 'missing' } });
  await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.calls).toEqual([[request], [request]]);
  expect(result).toHaveBeenCalledExactlyOnceWith(request, accepted);
  firstReply({ ok: false, error: 'preview_stale' }); await vi.advanceTimersByTimeAsync(1);
  expect(result).toHaveBeenCalledTimes(1);
  expect(session.pending).toBe(false);
});

test('reopening with an unrelated completed run replays the saved command instead of discarding its result', async () => {
  const saved = storage(); saved['known.firstRun.confirmation.v1'] = request;
  const result = vi.fn(); const send = vi.fn(async () => ({ ok: false, error: 'preview_stale' } as const));
  const session = createFirstRunConfirmationSession({ send, pending: vi.fn(), result });
  const authority = { ok: true, firstRun: 'completed', phase: 'completed' } as const;
  expect(await session.restore('library', authority)).toBe(true);
  await vi.waitFor(() => expect(result).toHaveBeenCalledExactlyOnceWith(request, { ok: false, error: 'preview_stale' }, authority));
  expect(send).toHaveBeenCalledExactlyOnceWith(request);
});
