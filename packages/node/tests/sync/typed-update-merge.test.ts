import { describe, expect, it } from 'vitest';

import {
  deepEqualSyncMergeValue,
  mergeSyncTagsObservedRemove,
  mergeSyncTypedUpdate,
} from '../../src/sync/index.js';
import { mergeSyncTypedUpdate as mergeFromModule } from '../../src/sync/typed-update-merge.js';

/**
 * Evidence for SYNC-0017 Base / Current / Incoming three-way merge + Tag OR-set.
 *
 * Boundary / JSON-Pointer / prototype / Move-Reorder bypass coverage remains in
 * `typed-update-merge-boundary.test.ts` under
 * `[evidence:sync.typed-update-merge-boundary]` (validate API only).
 * This suite is the Accepted-path behavioral evidence for deterministic merge.
 */
const evidence = '[evidence:sync.typed-update-merge]';

type DataObject = Readonly<Record<string, unknown>>;

/** Production input shape for `mergeSyncTypedUpdate({ base, current, incoming })`. */
type MergeInput = {
  readonly base: DataObject;
  readonly current: DataObject;
  readonly incoming: DataObject;
};

/**
 * Production result contract:
 * - `{ status: 'merged', value }` on deterministic field merge / Tag OR-set
 * - `{ status: 'conflict', conflicts: [{ field, reason }] }` when fields diverge three ways
 *
 * Tag order: membership is the OR-set obligation. Production sorts tags
 * lexicographically for deterministic array order (see tags cases).
 */
type MergeResult =
  | { readonly status: 'merged'; readonly value: DataObject }
  | {
      readonly status: 'conflict';
      readonly conflicts: readonly { readonly field: string; readonly reason: string }[];
    };

function merge(input: MergeInput): MergeResult {
  return mergeSyncTypedUpdate(input) as MergeResult;
}

/** Assert successful merge and return the merged value (no local reimplementation). */
function expectMerged(result: MergeResult, expected: DataObject): DataObject {
  expect(result, `${evidence} expected status merged`).toMatchObject({ status: 'merged' });
  if (result.status !== 'merged') {
    throw new Error('expected merged result');
  }
  expect(result.value).toEqual(expected);
  return result.value;
}

/** Assert field-level conflict without accepting a silent overwrite. */
function expectFieldConflict(result: MergeResult, field: string): void {
  expect(result, `${evidence} expected status conflict for ${field}`).toMatchObject({
    status: 'conflict',
  });
  if (result.status !== 'conflict') {
    throw new Error('expected conflict result');
  }
  expect(
    result.conflicts.some((entry) => entry.field === field),
    `${evidence} expected conflicts to include field ${field}`,
  ).toBe(true);
}

function tagSet(tags: unknown): Set<string> {
  expect(Array.isArray(tags), `${evidence} tags must be an array`).toBe(true);
  const values = tags as readonly unknown[];
  expect(values.every((item) => typeof item === 'string')).toBe(true);
  return new Set(values as readonly string[]);
}

/**
 * OR-set membership is the protocol obligation. Order must be deterministic:
 * the same inputs yield the same array. When production sorts, `sorted: true`
 * locks the lexicographic contract.
 */
function expectTags(
  actual: unknown,
  expectedMembers: readonly string[],
  options: { readonly sorted?: boolean } = {},
): void {
  const actualSet = tagSet(actual);
  expect(actualSet).toEqual(new Set(expectedMembers));
  expect((actual as readonly string[]).length).toBe(expectedMembers.length);
  if (options.sorted === true) {
    expect(actual).toEqual([...expectedMembers].sort());
  }
}

