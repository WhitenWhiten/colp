import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseColpProblem, parseSyncPushResult } from '../src/sync-push-wire.js';

const binding = { opId: 'op-1', sequence: 1 };
const result = { ...binding, status: 'applied', revision: 'r1', cursor: 'c1',
  warnings: [{ code: 'conversion_note', message: 'Preserved' }] };
const response = { batchId: 'batch-1', serverCursor: 'c1', results: [result] };

for (const part of ['document', 'result', 'warning']) test(`additive ${part} fields are ignored without changing the receipt`, () => {
  const value = structuredClone(response);
  const target = part === 'document' ? value : part === 'result' ? value.results[0]! : value.results[0]!.warnings[0]!;
  Object.assign(target, { serverMetadata: { version: 2 } });
  const parsed = parseSyncPushResult(value, binding);
  assert.deepEqual(parsed.document, response);
  assert.deepEqual(parsed.result, result);
  assert.equal(parsed.terminal, true);
  assert.equal(Object.hasOwn(target, 'serverMetadata'), true);
});

test('Problem and subtree extensions do not invalidate a revision conflict', () => {
  const digest = `sha-256=:${'A'.repeat(43)}=:`;
  assert.deepEqual(parseColpProblem({ type: 'about:blank', title: 'Conflict', status: 409,
    code: 'revision_conflict', currentRevision: 'r2', serverMetadata: true,
    currentSubtree: { version: 1, count: 1, digest, memberIdsDigest: digest, newerField: true } }),
  { code: 'revision_conflict', status: 409, currentRevision: 'r2',
    currentSubtree: { version: 1, count: 1, digest, memberIdsDigest: digest } });
});

test('additive tolerance preserves identity, sequence, status and required-field validation', () => {
  for (const invalid of [{ ...result, opId: 'other' }, { ...result, sequence: 2 },
    { ...result, status: 'future_status' }, { ...result, revision: undefined },
    { ...result, warnings: [{ code: 7, message: 'Invalid known field', extra: true }] }]) {
    assert.throws(() => parseSyncPushResult({ ...response, results: [invalid], extra: true }, binding));
  }
  assert.throws(() => parseColpProblem({ title: 'Missing type', code: 'bad', status: 400, extra: true }));
});
