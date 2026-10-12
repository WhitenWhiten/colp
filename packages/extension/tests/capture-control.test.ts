import { beforeEach, expect, it, vi } from 'vitest';
import { task } from './fixtures/capture.js';
import { DEFAULT_BOOKMARK_PREFERENCES } from '../src/bookmark-preferences.js';
import { captureScopeKey, type CaptureTask } from '../src/capture/contracts.js';
const f = vi.hoisted(() => ({ storage: {} as Record<string, unknown>, scope: { serverOrigin: 'https://example.org', accountId: 'account' as string | null, authorityGeneration: 1, collectionId: 'c' as string | null }, tasks: [] as CaptureTask[], resume: vi.fn(), inspect: vi.fn(), mode: 'manual' as 'manual' | 'automatic', local: false, product: vi.fn() }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope, assertCaptureScope: async () => {} }));
vi.mock('../src/sw/capture.js', () => ({ captureStore: { listForOwner: async () => f.tasks, update: async (next: CaptureTask) => { f.tasks = f.tasks.map(task => task.captureId === next.captureId ? next : task); } }, resumeCapture: f.resume }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ handleBookmarkPreferencesRequest: async () => ({ ok: true, preferences: { captureMode: f.mode }, pending: false, conflict: false }) }));
vi.mock('../src/classification-local-session.js', async original => ({ ...await original<object>(), localClassificationEnabled: async () => f.local }));
vi.mock('../src/classification-product-client.js', () => ({ createClassificationProductClient: f.product }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true }));
vi.mock('../src/sw/capture-target.js', () => ({ captureTarget: async () => ({ nativeId: '1', path: ['Bookmarks'], inRange: true, collectionId: 'c', collectionTitle: 'Library' }) }));
vi.mock('../src/sw/capture-result-recovery.js', () => ({ inspectCaptureDecision: f.inspect }));
import { handleCaptureControl } from '../src/sw/capture-control.js';
import { canResumeCapture, validCaptureControlRequest } from '../src/capture/runtime-control.js';
import { effectiveCaptureState, effectiveSaveState, readCaptureControl } from '../src/capture/control.js';
import { LOCAL_CLASSIFICATION_KEY } from '../src/classification-local-session.js';
beforeEach(() => {
  f.storage = {}; f.tasks = []; f.resume.mockReset().mockResolvedValue(task); f.inspect.mockReset().mockResolvedValue(task);
  f.mode = 'manual'; f.local = false; f.scope.accountId = 'account'; f.scope.collectionId = 'c';
  f.product.mockReset().mockImplementation(() => { throw new Error('unexpected Product request'); });
  vi.stubGlobal('navigator', { onLine: false });
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: f.storage[key] }), set: async (values: Record<string, unknown>) => Object.assign(f.storage, values) } } });
});
it.each([true, false])('automatic saving is ready without classification or Product access while online=%s', async online => {
  f.mode = 'automatic'; f.scope.accountId = null; f.scope.collectionId = null;
  vi.stubGlobal('navigator', { onLine: online });
  expect(await handleCaptureControl({ kind: 'known.capture.control' })).toMatchObject({ state: 'automatic', classificationState: 'off', signedIn: false });
  expect(f.product).not.toHaveBeenCalled();
});
it('signed-in local saving does not check cloud policy without classification authorization', async () => {
  f.mode = 'automatic'; vi.stubGlobal('navigator', { onLine: true });
  expect(await handleCaptureControl({ kind: 'known.capture.control' })).toMatchObject({ state: 'automatic', classificationState: 'off' });
  expect(f.product).not.toHaveBeenCalled();
});
it('pausing optional local classification leaves automatic saving ready and offline provider state visible separately', async () => {
  f.mode = 'automatic'; f.local = true;
  expect(await handleCaptureControl({ kind: 'known.capture.control' })).toMatchObject({ state: 'automatic', classificationState: 'offline' });
  const result = await handleCaptureControl({ kind: 'known.capture.control.change', action: 'pause', commandId: crypto.randomUUID(), generation: 0, scopeKey: captureScopeKey(f.scope) });
  expect(result).toMatchObject({ state: 'automatic', classificationState: 'paused' });
});
it.each([
  ['http://localhost:8080/classify', 'automatic'], ['http://127.0.0.1:8080/classify', 'automatic'],
  ['http://[::1]:8080/classify', 'automatic'], ['https://api.typesafe.ai/v1/systemone', 'offline'],
  ['http://192.168.1.20:8080/classify', 'offline'],
])('offline own-AI controls show %s as %s without Product access', async (endpoint, classificationState) => {
  f.mode = 'automatic'; f.local = true; f.scope.accountId = null; f.scope.collectionId = null;
  f.storage[LOCAL_CLASSIFICATION_KEY] = { endpoint };
  expect(await handleCaptureControl({ kind: 'known.capture.control' })).toMatchObject({ state: 'automatic', classificationState, signedIn: false });
  expect(f.product).not.toHaveBeenCalled();
});
it('native saving only requires the chosen mode, bookmark permission and a destination', () => {
  const preferences = { ...DEFAULT_BOOKMARK_PREFERENCES, captureMode: 'automatic' as const };
  const control = { paused: true, generation: 0, consent: null };
  expect(effectiveSaveState(preferences, control, { permission: true, target: true })).toBe('automatic');
  expect(effectiveSaveState(preferences, control, { permission: false, target: true })).toBe('permission_required');
  expect(effectiveSaveState(preferences, control, { permission: true, target: false })).toBe('target_unavailable');
});
it('persists pause before returning, replays the same command and rejects stale or foreign controls', async () => {
  const command = { kind: 'known.capture.control.change' as const, action: 'pause' as const, commandId: crypto.randomUUID(), generation: 0, scopeKey: captureScopeKey(f.scope) };
  expect(validCaptureControlRequest(command)).toBe(true);
  await Promise.all([handleCaptureControl(command), handleCaptureControl(command)]);
  expect(await readCaptureControl(f.scope)).toMatchObject({ paused: true, generation: 1 });
  await expect(handleCaptureControl({ ...command, commandId: crypto.randomUUID() })).rejects.toThrow('capture_control_conflict');
  await expect(handleCaptureControl({ ...command, scopeKey: 'other-account' })).rejects.toThrow('capture_scope_changed');
  expect(f.resume).not.toHaveBeenCalled();
});
it('resume eligibility excludes submitted work, old accounts, manual edits and expired authorization', () => {
  const now = Date.now(), current = { ...task, scope: f.scope, automaticIntent: true, save: 'local-saved' as const, createdAt: now,
    billingAuthorization: { collectionId: 'c', priceVersion: 'p', maxPoints: 1, periodPoints: 10, expiresAt: now + 1000 } };
  expect(canResumeCapture(current, f.scope, now)).toBe(true);
  expect(canResumeCapture({ ...current, manualFence: 1 }, f.scope, now)).toBe(false);
  expect(canResumeCapture(current, { ...f.scope, accountId: 'other' }, now)).toBe(false);
  expect(canResumeCapture(current, f.scope, now + 2000)).toBe(false);
  expect(canResumeCapture({ ...current, automatic: {} as CaptureTask['automatic'] }, f.scope, now)).toBe(false);
  expect(canResumeCapture({ ...current, billingAuthorization: undefined, local: { commandId: null, state: 'waiting' } }, f.scope, now)).toBe(true);
  expect(canResumeCapture({ ...current, billingAuthorization: undefined, local: { commandId: 'spent', state: 'unknown' } }, f.scope, now)).toBe(false);
});
it('unifies local pause, mode, permissions, conflicts, authorization and policy states', () => {
  const preferences = { ...DEFAULT_BOOKMARK_PREFERENCES, captureMode: 'automatic' as const };
  const input = { account: true, permission: true, policy: true, collectionId: 'c', now: 1 };
  const control = { paused: false, generation: 0, consent: { collectionId: 'c', priceVersion: 'p', maxPoints: 1, periodPoints: 10, expiresAt: 10 } };
  expect(effectiveCaptureState(preferences, control, input)).toBe('automatic');
  expect(effectiveCaptureState(preferences, { ...control, paused: true }, input)).toBe('paused');
  expect(effectiveCaptureState(preferences, { ...control, manualOverride: true }, input)).toBe('manual');
  expect(effectiveCaptureState(preferences, control, { ...input, conflict: true })).toBe('preferences_conflict');
  expect(effectiveCaptureState(preferences, control, { ...input, policy: false })).toBe('policy_unavailable');
  expect(effectiveCaptureState(preferences, control, { ...input, now: 20 })).toBe('authorization_required');
  // Local-first: the user's own provider needs no account, authorization, policy, credits or synced folder.
  const signedOut = { account: false, permission: true, policy: false, collectionId: null, now: 20, inRange: false, credits: false, local: true };
  expect(effectiveCaptureState(preferences, { ...control, consent: null }, signedOut)).toBe('automatic');
  expect(effectiveCaptureState(preferences, { ...control, paused: true }, signedOut)).toBe('paused');
  expect(effectiveCaptureState(preferences, control, { ...signedOut, permission: false })).toBe('permission_required');
  expect(effectiveCaptureState(preferences, control, { ...signedOut, online: false })).toBe('offline');
  const offlineLoopback = { ...signedOut, online: false, localOffline: true };
  expect(effectiveCaptureState(preferences, control, offlineLoopback)).toBe('automatic');
  expect(effectiveCaptureState(preferences, control, { ...offlineLoopback, conflict: true })).toBe('preferences_conflict');
  expect(effectiveCaptureState(preferences, { ...control, paused: true }, offlineLoopback)).toBe('paused');
  expect(effectiveCaptureState(preferences, { ...control, manualOverride: true }, offlineLoopback)).toBe('manual');
  expect(effectiveCaptureState(preferences, control, { ...offlineLoopback, permission: false })).toBe('permission_required');
  expect(effectiveCaptureState(preferences, control, { ...input, online: false, localOffline: true })).toBe('offline');
});
