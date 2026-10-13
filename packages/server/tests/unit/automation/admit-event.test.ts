import { expect, test } from 'vitest';
import { appendCountBatch } from '../../../src/modules/automation/application/admit-event.js';
test('dormant M3 exact 9+2 accumulation retains the eleventh member without duplicating retries', () => {
  const members = Array.from({ length: 11 }, (_, i) => ({ eventId: String(i) }));
  const first = appendCountBatch([], members.slice(0, 9), 10);
  expect(first.batches).toEqual([]);
  const second = appendCountBatch(first.remainder, [members[8]!, members[9]!, members[10]!], 10);
  expect(second.batches).toEqual([members.slice(0, 10)]);
  expect(second.remainder).toEqual([members[10]]);
});
