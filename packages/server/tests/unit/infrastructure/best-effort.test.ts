import assert from 'node:assert/strict';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { test } from 'vitest';
import {
  observeBestEffort,
  settleBestEffort,
} from '../../../src/infrastructure/async/best-effort.js';

test('settleBestEffort resolves both successful and rejected secondary actions', async () => {
  await settleBestEffort(Promise.resolve('ok'), 'the primary result is already authoritative');
  await settleBestEffort(Promise.reject(new Error('late failure')),
    'the primary result is already authoritative');
});

test('observeBestEffort immediately observes a background rejection', async () => {
  observeBestEffort(Promise.reject(new Error('late failure')),
    'the primary result is already authoritative');
  await yieldToEventLoop();
});

test('best-effort suppression rejects vague call-site rationales', () => {
  assert.throws(() => observeBestEffort(Promise.resolve(), 'cleanup'), /specific rationale/u);
  assert.throws(() => settleBestEffort(Promise.resolve(), ''), /specific rationale/u);
});