describe(`SYNC-0017 three-way typed update merge ${evidence}`, () => {
  it(`exports the same merge helper from the Sync package surface and module ${evidence}`, () => {
    expect(typeof mergeSyncTypedUpdate).toBe('function');
    expect(mergeSyncTypedUpdate).toBe(mergeFromModule);
  });

  it(`1. no-op client (incoming equals base) keeps concurrent server field changes ${evidence}`, () => {
    // Client observed base and resubmitted the same values; server concurrently retitled.
    const base = { title: 'Old title', tags: ['a'] };
    const current = { title: 'Server title', tags: ['a'] };
    const incoming = { title: 'Old title', tags: ['a'] };

    const value = expectMerged(merge({ base, current, incoming }), {
      title: 'Server title',
      tags: ['a'],
    });

    // Always-incoming would drop the concurrent server title.
    expect(value.title).toBe(current.title);
    expect(value.title).not.toBe(incoming.title);
  });

  it(`1b. no-op client retains concurrent current-only changes on other fields ${evidence}`, () => {
    const base = { title: 'Stable', note: 'seen' };
    const current = { title: 'Stable', note: 'server-only rewrite' };
    const incoming = { title: 'Stable', note: 'seen' };

    const value = expectMerged(merge({ base, current, incoming }), {
      title: 'Stable',
      note: 'server-only rewrite',
    });
    expect(value.note).toBe(current.note);
    expect(value.note).not.toBe(incoming.note);
  });

  it(`2. clean client write (current equals base) applies incoming field values ${evidence}`, () => {
    const base = { title: 'Old title', tags: ['old'] };
    const current = { title: 'Old title', tags: ['old'] };
    const incoming = { title: 'New title', tags: ['new'] };

    const value = expectMerged(merge({ base, current, incoming }), {
      title: 'New title',
      tags: ['new'],
    });

    // Always-current would keep the base title/tags.
    expect(value.title).toBe(incoming.title);
    expect(value.title).not.toBe(base.title);
    expect(tagSet(value.tags)).toEqual(new Set(['new']));
  });

  it(`3. agreeing concurrent edits merge the shared value without conflict ${evidence}`, () => {
    const base = { title: 'Old title' };
    const current = { title: 'Same next title' };
    const incoming = { title: 'Same next title' };

    const value = expectMerged(merge({ base, current, incoming }), {
      title: 'Same next title',
    });
    expect(value.title).toBe(current.title);
    expect(value.title).toBe(incoming.title);
  });

  it(`4. field conflict when base, current, and incoming all differ reports the field ${evidence}`, () => {
    const base = { title: 'A' };
    const current = { title: 'B' };
    const incoming = { title: 'C' };

    const result = merge({ base, current, incoming });
    expectFieldConflict(result, 'title');

    // Fail closed: must not pick current or incoming as a silent winner.
    expect(result).not.toMatchObject({ status: 'merged', value: { title: 'B' } });
    expect(result).not.toMatchObject({ status: 'merged', value: { title: 'C' } });
    expect(result).not.toMatchObject({ status: 'merged', value: { title: 'A' } });
  });

  it(`5. Tag Observed-Remove: client remove retains concurrent unobserved adds ${evidence}`, () => {
    // base [a,b], incoming [b] ⇒ observed remove {a}
    // current [a,b,c] ⇒ concurrent add {c} must survive; a must leave.
    const base = { tags: ['a', 'b'] };
    const current = { tags: ['a', 'b', 'c'] };
    const incoming = { tags: ['b'] };

    const result = merge({ base, current, incoming });
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('expected merged');

    // Membership obligation (order independent).
    expectTags(result.value.tags, ['b', 'c']);
    // Prefer lexicographic order when the production merge sorts tags.
    expectTags(result.value.tags, ['b', 'c'], { sorted: true });

    // Explicit anti-false-positive: not wholesale replace with incoming, not leave current.
    expect(tagSet(result.value.tags).has('a')).toBe(false);
    expect(tagSet(result.value.tags).has('c')).toBe(true);
    expect(tagSet(result.value.tags)).not.toEqual(tagSet(incoming.tags));
    expect(tagSet(result.value.tags)).not.toEqual(tagSet(current.tags));
  });

  it(`6. Tag OR-set concurrent add + client add unions both sides ${evidence}`, () => {
    // base [a], current [a,x] (server add x), incoming [a,y] (client add y)
    const base = { tags: ['a'] };
    const current = { tags: ['a', 'x'] };
    const incoming = { tags: ['a', 'y'] };

    const result = merge({ base, current, incoming });
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('expected merged');

    expectTags(result.value.tags, ['a', 'x', 'y']);
    // Document deterministic order: lexicographic sort is the expected contract.
    expectTags(result.value.tags, ['a', 'x', 'y'], { sorted: true });

    // Always-incoming drops x; always-current drops y.
    expect(tagSet(result.value.tags).has('x')).toBe(true);
    expect(tagSet(result.value.tags).has('y')).toBe(true);
    expect(tagSet(result.value.tags)).not.toEqual(tagSet(incoming.tags));
    expect(tagSet(result.value.tags)).not.toEqual(tagSet(current.tags));
  });

  it(`7. tags cannot silent overwrite unobserved concurrent members ${evidence}`, () => {
    // Same structural obligation as case 5: a client that "replaces" the whole
    // tags array still cannot erase concurrent members it never observed.
    const base = { tags: ['a', 'b'] };
    const current = { tags: ['a', 'b', 'c'] };
    const incoming = { tags: ['b'] };

    const first = merge({ base, current, incoming });
    const second = merge({ base, current, incoming });
    expect(first).toEqual(second);
    expect(first.status).toBe('merged');
    expect(second.status).toBe('merged');
    if (first.status !== 'merged' || second.status !== 'merged') {
      throw new Error('expected merged');
    }

    expectTags(first.value.tags, ['b', 'c'], { sorted: true });
    expect(first.value.tags).toEqual(second.value.tags);
  });

  it(`8. multi-field mix: clean title write + tags OR-set + current-only note ${evidence}`, () => {
    const base = {
      title: 'Old title',
      tags: ['a', 'b'],
      note: 'seen-note',
    };
    const current = {
      title: 'Old title',
      tags: ['a', 'b', 'c'],
      note: 'server-note',
    };
    const incoming = {
      title: 'New title',
      tags: ['b'],
      note: 'seen-note',
    };

    const result = merge({ base, current, incoming });
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('expected merged');

    expect(result.value.title).toBe('New title');
    expectTags(result.value.tags, ['b', 'c'], { sorted: true });
    expect(result.value.note).toBe('server-note');

    // Composite anti-false-positive against always-incoming / always-current.
    expect(result.value).not.toEqual(incoming);
    expect(result.value).not.toEqual(current);
    expect(result.value).not.toEqual(base);
  });

  it(`9. deep equality for nested plain objects when they are merge fields ${evidence}`, () => {
    // Nested plain objects are compared by value (deep equality), not identity.
    // Primary typed-update surface is top-level scalars + tags; nested objects
    // are supported when the merge field value is itself a plain JSON object.
    const nestedBase = { label: 'before', count: 1 };
    const base = { meta: nestedBase };
    const current = { meta: { label: 'before', count: 1 } };
    const incoming = { meta: { label: 'after', count: 1 } };

    const value = expectMerged(merge({ base, current, incoming }), {
      meta: { label: 'after', count: 1 },
    });
    expect(value.meta).toEqual(incoming.meta);
    expect(value.meta).not.toBe(incoming.meta);
  });

  it(`9b. scalar three-way deep equality still distinguishes equal vs conflicting values ${evidence}`, () => {
    // Scalars remain the primary typed-update surface (title, note, format, …).
    const equal = merge({
      base: { title: 'A' },
      current: { title: 'A' },
      incoming: { title: 'A' },
    });
    expectMerged(equal, { title: 'A' });

    const conflict = merge({
      base: { title: 'A' },
      current: { title: 'B' },
      incoming: { title: 'C' },
    });
    expectFieldConflict(conflict, 'title');
  });

  it(`returns frozen merge results that do not alias the input objects ${evidence}`, () => {
    const base = { title: 'Old', tags: ['a'] };
    const current = { title: 'Old', tags: ['a'] };
    const incoming = { title: 'New', tags: ['b'] };

    const result = merge({ base, current, incoming });
    expect(result.status).toBe('merged');
    if (result.status !== 'merged') throw new Error('expected merged');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value).not.toBe(base);
    expect(result.value).not.toBe(current);
    expect(result.value).not.toBe(incoming);
    if (Array.isArray(result.value.tags)) {
      expect(Object.isFrozen(result.value.tags)).toBe(true);
    }
  });

  it(`is deterministic for identical Base / Current / Incoming inputs ${evidence}`, () => {
    const input: MergeInput = {
      base: { title: 'Old', tags: ['m', 'a'] },
      current: { title: 'Old', tags: ['m', 'a', 'z'] },
      incoming: { title: 'New', tags: ['m', 'b'] },
    };

    const first = merge(input);
    const second = merge(input);
    expect(first).toEqual(second);
  });

  it.each([
    ['null base', { base: null, current: { title: 'x' }, incoming: { title: 'x' } }],
    ['array current', { base: { title: 'x' }, current: ['x'], incoming: { title: 'x' } }],
    ['string incoming', { base: { title: 'x' }, current: { title: 'x' }, incoming: 'x' }],
    [
      'inherited prototype base',
      {
        base: Object.create({ title: 'inherited' }) as DataObject,
        current: { title: 'x' },
        incoming: { title: 'x' },
      },
    ],
  ] as const)(`10. rejects invalid %s fail-closed (throw or conflict) ${evidence}`, (_label, input) => {
    let thrown: unknown;
    let result: MergeResult | undefined;
    try {
      result = merge(input as unknown as MergeInput);
    } catch (error) {
      thrown = error;
    }

    if (thrown !== undefined) {
      expect(thrown).toBeInstanceOf(Error);
      return;
    }

    // Fail-closed conflict is acceptable; a silent merged value is not.
    expect(result, `${evidence} invalid inputs must not merge successfully`).toBeDefined();
    expect(result?.status).toBe('conflict');
  });

  it(`anti-strategy: never always-incoming and never always-current ${evidence}`, () => {
    // Composite oracle: three scenarios where always-incoming and always-current
    // each fail at least once. Production must match the protocol matrix.
    const noOp = merge({
      base: { title: 'Base' },
      current: { title: 'Current' },
      incoming: { title: 'Base' },
    });
    expectMerged(noOp, { title: 'Current' });

    const clean = merge({
      base: { title: 'Base' },
      current: { title: 'Base' },
      incoming: { title: 'Incoming' },
    });
    expectMerged(clean, { title: 'Incoming' });

    const tags = merge({
      base: { tags: ['a', 'b'] },
      current: { tags: ['a', 'b', 'c'] },
      incoming: { tags: ['b'] },
    });
    expect(tags.status).toBe('merged');
    if (tags.status !== 'merged') throw new Error('expected merged');
    expectTags(tags.value.tags, ['b', 'c'], { sorted: true });
  });

  it(`covers fail-closed deep equality and tag observation boundaries ${evidence}`, () => {
    expect(deepEqualSyncMergeValue(null, undefined)).toBe(false);
    expect(deepEqualSyncMergeValue([1, 2], [1])).toBe(false);
    expect(deepEqualSyncMergeValue([1, { x: 2 }], [1, { x: 3 }])).toBe(false);
    expect(deepEqualSyncMergeValue({ a: 1 }, { b: 1 })).toBe(false);
    expect(deepEqualSyncMergeValue(Object.create(null, { a: { enumerable: true, value: 1 } }), { a: 1 })).toBe(true);
    expect(deepEqualSyncMergeValue(new Date(0), new Date(0))).toBe(false);

    expect(mergeSyncTagsObservedRemove({ baseTags: undefined, currentTags: ['a'], incomingTags: undefined })).toMatchObject({
      status: 'merged', tags: ['a'],
    });
    for (const field of ['baseTags', 'currentTags', 'incomingTags'] as const) {
      const input = { baseTags: ['a'], currentTags: ['a'], incomingTags: ['b'] };
      input[field] = [1] as never;
      expect(mergeSyncTagsObservedRemove(input)).toMatchObject({ status: 'conflict' });
    }
    expect(() => merge({
      base: { title: 'a' },
      current: { title: 'b' },
      incoming: { title: 'c', extra: true },
    })).toThrow(TypeError);
  });

  it(`takes the newer concurrent lastUsedAt instant (protocol §10.2) ${evidence}`, () => {
    expectMerged(
      merge({
        base: { lastUsedAt: '2026-01-01T00:00:00Z' },
        current: { lastUsedAt: '2026-03-01T00:00:00Z' },
        incoming: { lastUsedAt: '2026-06-01T00:00:00Z' },
      }),
      { lastUsedAt: '2026-06-01T00:00:00Z' },
    );
    expectMerged(
      merge({
        base: { lastUsedAt: '2026-01-01T00:00:00Z' },
        current: { lastUsedAt: '2026-08-01T00:00:00Z' },
        incoming: { lastUsedAt: '2026-04-01T00:00:00Z' },
      }),
      { lastUsedAt: '2026-08-01T00:00:00Z' },
    );
    expectFieldConflict(
      merge({
        base: { title: 'Old', lastUsedAt: '2026-01-01T00:00:00Z' },
        current: { title: 'Server', lastUsedAt: '2026-03-01T00:00:00Z' },
        incoming: { title: 'Laptop', lastUsedAt: '2026-06-01T00:00:00Z' },
      }),
      'title',
    );
    expectFieldConflict(
      merge({
        base: { lastUsedAt: '2026-01-01T00:00:00Z' },
        current: { lastUsedAt: 'not-a-time' },
        incoming: { lastUsedAt: '2026-06-01T00:00:00Z' },
      }),
      'lastUsedAt',
    );
  });
});
