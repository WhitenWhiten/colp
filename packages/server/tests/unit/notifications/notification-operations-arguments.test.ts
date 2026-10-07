import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseNotificationOperationsArguments } from '../../../scripts/phase5-notification-operations-arguments.js';

test('P5-25 operations CLI accepts npm separator and strict source-bound pairs', () => {
  const pairs = ['--source-revision', 'a'.repeat(40), '--evidence-output',
    'C:\\temp\\notification-operations-status.json'];
  assert.deepEqual(parseNotificationOperationsArguments(['--', ...pairs]), new Map([
    ['source-revision', 'a'.repeat(40)],
    ['evidence-output', 'C:\\temp\\notification-operations-status.json'],
  ]));
  assert.deepEqual(parseNotificationOperationsArguments(pairs),
    parseNotificationOperationsArguments(['--', ...pairs]));
  assert.throws(() => parseNotificationOperationsArguments(['--source-revision']), /pairs/u);
  assert.throws(() => parseNotificationOperationsArguments([...pairs, '--source-revision', 'b']),
    /duplicate/u);
});

test('P5-25 operations CLI rejects unknown and command-inapplicable arguments', () => {
  const common = ['--source-revision', 'a'.repeat(40), '--evidence-output',
    'C:\\temp\\notification-operations.json'];
  assert.throws(() => parseNotificationOperationsArguments([...common, '--secret', 'marker'],
    'status'), /unknown --secret/u);
  assert.throws(() => parseNotificationOperationsArguments([...common, '--account', 'ops-a'],
    'status'), /not valid for status/u);
  assert.doesNotThrow(() => parseNotificationOperationsArguments([
    ...common, '--account', 'ops-a', '--cutoff', '2026-01-01T00:00:00Z'], 'purge'));
  assert.throws(() => parseNotificationOperationsArguments([
    ...common, '--account', 'ops-a', '--allow-unknown-future-version', 'true'], 'recover'),
  /not valid for recover/u);
});
