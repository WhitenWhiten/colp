import { expect, it } from 'vitest';
import { TextByteBudget } from '../../src/shared/text-budget.js';

it.each(['plain ASCII', 'x'.repeat(1024 * 1024), '"\\\n\t\u0000', '雪é😀', '😀', '\ud800', '\udfff'])('counts JSON text exactly and rejects one byte below the required budget', (value) => {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  const budget = new TextByteBudget(bytes, 'test');
  budget.jsonString(value);
  expect(budget.bytes).toBe(bytes);
  expect(() => new TextByteBudget(bytes - 1, 'test').jsonString(value)).toThrow(RangeError);
});
