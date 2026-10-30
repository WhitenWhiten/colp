import { expect, test, vi } from 'vitest';
import { createDeviceBridgeRunner, type BrowserRequest, type BrowserRequestResult, type DeviceCompletion } from '../src/automation/device-bridge.js';
import { deviceResultPage, deviceResultFits } from '../src/automation/device-bridge-result.js';
const request: BrowserRequest = { id: 'request', replicaId: 'replica', collectionId: 'collection', operation: 'classification.preview', input: { jobId: 'job' }, expiresAt: new Date(Date.now()+60000).toISOString() };
function fixture() {
  const values = new Map<string, unknown>();
  const area = { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key,value); } };
  const ports = { authorize: vi.fn(async () => {}), execute: vi.fn(async () => ({ preview: 'result' })),
    complete: vi.fn<(result: BrowserRequestResult) => Promise<DeviceCompletion>>(async () => 'accepted') };
  return { area, ports, values };
}
test('durable browser request result is replayed after a lost acknowledgement without repeating the provider', async () => {
  const f = fixture(); f.ports.complete.mockResolvedValueOnce('retry');
  await createDeviceBridgeRunner(f.area,f.ports)([request]);
  await createDeviceBridgeRunner(f.area,f.ports)([request]);
  expect(f.ports.execute).toHaveBeenCalledOnce(); expect(f.ports.complete).toHaveBeenCalledTimes(2);
  expect(f.ports.complete).toHaveBeenLastCalledWith({ requestId: 'request', state: 'done', result: { preview: 'result' } });
});
test('worker loss after the write-ahead marker reports unknown outcome and never replays a preview', async () => {
  const f = fixture(); f.values.set('known.automation.device-bridge.v1.request.request', { state: 'started' });
  await createDeviceBridgeRunner(f.area,f.ports)([request]);
  expect(f.ports.execute).not.toHaveBeenCalled();
  expect(f.ports.complete).toHaveBeenCalledWith({ requestId: 'request', state: 'failed', result: { code: 'device_result_unknown' } });
});
test('disabled or changed browser authority blocks dispatch and one request failure does not block another', async () => {
  const f = fixture(); f.ports.authorize.mockRejectedValueOnce(new Error('device_bridge_disabled'));
  await createDeviceBridgeRunner(f.area,f.ports)([request, { ...request, id: 'second' }]);
  expect(f.ports.execute).toHaveBeenCalledOnce(); expect(f.ports.complete).toHaveBeenCalledTimes(2);
  expect(f.ports.complete).toHaveBeenNthCalledWith(1, { requestId: 'request', state: 'failed', result: { code: 'device_bridge_disabled' } });
});
test('provider error bodies are never sent through the device bridge', async () => {
  const f = fixture(); f.ports.execute.mockRejectedValueOnce(new Error('Bearer secret: private provider response'));
  await createDeviceBridgeRunner(f.area,f.ports)([request]);
  expect(f.ports.complete).toHaveBeenCalledWith({ requestId: 'request', state: 'failed', result: { code: 'device_operation_failed' } });
});

test('revoking browser access during a diagnostic read prevents uploading the result', async () => {
  const f = fixture(); f.ports.execute.mockImplementationOnce(async () => { f.ports.authorize.mockRejectedValue(new Error('device_bridge_disabled')); return { preview: 'private result' }; });
  await createDeviceBridgeRunner(f.area,f.ports)([request]);
  expect(f.ports.complete).toHaveBeenCalledWith({ requestId: 'request', state: 'failed', result: { code: 'device_bridge_disabled' } });
});

test('diagnostics paginate by UTF-8 envelope bytes without losing tasks', () => {
  const items = Array.from({ length: 40 }, () => ({ id: crypto.randomUUID(), title: '中'.repeat(512),
    state: 'attention', reason: 'local_key_required', connections: [crypto.randomUUID(), crypto.randomUUID()], retryable: true }));
  const seen: string[] = [];
  while (seen.length < items.length) {
    const page = deviceResultPage(request.id, items.slice(seen.length), { counts: { attention: 40 } });
    expect(page.items.length).toBeGreaterThan(0); expect(page.items.length).toBeLessThan(20);
    expect(deviceResultFits({ requestId: request.id, state: 'done', result: page })).toBe(true);
    seen.push(...page.items.map(item => item.id));
    expect(page.nextCursor).toBe(seen.length < items.length ? seen.at(-1) : null);
  }
  expect(seen).toEqual(items.map(item => item.id));
  expect(() => deviceResultPage(request.id, [{ id: 'too-large', title: '中'.repeat(20000) }], {})).toThrow('device_result_too_large');
});

test('oversized fresh and cached results settle as small failures without repeating work', async () => {
  const f = fixture(); f.ports.execute.mockResolvedValue({ preview: '中'.repeat(20000) });
  f.values.set('known.automation.device-bridge.v1.request.cached', { requestId: 'cached', state: 'done', result: { preview: '中'.repeat(20000) } });
  await createDeviceBridgeRunner(f.area, f.ports)([request, { ...request, id: 'cached' }]);
  expect(f.ports.execute).toHaveBeenCalledOnce();
  for (const [result] of f.ports.complete.mock.calls) {
    expect(result).toMatchObject({ state: 'failed', result: { code: 'device_result_too_large' } });
    expect(deviceResultFits(result)).toBe(true);
  }
});

test.each(['tooLarge', 'rejected'] as const)('%s upload settles a durable failure, while a lost failure ack retries only that result', async outcome => {
  const f = fixture(); f.ports.complete.mockResolvedValueOnce(outcome).mockResolvedValueOnce('retry');
  const run = createDeviceBridgeRunner(f.area, f.ports);
  await run([request]); await run([request]);
  expect(f.ports.execute).toHaveBeenCalledOnce();
  expect(f.ports.complete.mock.calls[2]![0]).toEqual(f.ports.complete.mock.calls[1]![0]);
  expect(f.ports.complete.mock.calls[2]![0]).toMatchObject({ state: 'failed', result: { code: outcome === 'tooLarge' ? 'device_result_too_large' : 'device_result_rejected' } });
});

test('an upload transport exception does not stop the following request', async () => {
  const f = fixture(); f.ports.complete.mockRejectedValueOnce(new Error('offline'));
  await createDeviceBridgeRunner(f.area, f.ports)([request, { ...request, id: 'second' }]);
  expect(f.ports.execute).toHaveBeenCalledTimes(2); expect(f.ports.complete).toHaveBeenCalledTimes(2);
});
