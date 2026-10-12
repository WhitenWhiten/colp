import { expect } from '@playwright/test';
import type { QueueOperation } from '../src/sync-state-store.js';
import type { PushRequestObservation } from './real-stack.js';

/** Browser restarts lose Session secrets; rebinding still requires an explicit 401. */
export function expectAuthenticatedRestartReplay(
  before: QueueOperation, after: QueueOperation,
  observed: { pushRequests: readonly PushRequestObservation[] },
): void {
  expect(after.opId).toBe(before.opId);
  expect(after.sequence).toBe(before.sequence);
  expect(after.digest).toBe(before.digest);
  expect(after.payload).toEqual(before.payload);
  expect(after.idempotencyKey).toBe(before.idempotencyKey);
  const original = before.attempt!; const restored = after.attempt!;
  expect(original).toBeDefined(); expect(restored).toBeDefined();
  const requests = observed.pushRequests;
  const rebound = requests.findIndex(request => request.body !== original.body);
  expect(rebound).toBeGreaterThan(0);
  expect(requests[rebound - 1]).toMatchObject({ responseStatus: 401, responseCode: 'authentication_required' });
  for (const request of requests.slice(0, rebound)) {
    expect(request.body).toBe(original.body);
    expect(request.fingerprint).toBe(original.bodyDigest);
  }
  for (const request of requests.slice(rebound)) {
    expect(request.body).toBe(restored.body);
    expect(request.fingerprint).toBe(restored.bodyDigest);
  }
  for (const request of requests) expect(request.headers['idempotency-key']).toBe(original.idempotencyKey);
  expect(JSON.parse(restored.body).operations).toEqual(JSON.parse(original.body).operations);
  expect(restored.sessionId).not.toBe(original.sessionId);
  expect(restored.batchId).not.toBe(original.batchId);
}
