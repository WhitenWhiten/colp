import { createHash } from 'node:crypto';

import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { computeOperationsDigest } from '../../src/mcp/change-plan.js';

/**
 * U-16: exported computeOperationsDigest copies plain data before canonicalize.
 * A hook, a Date, and an array hole are rejected. The hook does not run.
 * Holes are not digested as null. Plain JSON keeps the previous digest bytes.
 */

const evidence = '[review:mcp.operations-digest-plain]';

function digestOf(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error('Value is not canonical JSON.');
  return `sha-256:${createHash('sha256').update(canonical).digest('base64url')}`;
}

describe(`${evidence} U-16 operations digest plain-data boundary`, () => {
  it(`${evidence} keeps the same digest bytes for plain wire JSON`, () => {
    const operations = [{
      type: 'set_visibility',
      collectionId: 'collection-1',
      baseRevision: 'acl_17',
      input: { visibility: 'public', b: 1, a: 2 },
    }];
    const reordered = [{
      input: { a: 2, b: 1, visibility: 'public' },
      baseRevision: 'acl_17',
      collectionId: 'collection-1',
      type: 'set_visibility',
    }];
    const wire = JSON.parse(JSON.stringify(operations)) as unknown[];
    expect(computeOperationsDigest(wire)).toBe(digestOf(wire));
    expect(computeOperationsDigest(operations)).toBe(digestOf(operations));
    expect(computeOperationsDigest(reordered)).toBe(computeOperationsDigest(operations));
  });

  it(`${evidence} rejects a memory hook without running it`, () => {
    let calls = 0;
    const proto = { toJSON() { calls += 1; return { hijacked: true }; } };
    const operation = Object.assign(Object.create(proto), {
      type: 'set_visibility',
      collectionId: 'collection-1',
    });
    expect(() => computeOperationsDigest([operation])).toThrow(/canonicalizable/u);
    expect(calls).toBe(0);

    calls = 0;
    const accessor: Record<string, unknown> = { type: 'set_visibility' };
    Object.defineProperty(accessor, 'note', {
      enumerable: true,
      get() { calls += 1; return 'hijacked'; },
    });
    expect(() => computeOperationsDigest([accessor])).toThrow(/canonicalizable/u);
    expect(calls).toBe(0);
  });

  it(`${evidence} rejects a Date without calling toJSON`, () => {
    let calls = 0;
    const original = Date.prototype.toJSON;
    Date.prototype.toJSON = function toJSON() { calls += 1; return '1970-01-01T00:00:00.000Z'; };
    try {
      expect(() => computeOperationsDigest([{ at: new Date(0) }])).toThrow(/canonicalizable/u);
      expect(calls).toBe(0);
    } finally {
      Date.prototype.toJSON = original;
    }
  });

  it(`${evidence} rejects an array hole instead of digesting it as null`, () => {
    const hole: unknown[] = [{ type: 'keep' }];
    delete hole[0];
    expect(() => computeOperationsDigest(hole)).toThrow(/canonicalizable/u);
    expect(() => computeOperationsDigest(undefined as never)).toThrow(/canonicalizable/u);
  });
});
