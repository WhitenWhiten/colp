import { describe, expect, it } from 'vitest';

import {
  buildReleasePublishedFeedEvent,
  discriminateFeedEvent,
  projectFeedEvent,
  type VerifiedFeedEvent,
} from '../../src/feed/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = 'feed.cfi-001.deep-immutability';
const validators = createValidatorRegistry();

function envelope(type: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    specversion: '1.0',
    id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
    source: 'https://alice.example/collections',
    type,
    subject: 'collections/c/collection-1',
    time: '2026-07-16T06:30:00Z',
    datacontenttype: 'application/json',
    collectionprotocolversion: '0.1',
    data,
  };
}

function releaseEvent(): Record<string, unknown> {
  return envelope('com.know-n.colp.release.published.v1', {
    collectionId: 'collection-1',
    revision: 'revision-1',
    changes: { created: 1, updated: 2, moved: 3, deleted: 4 },
    releaseId: 'release-1',
    snapshotUrl: 'https://alice.example/c/collection-1/releases/release-1/snapshot',
    snapshotDigest: `sha-256=:${'A'.repeat(43)}=:`,
  });
}

function bookmarkEvent(): Record<string, unknown> {
  return envelope('com.know-n.colp.node.created.v1', {
    collectionId: 'collection-1',
    revision: 'revision-1',
    node: {
      id: 'node-1',
      kind: 'bookmark',
      title: 'A bookmark',
      url: 'https://example.com/article',
    },
  });
}

function extensionEvent(extensionValue: unknown): Record<string, unknown> {
  return envelope('https://vendor.example/events/future.v1', {
    collectionId: 'collection-1',
    extensions: { 'https://vendor.example/ns': extensionValue },
  });
}

function expectMalformed(input: unknown): void {
  const result = discriminateFeedEvent(input, validators);
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.code).toBe('malformed_event');
}

function expectVerifiedApi(event: VerifiedFeedEvent): VerifiedFeedEvent {
  return event;
}

