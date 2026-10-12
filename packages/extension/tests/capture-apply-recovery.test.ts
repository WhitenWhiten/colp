import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createCaptureStore, type CaptureStore } from '../src/capture/store.js';
import { task } from './fixtures/capture.js';
import type { CaptureTask } from '../src/capture/contracts.js';
import type { AutomaticDecision } from '../src/capture/automatic.js';
import { ClassificationProductError } from '../src/classification-product-client.js';

/**
 * EXT-03 regression: a transient Product-session expiry (`401
 * reconnect_required`) is an authorization change, not a deterministic verdict
 * on the durable apply. The command identity, request body and If-Match must
 * survive it so explicit confirmation can replay the SAME request after re-auth;
 * only a genuine deterministic 4xx closes the command as rejected.
 */
const f = vi.hoisted(() => {
  const scope = { accountId: 'a', serverOrigin: 'https://known.test', authorityGeneration: 1, collectionId: 'c' };
  const suggested = { decisionId: 'decision', captureId: 'capture', collectionId: 'c', nodeId: 'node',
    status: 'suggested' as const, reason: null, revision: 1, nodeEtag: '"r1"', originalParentId: 'original',
    parentId: null, suggestedParentId: 'target', tags: [] as string[], executionId: 'execution',
    createdAt: '2026-09-20T00:00:00Z', appliedAt: null, undoneAt: null, feedbackRevision: 0, effectiveFeedback: null };
  return { scope, suggested, ledger: null as CaptureStore | null, apply: vi.fn(), capabilities: vi.fn(),
    decision: vi.fn() };
});

vi.mock('../src/sw/capture-native.js', () => ({
  currentCaptureScope: async () => f.scope, assertCaptureScope: async () => {}, assertCaptureOwner: async () => {} }));
vi.mock('../src/sw/capture.js', () => ({ get captureStore() { return f.ledger; } }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: async () => true,
  syncState: { listBookmarkEventsByNative: async () => [] },
  workCoordinator: { run: async (_lane: string, work: () => unknown) => work() } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => ({}) }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: async () => {} }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ handleBookmarkPreferencesRequest: async () => ({ ok: true, pending: false, conflict: false,
  preferences: { captureMode: 'automatic', resumeClassificationWhenOnline: true, learnFromCorrections: false } }) }));
vi.mock('../src/capture/control.js', async original => ({ ...await original<object>(),
  readCaptureControl: async () => ({ paused: false, generation: 0, consent: null, evidenceGeneration: 0 }) }));
vi.mock('../src/bookmark-event-ingress.js', () => ({ resolveIngressBoundary: async () => ({ selectedNative: 'root' }) }));
vi.mock('../src/classification-folder.js', () => ({ resolveClassificationNativeFolder: async () => ({ nativeId: 'target' }) }));
vi.mock('../src/save-folder.js', () => ({ folderIsInMount: async () => true, walkAncestorIds: async () => [] }));
vi.mock('../src/classification-create-receipt.js', () => ({ classificationCreateReceipt: async () => ({ nodeId: 'node', etag: '"r1"' }) }));
vi.mock('../src/classification-product-client.js', async original => ({ ...await original<object>(),
  createClassificationProductClient: () => ({ captureCapabilities: f.capabilities, applyCapture: f.apply,
    captureDecision: f.decision, findCaptureDecision: f.decision, classifyCapture: async () => f.suggested }) }));

import { classifySavedCapture } from '../src/sw/capture-classification.js';
import { applyCaptureSuggestion } from '../src/sw/capture-result-recovery.js';

function seed(): CaptureTask {
  const now = Date.now();
  return { ...task, scope: f.scope, createdAt: now, updatedAt: now, save: 'local-saved', classification: 'running',
    disposition: 'new', automaticIntent: true, nativeId: 'native-saved', decisionId: 'decision',
    billingAuthorization: { collectionId: 'c', priceVersion: 'price', maxPoints: 1, periodPoints: 10, expiresAt: now + 3_600_000 },
    automatic: { document: { captureId: task.captureId, nodeId: 'node', nodeEtag: '"r1"', policyVersion: 'capture-folder.v1',
      controlGeneration: 0, periodPoints: 10, billing: { priceVersion: 'price', maxPoints: 1 } },
      classifyCommandId: 'classify-cmd', applyCommandId: 'apply-cmd', applySubmitted: true,
      applyState: 'outcome-unknown', applyUserInitiated: false, decision: f.suggested as AutomaticDecision } };
}

