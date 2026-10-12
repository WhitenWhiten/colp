import { beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ storage: {} as Record<string, unknown>, clear: vi.fn(), get: vi.fn(), scope: {
  serverOrigin: 'https://example.org', accountId: 'account', authorityGeneration: 1, collectionId: 'collection' } }));
vi.mock('../src/sw/capture-native.js', () => ({ currentCaptureScope: async () => f.scope, assertCaptureOwner: async () => {} }));
vi.mock('../src/classification-product-client.js', () => ({ createClassificationProductClient: () => ({ captureLearning: f.get, clearCaptureLearning: f.clear }) }));
import { handleCaptureLearning, validCaptureLearning } from '../src/sw/capture-learning.js';
import { captureControlKey, updateCaptureControl, readCaptureControl } from '../src/capture/control.js';
beforeEach(() => {
  f.storage = {}; f.clear.mockReset(); f.get.mockReset().mockResolvedValue({ generation: 1, records: [], enabled: true, priorAvailable: false });
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: f.storage[key] }),
    set: async (values: Record<string, unknown>) => Object.assign(f.storage, values), remove: async (key: string) => { delete f.storage[key]; } } } });
});
it('retries an uncertain clear with the same durable command and generation', async () => {
  f.clear.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ generation: 1 });
  await expect(handleCaptureLearning({ kind: 'known.capture.learning.clear', generation: 0 })).rejects.toThrow('lost response');
  const first = f.clear.mock.calls[0];
  expect(await handleCaptureLearning({ kind: 'known.capture.learning' })).toMatchObject({ pendingClear: true });
  await handleCaptureLearning({ kind: 'known.capture.learning.clear', generation: 1 });
  expect(f.clear.mock.calls[1]).toEqual(first);
  expect(await readCaptureControl(f.scope)).toMatchObject({ evidenceGeneration: 1 });
  expect(await handleCaptureLearning({ kind: 'known.capture.learning' })).toMatchObject({ pendingClear: false });
});
it('serializes memory refresh with pause and authorization updates', async () => {
  const key = captureControlKey(f.scope);
  await Promise.all([updateCaptureControl(f.scope, prior => ({ ...prior, paused: true, generation: prior.generation + 1 })),
    handleCaptureLearning({ kind: 'known.capture.learning' })]);
  expect(f.storage[key]).toMatchObject({ paused: true, generation: 1, evidenceGeneration: 1 });
});
it('rejects malformed clear commands', () => {
  expect(validCaptureLearning({ kind: 'known.capture.learning.clear', generation: -1 })).toBe(false);
  expect(validCaptureLearning({ kind: 'known.capture.learning.clear', generation: 1, account: 'other' })).toBe(false);
  expect(validCaptureLearning({ kind: 'known.capture.learning' })).toBe(true);
});
