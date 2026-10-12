// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import type { CaptureTask } from '../src/capture/contracts.js';
import { savePopupNativePage } from '../src/popup-native-save.js';

function task(patch: Partial<CaptureTask> & Pick<CaptureTask, 'captureId' | 'save' | 'disposition'>): CaptureTask {
  return {
    version: 1, commandId: 'command', batchId: null,
    scope: { serverOrigin: 'https://known.example', accountId: 'account', authorityGeneration: 1, collectionId: 'collection' },
    source: 'manual-popup', tabId: null, url: 'https://example.org/page', title: 'Page', targetNativeId: '42',
    insertPosition: 'top', saveAnother: false, allowUnverifiedCloud: true, createdAt: 1, updatedAt: 1, revision: 0,
    policyVersion: 'capture-folder.v1', automaticIntent: false, classification: 'none', sync: 'pending', existence: null,
    nativeIntentId: null, nativeId: null, nodeId: null, executionId: null, decisionId: null, localLocation: null,
    cloudLocation: null, appliedRevision: null, manualFence: 0, controlGeneration: 0, reason: null,
    ...patch,
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('a saved capture returns its native id once', async () => {
  const ids: string[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string; commandId?: string }) => {
    if (message.kind === 'known.capture.start' && message.commandId) ids.push(message.commandId);
    return { ok: true, task: task({ captureId: 'cap-saved', save: 'local-saved', disposition: 'new', nativeId: '55', commandId: message.commandId }) };
  }) } });
  await expect(savePopupNativePage({ title: 'Saved', url: 'https://example.org/saved' }, '42')).resolves.toBe('55');
  await expect(savePopupNativePage({ title: 'Saved', url: 'https://example.org/saved' }, '42')).resolves.toBe('55');
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test('an already saved page returns that bookmark and does not invent one when several exist', async () => {
  const ids: string[] = [];
  let mode: 'one' | 'many' = 'one';
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string; commandId?: string }) => {
    if (message.kind === 'known.capture.start' && message.commandId) ids.push(message.commandId);
    const exact = mode === 'one'
      ? [{ nativeId: '12' }]
      : [{ nativeId: '12' }, { nativeId: '13' }];
    return { ok: true, task: task({
      captureId: 'cap-existing', save: 'unsubmitted', disposition: 'existing', commandId: message.commandId,
      existence: { exact } as unknown as CaptureTask['existence'],
    }) };
  }) } });
  await expect(savePopupNativePage({ title: 'Existing', url: 'https://example.org/existing' }, '42')).resolves.toBe('12');
  mode = 'many';
  await expect(savePopupNativePage({ title: 'Existing many', url: 'https://example.org/existing-many' }, '42')).rejects.toThrow('capture_existing_locations');
  expect(ids).toHaveLength(2);
});

test('a rejection before the worker accepts the command resumes the same id and saves once', async () => {
  const ids: string[] = [];
  let attempts = 0;
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string; commandId?: string }) => {
    if (message.kind !== 'known.capture.start' || !message.commandId) return { ok: false, error: 'capture_result_unknown' };
    ids.push(message.commandId);
    attempts += 1;
    if (attempts === 1) return { ok: false, error: 'permission_required' };
    return { ok: true, task: task({ captureId: 'cap-pre', save: 'local-saved', disposition: 'new', nativeId: '77', commandId: message.commandId }) };
  }) } });
  await expect(savePopupNativePage({ title: 'Pre', url: 'https://example.org/pre' }, '42')).rejects.toThrow('permission_required');
  await expect(savePopupNativePage({ title: 'Pre', url: 'https://example.org/pre' }, '42')).resolves.toBe('77');
  expect(ids).toEqual([ids[0], ids[0]]);
});

test('a dropped send is not a saved bookmark and keeps the command id', async () => {
  const ids: string[] = [];
  let attempts = 0;
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string; commandId?: string }) => {
    if (message.kind !== 'known.capture.start' || !message.commandId) throw new Error('capture_result_unknown');
    ids.push(message.commandId);
    attempts += 1;
    if (attempts === 1) throw new Error('Receiving end does not exist');
    return { ok: true, task: task({ captureId: 'cap-drop', save: 'local-saved', disposition: 'new', nativeId: '78', commandId: message.commandId }) };
  }) } });
  await expect(savePopupNativePage({ title: 'Drop', url: 'https://example.org/drop' }, '42')).rejects.toThrow('Receiving end does not exist');
  await expect(savePopupNativePage({ title: 'Drop', url: 'https://example.org/drop' }, '42')).resolves.toBe('78');
  expect(new Set(ids).size).toBe(1);
});

test('an unknown capture result is not a saved bookmark and does not mint a new command', async () => {
  vi.useFakeTimers();
  const ids: string[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string; commandId?: string }) => {
    if (message.kind === 'known.capture.start' && message.commandId) ids.push(message.commandId);
    return { ok: true, task: task({ captureId: 'cap-unknown', save: 'unknown', disposition: 'new', nativeId: 'not-confirmed', commandId: message.commandId }) };
  }) } });
  const first = expect(savePopupNativePage({ title: 'Unknown', url: 'https://example.org/unknown' }, '42')).rejects.toThrow('capture_result_unknown');
  await vi.runAllTimersAsync();
  await first;
  const second = expect(savePopupNativePage({ title: 'Unknown', url: 'https://example.org/unknown' }, '42')).rejects.toThrow('capture_result_unknown');
  await vi.runAllTimersAsync();
  await second;
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test('a dropped follow-up is not a saved bookmark', async () => {
  vi.useFakeTimers();
  const ids: string[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { kind: string; commandId?: string }) => {
    if (message.kind === 'known.capture.start' && message.commandId) {
      ids.push(message.commandId);
      return { ok: true, task: task({ captureId: 'cap-follow', save: 'unsubmitted', disposition: 'new', commandId: message.commandId }) };
    }
    return { ok: false, error: 'capture_not_found' };
  }) } });
  const pending = expect(savePopupNativePage({ title: 'Follow', url: 'https://example.org/follow' }, '42')).rejects.toThrow('capture_result_unknown');
  await vi.runAllTimersAsync();
  await pending;
  expect(ids).toHaveLength(1);
});

test('a cancelled or failed capture is not reported as saved and does not start a new command', async () => {
  const cancelled: string[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { commandId?: string }) => {
    if (message.commandId) cancelled.push(message.commandId);
    return { ok: true, task: task({ captureId: 'cap-cancel', save: 'local-saved', disposition: 'cancelled', nativeId: '90' }) };
  }) } });
  await expect(savePopupNativePage({ title: 'Cancel', url: 'https://example.org/cancel' }, '42')).rejects.toThrow('capture_cancelled');
  await expect(savePopupNativePage({ title: 'Cancel', url: 'https://example.org/cancel' }, '42')).rejects.toThrow('capture_cancelled');
  expect(cancelled[0]).toBe(cancelled[1]);

  const failed: string[] = [];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: { commandId?: string }) => {
    if (message.commandId) failed.push(message.commandId);
    return { ok: true, task: task({ captureId: 'cap-failed', save: 'failed', disposition: 'new', reason: 'native_save_unavailable' }) };
  }) } });
  await expect(savePopupNativePage({ title: 'Failed', url: 'https://example.org/failed' }, '42')).rejects.toThrow('native_save_unavailable');
  await expect(savePopupNativePage({ title: 'Failed', url: 'https://example.org/failed' }, '42')).rejects.toThrow('native_save_unavailable');
  expect(failed[0]).toBe(failed[1]);
  expect(failed[0]).not.toBe(cancelled[0]);
});
