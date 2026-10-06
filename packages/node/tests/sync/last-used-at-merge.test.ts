import { describe, expect, it } from 'vitest';
import { mergeSyncTypedUpdate } from '../../src/sync/index.js';

const base = '2026-01-01T00:00:00Z';
function merge(current: unknown, incoming: unknown, original: unknown = base) {
  return mergeSyncTypedUpdate({ base: { lastUsedAt: original }, current: { lastUsedAt: current }, incoming: { lastUsedAt: incoming } });
}

describe('lastUsedAt maximum instant [evidence:sync.typed-update-merge]', () => {
  it('never moves an unchanged server timestamp backwards', () => {
    const current = '2026-09-25T00:00:00Z';
    expect(merge(current, base, current)).toEqual({ status: 'merged', value: { lastUsedAt: current } });
  });

  it.each([
    ['2026-09-25T00:00:00.0009Z', '2026-09-25T00:00:00.0001Z', 0],
    ['2026-09-25T00:00:00.0000000001Z', '2026-09-25T00:00:00.0000000002Z', 1],
    ['2026-09-25T00:00:00.9Z', '2026-09-25T00:00:01.0001Z', 1],
    ['2026-09-25T00:00:00.1Z', '2026-09-25T00:00:00.1000Z', 1],
    ['2026-09-25T01:00:00.0009+01:00', '2026-09-25T00:00:00.0001Z', 0],
    ['2026-09-24T20:00:00-04:00', '2026-09-25T00:00:00Z', 1],
    ['2016-12-31T23:59:60.01Z', '2016-12-31T23:59:59.999Z', 0],
    ['2016-12-31T23:59:60.99Z', '2017-01-01T00:00:00Z', 1],
  ] as const)('compares %s against %s exactly', (current, incoming, winner) => {
    expect(merge(current, incoming)).toEqual({ status: 'merged', value: { lastUsedAt: [current, incoming][winner] } });
  });

  it.each([null, undefined])('treats %s as absent without erasing a valid instant', absent => {
    expect(merge(absent, base)).toEqual({ status: 'merged', value: { lastUsedAt: base } });
    expect(merge(base, absent)).toEqual({ status: 'merged', value: { lastUsedAt: base } });
    expect(merge(absent, absent)).toEqual({ status: 'merged', value: { lastUsedAt: absent } });
  });

  it.each(['not-a-time', '2026-09-25T00:00:00-00:00', 5])('rejects invalid or unknown-offset timestamp %s even on scalar shortcuts', invalid => {
    expect(merge(invalid, base, invalid).status).toBe('conflict');
    expect(merge(base, invalid, base).status).toBe('conflict');
    expect(merge(invalid, invalid, invalid).status).toBe('conflict');
  });
});