describe(`CFI-001 verified Feed Event deep immutability [evidence:${evidence}]`, () => {
  it('throws TypeError for mutations at each verified nested path and preserves serialization', () => {
    const cases: Array<{
      readonly input: Record<string, unknown>;
      readonly mutate: (event: Record<string, unknown>) => void;
    }> = [
      {
        input: releaseEvent(),
        mutate: (event) => {
          (event as Record<string, unknown>).data = {};
        },
      },
      {
        input: bookmarkEvent(),
        mutate: (event) => {
          const data = event.data as Record<string, unknown>;
          ((data.node as Record<string, unknown>).url as string) = 'https://evil.example/';
        },
      },
      {
        input: releaseEvent(),
        mutate: (event) => {
          const data = event.data as Record<string, unknown>;
          ((data.changes as Record<string, unknown>).updated as number) = 999;
        },
      },
      {
        input: extensionEvent({ nested: { value: 'original' } }),
        mutate: (event) => {
          const data = event.data as Record<string, unknown>;
          const extensions = data.extensions as Record<string, unknown>;
          const namespace = extensions['https://vendor.example/ns'] as Record<string, unknown>;
          ((namespace.nested as Record<string, unknown>).value as string) = 'tampered';
        },
      },
    ];

    for (const { input, mutate } of cases) {
      const result = discriminateFeedEvent(input, validators);
      expect(result.valid).toBe(true);
      if (!result.valid) continue;
      expectVerifiedApi(result.event);
      const verified = result.event as unknown as Record<string, unknown>;
      const before = JSON.stringify(verified);
      expect(() => mutate(verified)).toThrow(TypeError);
      expect(JSON.stringify(verified)).toBe(before);
    }
  });

  it('detaches the verified snapshot from later mutations of the original input', () => {
    const input = releaseEvent();
    const result = discriminateFeedEvent(input, validators);
    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const verified = JSON.stringify(result.event);
    const data = input.data as Record<string, unknown>;
    (data.changes as Record<string, unknown>).updated = 777;
    data.snapshotUrl = 'https://evil.example/changed';

    expect(JSON.stringify(result.event)).toBe(verified);
    expect((result.event.data as Record<string, unknown>).changes).toEqual({
      created: 1,
      updated: 2,
      moved: 3,
      deleted: 4,
    });
  });

  it('rejects nested accessors without invoking their getters', () => {
    let getterCalls = 0;
    const data = {
      collectionId: 'collection-1',
      revision: 'revision-1',
      changes: { created: 1, updated: 2, moved: 3, deleted: 4 },
      releaseId: 'release-1',
      snapshotUrl: 'https://alice.example/c/collection-1/releases/release-1/snapshot',
      snapshotDigest: `sha-256=:${'A'.repeat(43)}=:`,
    } as Record<string, unknown>;
    Object.defineProperty(data, 'changes', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterCalls += 1;
        return { created: 1, updated: 2, moved: 3, deleted: 4 };
      },
    });

    expectMalformed(envelope('com.know-n.colp.release.published.v1', data));
    expect(getterCalls).toBe(0);
  });

  it('rejects nested Proxies without invoking any Proxy trap', () => {
    let trapCalls = 0;
    const trapped = (): never => {
      trapCalls += 1;
      throw new Error('proxy trap must not run');
    };
    const node = new Proxy(
      {
        id: 'node-1',
        kind: 'bookmark',
        title: 'A bookmark',
        url: 'https://example.com/article',
      },
      {
        get: trapped,
        getOwnPropertyDescriptor: trapped,
        getPrototypeOf: trapped,
        has: trapped,
        ownKeys: trapped,
      },
    );
    const data = {
      collectionId: 'collection-1',
      revision: 'revision-1',
      node,
    };

    expectMalformed(envelope('com.know-n.colp.node.created.v1', data));
    expect(trapCalls).toBe(0);
  });

  it('uses the same no-trap snapshot boundary in the release builder', () => {
    let trapCalls = 0;
    const changes = new Proxy(
      { created: 1, updated: 2, moved: 3, deleted: 4 },
      {
        get: () => {
          trapCalls += 1;
          throw new Error('builder must not read a Proxy');
        },
        getOwnPropertyDescriptor: () => {
          trapCalls += 1;
          throw new Error('builder must not inspect a Proxy');
        },
        ownKeys: () => {
          trapCalls += 1;
          throw new Error('builder must not enumerate a Proxy');
        },
      },
    );

    const result = buildReleasePublishedFeedEvent({
      id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
      source: 'https://alice.example/collections',
      subject: 'collections/c/collection-1/releases/release-1',
      time: '2026-07-16T06:30:00Z',
      collectionId: 'collection-1',
      revision: 'revision-1',
      releaseId: 'release-1',
      snapshotUrl: 'https://alice.example/c/collection-1/releases/release-1/snapshot',
      snapshotDigest: `sha-256=:${'A'.repeat(43)}=:`,
      changes,
    }, validators);

    expect(result).toEqual({ ok: false, code: 'malformed_input' });
    expect(trapCalls).toBe(0);
  });

  it('returns a detached, deeply frozen verified event from the release builder', () => {
    const changes = { created: 1, updated: 2, moved: 3, deleted: 4 };
    const result = buildReleasePublishedFeedEvent({
      id: '019b3d0b-efcf-7fa7-9778-33e8e77620f4',
      source: 'https://alice.example/collections',
      subject: 'collections/c/collection-1/releases/release-1',
      time: '2026-07-16T06:30:00Z',
      collectionId: 'collection-1',
      revision: 'revision-1',
      releaseId: 'release-1',
      snapshotUrl: 'https://alice.example/c/collection-1/releases/release-1/snapshot',
      snapshotDigest: `sha-256=:${'A'.repeat(43)}=:`,
      changes,
    }, validators);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = result.event as unknown as Record<string, unknown>;
    const data = event.data as Record<string, unknown>;
    const verifiedChanges = data.changes as Record<string, unknown>;
    const before = JSON.stringify(event);

    expect(() => {
      verifiedChanges.updated = 999;
    }).toThrow(TypeError);
    changes.updated = 777;
    expect(JSON.stringify(event)).toBe(before);
    expect(verifiedChanges.updated).toBe(2);
  });

  it('uses the same no-trap snapshot boundary in full-event projection', () => {
    let trapCalls = 0;
    const nested = new Proxy(
      { value: 'public' },
      {
        get: () => {
          trapCalls += 1;
          throw new Error('projection must not read a Proxy');
        },
        getOwnPropertyDescriptor: () => {
          trapCalls += 1;
          throw new Error('projection must not inspect a Proxy');
        },
        ownKeys: () => {
          trapCalls += 1;
          throw new Error('projection must not enumerate a Proxy');
        },
      },
    );

    expect(projectFeedEvent(extensionEvent({ nested }), { validators })).toEqual({
      ok: false,
      code: 'projection_failed',
    });
    expect(trapCalls).toBe(0);
  });

  it.each([
    ['cycle', () => {
      const nested: Record<string, unknown> = {};
      nested.self = nested;
      return extensionEvent({ nested });
    }],
    ['symbol key', () => {
      const nested: Record<string | symbol, unknown> = { value: 'ok' };
      nested[Symbol('hidden')] = 'not JSON';
      return extensionEvent(nested);
    }],
    ['symbol value', () => extensionEvent({ value: Symbol('not JSON') })],
    ['sparse array', () => {
      const sparse = new Array<unknown>(3);
      sparse[0] = 'present';
      sparse[2] = 'present';
      return extensionEvent({ values: sparse });
    }],
    ['array extra property', () => {
      const values = ['present'];
      Object.defineProperty(values, 'extra', { value: 'not JSON', enumerable: true });
      return extensionEvent({ values });
    }],
    ['function', () => extensionEvent({ value: () => true })],
    ['undefined', () => extensionEvent({ value: undefined })],
    ['bigint', () => extensionEvent({ value: BigInt(1) })],
    ['NaN', () => extensionEvent({ value: Number.NaN })],
    ['positive infinity', () => extensionEvent({ value: Number.POSITIVE_INFINITY })],
    ['negative infinity', () => extensionEvent({ value: Number.NEGATIVE_INFINITY })],
    ['unsafe number', () => extensionEvent({ value: Number.MAX_SAFE_INTEGER + 1 })],
    ['non-JSON prototype', () => extensionEvent(Object.create({ inherited: true }))],
  ] as const)('rejects nested %s as malformed without reading unsafe values', (_label, makeInput) => {
    expectMalformed(makeInput());
  });

  it('rejects inputs that exceed the explicit depth and member budgets', () => {
    const deeplyNested: Record<string, unknown> = {};
    let cursor = deeplyNested;
    for (let depth = 0; depth < 70; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }

    const tooManyMembers: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) {
      tooManyMembers[`member-${index}`] = index;
    }

    expectMalformed(extensionEvent(deeplyNested));
    expectMalformed(extensionEvent(tooManyMembers));
  });
});
