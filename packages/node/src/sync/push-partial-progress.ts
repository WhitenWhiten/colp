import { isProxy } from 'node:util/types';

import { immutableJsonData } from '../shared/immutable-json.js';
import type { OperationResult } from '../types/index.js';
import type { PushPartialProgress } from './push-transaction.js';
import { assertExactObject, MAX_PUSH_BATCH_OPERATIONS } from './push-transaction-guards.js';

/**
 * Snapshot the frame and each result independently, just as successful Push
 * batches retain individually bounded results without a shared member cap.
 * Applying a single-result budget to the whole prefix would mask the reuse
 * denial after its preceding operations have already committed.
 */
export function snapshotPushPartialProgress(candidate: PushPartialProgress): PushPartialProgress {
  if (typeof candidate !== 'object' || candidate === null || isProxy(candidate)) {
    throw new TypeError('Push partial progress must be a plain object.');
  }
  assertExactObject(candidate, ['batchId', 'results', 'failed', 'serverCursor'], 'Push partial progress');
  const source = candidate.results;
  if (!Array.isArray(source) || isProxy(source) || Object.getPrototypeOf(source) !== Array.prototype
    || source.length > MAX_PUSH_BATCH_OPERATIONS || Reflect.ownKeys(source).length !== source.length + 1) {
    throw new TypeError('Push partial progress results must be a bounded ordinary dense array.');
  }
  const frame = immutableJsonData({
    batchId: candidate.batchId, failed: candidate.failed, serverCursor: candidate.serverCursor,
  }, 'Push partial progress frame');
  const results: OperationResult[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Push partial progress results must contain only dense data properties.');
    }
    results.push(immutableJsonData(descriptor.value as OperationResult, 'Push partial progress result'));
  }
  return Object.freeze({ ...frame, results: Object.freeze(results) });
}
