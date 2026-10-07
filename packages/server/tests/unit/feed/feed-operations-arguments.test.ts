import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseFeedOperationsArguments } from '../../../scripts/phase5-feed-operations-arguments.js';

test('P5-24 operations CLI accepts the runbook npm separator and strict name/value pairs', () => {
  const expected = new Map([
    ['source-revision', 'a'.repeat(40)],
    ['evidence-output', 'C:\\temp\\feed-operations-status.json'],
  ]);
  const pairs = [
    '--source-revision', 'a'.repeat(40),
    '--evidence-output', 'C:\\temp\\feed-operations-status.json',
  ];

  assert.deepEqual(parseFeedOperationsArguments(['--', ...pairs]), expected);
  assert.deepEqual(parseFeedOperationsArguments(pairs), expected);
});

test('P5-24 operations CLI rejects misplaced separators and ambiguous pairs', () => {
  assert.throws(() => parseFeedOperationsArguments(['--', '--', '--source-revision', 'a'.repeat(40)]),
    /--name value pairs/u);
  assert.throws(() => parseFeedOperationsArguments(['--source-revision']), /--name value pairs/u);
  assert.throws(() => parseFeedOperationsArguments([
    '--source-revision', 'a'.repeat(40), '--source-revision', 'b'.repeat(40),
  ]), /duplicate --source-revision/u);
});
