import { describe, expect, it } from 'vitest';
import { deepEqualSyncMergeValue, mergeSyncTagsObservedRemove, mergeSyncTypedUpdate } from '../../src/sync/typed-update-merge.js';

describe('Typed-update merge untrusted graph boundaries', () => {
  it('applies graph limits to the exported equality helper even for identical references', () => {
    const oversized = Array.from({ length: 100_001 }, () => null);
    expect(deepEqualSyncMergeValue(oversized, oversized)).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(deepEqualSyncMergeValue(cyclic, cyclic)).toBe(false);
  });
  it('preserves shared graph nodes across fields without repeatedly expanding them', () => {
    const shared = { title: 'shared' };
    const rows = Array.from({ length: 20_000 }, () => shared);
    const input = { rows, otherRows: rows };
    const result = mergeSyncTypedUpdate({ base: input, current: input, incoming: input });
    expect(result.status).toBe('merged');
    if (result.status === 'merged') {
      const output = result.value.rows as readonly unknown[];
      expect(output).toHaveLength(20_000);
      expect(output[0]).toBe(output[19_999]);
      expect(result.value.otherRows).toBe(output);
      expect(output[0]).not.toBe(shared);
    }
  });
  it('rejects root Proxies before invoking any trap', () => {
    let calls = 0;
    const base = new Proxy({}, { getPrototypeOf() { calls += 1; return Object.prototype; } });
    expect(() => mergeSyncTypedUpdate({ base, current: {}, incoming: {} })).toThrow(/Proxy/u);
    expect(calls).toBe(0);
  });

  it.each([
    ['sparse', new Array(2)],
    ['extra-property', Object.assign(['a'], { extra: true })],
  ])('rejects %s arrays before cloning or tag merging', (_label, value) => {
    const input = { tags: value };
    expect(() => mergeSyncTypedUpdate({ base: input, current: input, incoming: input })).toThrow(/dense/u);
  });

  it('clones accepted null-prototype arrays without calling instance methods', () => {
    const rows = ['a'];
    Object.setPrototypeOf(rows, null);
    const input = { rows };
    const result = mergeSyncTypedUpdate({ base: input, current: input, incoming: input });
    expect(result).toMatchObject({ status: 'merged', value: { rows: ['a'] } });
    if (result.status === 'merged') {
      expect(result.value.rows).not.toBe(rows);
      expect(Object.isFrozen(result.value.rows)).toBe(true);
    }
  });

  it('merges null-prototype tag arrays and rejects direct tag-helper Proxies without traps', () => {
    const tags = ['a'];
    Object.setPrototypeOf(tags, null);
    const input = { tags };
    expect(mergeSyncTypedUpdate({ base: input, current: input, incoming: input }))
      .toMatchObject({ status: 'merged', value: { tags: ['a'] } });
    let calls = 0;
    const proxy = new Proxy(tags, { get() { calls += 1; throw new Error('tag trap'); } });
    expect(mergeSyncTagsObservedRemove({ baseTags: proxy, currentTags: tags, incomingTags: tags }).status)
      .toBe('conflict');
    expect(calls).toBe(0);
  });
});
