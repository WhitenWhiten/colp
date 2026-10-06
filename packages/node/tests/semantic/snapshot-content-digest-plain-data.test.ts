import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

/**
 * U-16: direct Snapshot content digest copies plain data before canonicalize.
 * Hooks, Dates, and array holes are rejected. Holes are not treated as null.
 */

const evidence = '[review:semantic.snapshot-digest-plain]';
const fixturePath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'collection-snapshot.json');

async function wireSnapshot(): Promise<Snapshot> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Snapshot;
}

function digestOf(value: unknown): string {
  const canonical = canonicalize(value);
  if (canonical === undefined) throw new Error('Fixture is not canonical JSON.');
  return `sha-256=:${createHash('sha256').update(canonical).digest('base64')}:`;
}

describe(`${evidence} U-16 snapshot logical digest plain-data boundary`, () => {
  it(`${evidence} keeps the same digest bytes for plain wire JSON`, async () => {
    const snapshot = await wireSnapshot();
    const wire = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    snapshot.contentDigest = digestOf(wire);
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    const mismatch = validateSnapshotSemantics(snapshot);
    expect(mismatch.valid).toBe(false);
    if (!mismatch.valid) {
      expect(mismatch.issues.map(({ code }) => code)).toContain('snapshot_content_digest_mismatch');
    }
  });

  it(`${evidence} rejects a memory hook without running it`, async () => {
    let calls = 0;
    const snapshot = await wireSnapshot();
    const proto = { toJSON() { calls += 1; return { hijacked: true }; } };
    snapshot.nodes[0] = Object.assign(Object.create(proto), snapshot.nodes[0]) as Snapshot['nodes'][number];
    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    expect(() => validateSnapshotSemantics(snapshot)).toThrow(TypeError);
    expect(calls).toBe(0);

    calls = 0;
    const accessor = await wireSnapshot();
    Object.defineProperty(accessor, 'contentDigest', {
      enumerable: true,
      get() { calls += 1; return 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:'; },
    });
    expect(() => validateSnapshotSemantics(accessor)).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it(`${evidence} rejects a Date without calling toJSON`, async () => {
    let calls = 0;
    const original = Date.prototype.toJSON;
    Date.prototype.toJSON = function toJSON() { calls += 1; return '1970-01-01T00:00:00.000Z'; };
    try {
      const snapshot = await wireSnapshot();
      (snapshot as { generatedAt: unknown }).generatedAt = new Date(0);
      snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
      expect(() => validateSnapshotSemantics(snapshot)).toThrow(TypeError);
      expect(calls).toBe(0);
    } finally {
      Date.prototype.toJSON = original;
    }
  });

  it.each(['nodes', 'page', 'complete', 'collection'] as const)(
    `${evidence} rejects a %s getter before semantic checks can execute it`, async (key) => {
      const snapshot = await wireSnapshot();
      const value = snapshot[key];
      let calls = 0;
      snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
      Object.defineProperty(snapshot, key, { enumerable: true, get() { calls++; return value; } });
      expect(() => validateSnapshotSemantics(snapshot)).toThrow(TypeError);
      expect(calls).toBe(0);
    },
  );

  it(`${evidence} rejects nested getters and proxy traps before reading digest data`, async () => {
    const snapshot = await wireSnapshot();
    const node = snapshot.nodes[0]!;
    const id = node.id;
    let calls = 0;
    snapshot.contentDigest = 'sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:';
    Object.defineProperty(node, 'id', { enumerable: true, get() { calls++; return id; } });
    expect(() => validateSnapshotSemantics(snapshot)).toThrow(TypeError);
    expect(calls).toBe(0);

    const plain = await wireSnapshot();
    plain.contentDigest = snapshot.contentDigest;
    const proxy = new Proxy(plain, {
      get(target, key) { calls++; return Reflect.get(target, key); },
      getOwnPropertyDescriptor(target, key) { calls++; return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    expect(() => validateSnapshotSemantics(proxy)).toThrow(TypeError);
    expect(calls).toBe(0);
    const nested = await wireSnapshot();
    nested.contentDigest = snapshot.contentDigest;
    nested.nodes[0] = new Proxy(nested.nodes[0]!, { get(target, key) { calls++; return Reflect.get(target, key); } });
    expect(() => validateSnapshotSemantics(nested)).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it(`${evidence} rejects an array hole instead of treating it as null`, async () => {
    const snapshot = await wireSnapshot();
    delete (snapshot.nodes as unknown[])[0];
    snapshot.contentDigest = digestOf(JSON.parse(JSON.stringify(await wireSnapshot())));
    expect(() => validateSnapshotSemantics(snapshot)).toThrow(TypeError);
  });
});
