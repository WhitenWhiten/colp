import assert from 'node:assert/strict';
import { test } from 'vitest';
import { classifyDurablePullCursorWrite, classifyPullAck, pullCursorOrder } from '../src/pull-ack-boundary.js';
import { vectors } from './model-vectors.js';

test('Lean cursor ordering agrees with the actual parser on 400 pairs', () => {
  for (const c of vectors.orders) assert.equal(pullCursorOrder(c.left, c.right), c.expected, JSON.stringify(c));
});

test('Lean Ack classification agrees with TypeScript on 3528 inputs', () => {
  for (const c of vectors.acks) assert.equal(classifyPullAck(c.input), c.expected, JSON.stringify(c));
});

test('Lean durable cursor write classification agrees with TypeScript on 8400 inputs', () => {
  for (const c of vectors.writes) assert.equal(classifyDurablePullCursorWrite(c.input), c.expected, JSON.stringify(c));
});

test('the connected-chain shortcut depends on upstream page validation for monotonicity', () => {
  const publishedCursor = 'spc2.scope.10.2.o.hash.sig';
  const nextCursor = 'spc2.scope.10.1.o.hash.sig';
  assert.equal(pullCursorOrder(publishedCursor, nextCursor), 'after');
  assert.equal(classifyDurablePullCursorWrite({ publishedCursor, previousCursor: publishedCursor, nextCursor }), 'allow');
});
