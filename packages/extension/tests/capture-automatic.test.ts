import { expect, it, vi } from 'vitest';
import { advanceAutomaticCapture, type AutomaticPorts, type AutomaticDecision } from '../src/capture/automatic.js';
import { task } from './fixtures/capture.js';
import type { CaptureTask } from '../src/capture/contracts.js';
function fixture() {
  let current: CaptureTask = { ...task, save: 'local-saved' };
  const suggested: AutomaticDecision = { decisionId: 'decision', captureId: task.captureId, collectionId: 'c', nodeId: 'node',
    status: 'suggested', reason: null, revision: 1, nodeEtag: '"r1"', originalParentId: 'original', parentId: null,
    suggestedParentId: 'target', tags: [], executionId: 'execution', createdAt: '2026-09-20T00:00:00Z', appliedAt: null, undoneAt: null, feedbackRevision: 0, effectiveFeedback: null };
  const ports: AutomaticPorts = { now: () => 5, uuid: () => crypto.randomUUID(), read: async () => current,
    save: async next => { if (next.revision !== current.revision + 1) throw new Error('conflict'); current = next; },
    authorize: async () => null, prepare: async () => ({ captureId: task.captureId, nodeId: 'node', nodeEtag: '"r1"',
      policyVersion: 'capture-folder.v1', controlGeneration: 0, periodPoints: 10, billing: { priceVersion: 'price', maxPoints: 1 } }),
    classify: vi.fn(async () => suggested), get: vi.fn(async () => ({ ...suggested, status: 'applied' as const })),
    apply: vi.fn(async () => ({ ...suggested, status: 'applied' as const })), mappedTarget: async () => true };
  return { ports, current: () => current, set: (next: CaptureTask) => { current = next; } };
}
it('replays the same paid command after a lost classification response', async () => {
  const f = fixture(); f.ports.classify = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
    decisionId: 'd', status: 'manual', reason: 'low_confidence', executionId: 'e' });
  await expect(advanceAutomaticCapture(f.ports)).rejects.toThrow('offline');
  const commandId = f.current().automatic!.classifyCommandId;
  expect((await advanceAutomaticCapture(f.ports)).save).toBe('local-saved');
  expect(f.current().automatic?.classifyCommandId).toBe(commandId);
  expect(f.ports.apply).not.toHaveBeenCalled();
});
it('never applies a late result after pause or a manual edit', async () => {
  const f = fixture();
  f.ports.classify = async () => { f.set({ ...f.current(), revision: f.current().revision + 1, manualFence: 1 }); return { decisionId: 'd', status: 'suggested', suggestedParentId: 'target' } as AutomaticDecision; };
  const result = await advanceAutomaticCapture(f.ports);
  expect(result.classification).toBe('manual'); expect(f.ports.apply).not.toHaveBeenCalled();
});
it('queries a submitted application after restart without submitting a second mutation', async () => {
  const f = fixture(); f.ports.apply = vi.fn(async () => { throw new Error('lost response'); });
  await expect(advanceAutomaticCapture(f.ports)).rejects.toThrow('lost response');
  expect(f.current().automatic?.applySubmitted).toBe(true);
  f.ports.authorize = async () => 'paused';
  expect((await advanceAutomaticCapture(f.ports)).classification).toBe('applied');
  expect(f.ports.apply).toHaveBeenCalledTimes(1); expect(f.ports.get).toHaveBeenCalledTimes(1);
});

it('expired authorization leaves a saved bookmark with an actionable manual result', async () => {
  const f = fixture(); f.ports.authorize = async () => 'authorization_expired';
  expect(await advanceAutomaticCapture(f.ports)).toMatchObject({ save: 'local-saved', classification: 'manual', reason: 'authorization_expired' });
  expect(f.ports.classify).not.toHaveBeenCalled(); expect(f.ports.apply).not.toHaveBeenCalled();
});

it.each(['existing', 'cancelled'] as const)('does not classify a %s capture with a saved receipt', async disposition => {
  const f = fixture(); f.set({ ...f.current(), disposition });
  expect(await advanceAutomaticCapture(f.ports)).toMatchObject({ disposition, classification: 'waiting' });
  expect(f.ports.classify).not.toHaveBeenCalled(); expect(f.ports.apply).not.toHaveBeenCalled();
});

it('waits for saved annotations before dispatching classification', async () => {
  const f = fixture(); f.set({ ...f.current(), annotation: { tags: ['kept'], note: 'My note' } });
  expect(await advanceAutomaticCapture(f.ports)).toMatchObject({ classification: 'waiting' });
  expect(f.ports.classify).not.toHaveBeenCalled();
  f.set({ ...f.current(), annotationPersisted: true });
  expect(await advanceAutomaticCapture(f.ports)).toMatchObject({ classification: 'applied' });
  expect(f.ports.classify).toHaveBeenCalledOnce();
});

it('replays the identical durable apply after a crash before dispatch', async () => {
  const f = fixture();
  const original = f.ports.apply;
  f.ports.apply = vi.fn(async () => { throw new Error('crash before dispatch'); });
  await expect(advanceAutomaticCapture(f.ports)).rejects.toThrow('crash before dispatch');
  const intent = f.current().automatic!;
  f.ports.get = vi.fn(async () => intent.decision!);
  f.ports.apply = vi.fn(original);
  const result = await advanceAutomaticCapture(f.ports);
  expect(result.classification).toBe('applied');
  const replay = vi.mocked(f.ports.apply).mock.calls[0]![0];
  expect(replay.applyCommandId).toBe(intent.applyCommandId);
  expect(replay.document).toEqual(intent.document);
  expect(replay.applyUserInitiated).toBe(false);
});
it('does not replay an unreceived apply after authorization changes', async () => {
  const f = fixture(); f.ports.apply = vi.fn(async () => { throw new Error('offline'); });
  await expect(advanceAutomaticCapture(f.ports)).rejects.toThrow();
  f.ports.get = vi.fn(async () => f.current().automatic!.decision!);
  f.ports.authorize = async () => 'execution_control_changed';
  expect(await advanceAutomaticCapture(f.ports)).toMatchObject({ classification: 'manual', reason: 'execution_control_changed' });
  expect(f.ports.apply).toHaveBeenCalledTimes(1);
});