beforeEach(() => {
  f.ledger = createCaptureStore(new IDBFactory());
  f.apply.mockReset(); f.decision.mockReset(); f.capabilities.mockReset();
  f.decision.mockResolvedValue(f.suggested);
  f.capabilities.mockResolvedValue({ automaticFolderAvailable: true, policyVersion: 'v1' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('chrome', { bookmarks: { get: async () => [{ id: 'native-saved', parentId: 'folder',
    title: task.title, url: task.url }] } });
});
afterEach(async () => { await f.ledger?.close(); vi.unstubAllGlobals(); });

test('a transient 401 leaves the submitted apply recoverable and explicit confirmation replays it verbatim', async () => {
  const ledger = f.ledger!;
  await ledger.claim(seed());
  f.apply.mockRejectedValueOnce(new ClassificationProductError('reconnect_required', 401));

  const failed = await classifySavedCapture(seed(), ledger);
  expect(failed.automatic?.applyState).not.toBe('rejected');
  expect(failed.automatic?.applySubmitted).toBe(true);
  expect(failed.automatic?.applyCommandId).toBe('apply-cmd');
  expect(failed.reason).toBe('application_result_unknown');
  expect((await ledger.get(f.scope, task.captureId))?.automatic?.applyState).toBe('outcome-unknown');

  // Re-auth: the Product session is valid again and the SAME durable command
  // now succeeds through the explicit user confirmation entry point.
  const first = structuredClone(f.apply.mock.calls[0]!);
  f.decision.mockResolvedValue(f.suggested);
  f.apply.mockReset();
  f.apply.mockResolvedValue({ ...f.suggested, status: 'applied', nodeEtag: '"r2"', appliedAt: '2026-09-20T00:00:00Z' });

  const applied = await applyCaptureSuggestion(failed, ledger);
  expect(applied.classification).toBe('applied');
  expect(f.apply).toHaveBeenCalledTimes(1);
  expect(f.apply.mock.calls[0]).toEqual(first);
});

test('a deterministic 4xx still closes the command as rejected and refuses replay', async () => {
  const ledger = f.ledger!;
  await ledger.claim(seed());
  f.apply.mockRejectedValueOnce(new ClassificationProductError('revision_conflict', 409));

  const rejected = await classifySavedCapture(seed(), ledger);
  expect(rejected.automatic?.applyState).toBe('rejected');
  expect(rejected.reason).toBe('revision_conflict');
  await expect(applyCaptureSuggestion(rejected, ledger)).rejects.toThrow('capture_suggestion_rejected');
});

test('a concurrent sync-status write never turns a recoverable automatic capture into manual', async () => {
  const ledger = f.ledger!;
  const seeded = await ledger.claim(seed());
  // Another writer (capture-sync, a second resume) wins the CAS while the decision is read.
  f.decision.mockImplementationOnce(async () => {
    const current = (await ledger.get(seeded.scope, seeded.captureId))!;
    await ledger.update({ ...current, revision: current.revision + 1, sync: 'syncing' }, current.revision);
    return { ...f.suggested, status: 'applied' as const, nodeEtag: '"r2"', appliedAt: '2026-09-20T00:00:01Z' };
  });
  const result = await classifySavedCapture(seeded, ledger);
  expect(result.classification).toBe('running');
  expect(result.reason).toBeNull();
  // The durable intent survives, so the next resume finishes it.
  f.decision.mockResolvedValue({ ...f.suggested, status: 'applied', nodeEtag: '"r2"', appliedAt: '2026-09-20T00:00:01Z' });
  expect((await classifySavedCapture(result, ledger)).classification).toBe('applied');
});
