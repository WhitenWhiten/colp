import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { preparePublicationQuery } from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { propertyOptions } from '../helpers/property-options.js';
import {
  createPublicationDirectoryCursor,
  createPublicationDirectoryCursorHmacKey,
  createPublicationDirectoryFilterDigest,
  createPublicationRepresentationEtag,
  createPublicationSnapshotCursor,
  createPublicationSnapshotCursorHmacKey,
  decodePublicationQuery,
  verifyPublicationDirectoryCursor,
  verifyPublicationSnapshotCursor,
  type PublicationDirectoryCursorContext,
  type PublicationDirectoryCursorFilter,
  type PublicationDirectoryCursorScope,
  type PublicationRepresentationEtagInput,
  type PublicationSnapshotCursorContext,
  type PublicationSnapshotCursorScope,
  type PublicationSnapshotInclude,
} from '../../src/server/index.js';

const RUNS = 60;
const TAMPER_RUNS = 40;
const invalidCursor = Object.freeze({ valid: false, code: 'invalid_cursor_scope' } as const);
const includeValues = ['annotations', 'attachments', 'relations'] as const;
const safeChunks = ['a', 'Z', '0', '-', '_', '.', ' ', 'é', '汉', '😀'] as const;
const validators = createValidatorRegistry();

const boundedText = (maximumChunks = 12) => fc.array(fc.constantFrom(...safeChunks), {
  minLength: 1,
  maxLength: maximumChunks,
}).map((parts) => parts.join(''));

const opaqueText = fc.array(fc.constantFrom(
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-',
), { minLength: 1, maxLength: 24 }).map((characters) => characters.join(''));

const options = (numRuns = RUNS) => propertyOptions(numRuns);

const cursorPosition = fc.array(fc.constantFrom(...safeChunks), { minLength: 1, maxLength: 14 })
  .map((parts) => parts.join(''))
  .filter((value) => Buffer.byteLength(value, 'utf8') <= 58);

const signingKey = fc.uint8Array({ minLength: 32, maxLength: 64 });
const includeSet = fc.uniqueArray(fc.constantFrom(...includeValues), {
  minLength: 0,
  maxLength: includeValues.length,
});

const snapshotScope = fc.record({
  revision: boundedText(),
  principal: boundedText(),
  root: fc.option(boundedText(), { nil: undefined }),
  depth: fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
  include: fc.option(includeSet, { nil: undefined }),
  pageSize: fc.integer({ min: 1, max: 500 }),
  nextPosition: cursorPosition,
}) as fc.Arbitrary<PublicationSnapshotCursorScope>;

const directoryScope = fc.record({
  principal: boundedText(),
  filterDigest: boundedText(),
  sort: boundedText(),
  limit: fc.integer({ min: 1, max: 500 }),
  protocolVersion: boundedText(5),
  nextPosition: cursorPosition,
}) as fc.Arbitrary<PublicationDirectoryCursorScope>;

function snapshotContext(scope: PublicationSnapshotCursorScope): PublicationSnapshotCursorContext {
  const { nextPosition: _nextPosition, ...context } = scope;
  return context;
}

function directoryContext(scope: PublicationDirectoryCursorScope): PublicationDirectoryCursorContext {
  const { nextPosition: _nextPosition, ...context } = scope;
  return context;
}

function changedText(value: string): string {
  return value === 'changed' ? 'changed-again' : 'changed';
}

function mutateCursorSegment(cursor: string, segment: 'position' | 'mac', seed: number): string {
  const positionStart = cursor.indexOf('.p') + 2;
  const separator = cursor.indexOf('.', positionStart);
  const mutableStart = segment === 'position' ? positionStart : separator + 1;
  const mutableEnd = segment === 'position' ? separator : cursor.length;
  const index = mutableStart + (seed % (mutableEnd - mutableStart));
  const original = cursor[index] as string;
  const replacement = original === 'A' ? 'B' : 'A';
  return `${cursor.slice(0, index)}${replacement}${cursor.slice(index + 1)}`;
}

describe('Publication property invariants', () => {
  it('round-trips every bounded Snapshot cursor scope and private key', () => {
    fc.assert(fc.property(snapshotScope, signingKey, (scope, keyBytes) => {
      const key = createPublicationSnapshotCursorHmacKey(keyBytes);
      const cursor = createPublicationSnapshotCursor(scope, key);
      expect(verifyPublicationSnapshotCursor(cursor, snapshotContext(scope), key)).toEqual({
        valid: true,
        nextPosition: scope.nextPosition,
      });
    }), options());
  });

  it('binds every Snapshot request-scope field into the cursor MAC', () => {
    fc.assert(fc.property(snapshotScope, signingKey, (scope, keyBytes) => {
      const key = createPublicationSnapshotCursorHmacKey(keyBytes);
      const cursor = createPublicationSnapshotCursor(scope, key);
      const context = snapshotContext(scope);
      const alternativeInclude: readonly PublicationSnapshotInclude[] = context.include?.includes('annotations')
        ? context.include.filter((value) => value !== 'annotations')
        : [...(context.include ?? []), 'annotations'];
      const changes: PublicationSnapshotCursorContext[] = [
        { ...context, revision: changedText(context.revision) },
        { ...context, principal: changedText(context.principal) },
        { ...context, root: context.root === undefined ? 'changed' : changedText(context.root) },
        { ...context, depth: context.depth === undefined ? 0 : context.depth + 1 },
        { ...context, include: alternativeInclude },
        { ...context, pageSize: context.pageSize + 1 },
      ];
      for (const changed of changes) {
        expect(verifyPublicationSnapshotCursor(cursor, changed, key)).toEqual(invalidCursor);
      }
    }), options());
  });

  it('rejects Snapshot cursor character tampering, truncation, and a different key', () => {
    fc.assert(fc.property(snapshotScope, signingKey, signingKey, fc.nat(), (scope, keyBytes, wrongBytes, seed) => {
      fc.pre(Buffer.compare(Buffer.from(keyBytes), Buffer.from(wrongBytes)) !== 0);
      const key = createPublicationSnapshotCursorHmacKey(keyBytes);
      const wrongKey = createPublicationSnapshotCursorHmacKey(wrongBytes);
      const cursor = createPublicationSnapshotCursor(scope, key);
      const context = snapshotContext(scope);
      expect(verifyPublicationSnapshotCursor(mutateCursorSegment(cursor, 'position', seed), context, key))
        .toEqual(invalidCursor);
      expect(verifyPublicationSnapshotCursor(mutateCursorSegment(cursor, 'mac', seed), context, key))
        .toEqual(invalidCursor);
      expect(verifyPublicationSnapshotCursor(cursor.slice(0, -1), context, key)).toEqual(invalidCursor);
      expect(verifyPublicationSnapshotCursor(cursor, context, wrongKey)).toEqual(invalidCursor);
    }), options(TAMPER_RUNS));
  });

  it('round-trips every bounded Directory cursor scope and private key', () => {
    fc.assert(fc.property(directoryScope, signingKey, (scope, keyBytes) => {
      const key = createPublicationDirectoryCursorHmacKey(keyBytes);
      const cursor = createPublicationDirectoryCursor(scope, key);
      expect(verifyPublicationDirectoryCursor(cursor, directoryContext(scope), key)).toEqual({
        valid: true,
        nextPosition: scope.nextPosition,
      });
    }), options());
  });

  it('binds every Directory request-scope field into the cursor MAC', () => {
    fc.assert(fc.property(directoryScope, signingKey, (scope, keyBytes) => {
      const key = createPublicationDirectoryCursorHmacKey(keyBytes);
      const cursor = createPublicationDirectoryCursor(scope, key);
      const context = directoryContext(scope);
      const changes: PublicationDirectoryCursorContext[] = [
        { ...context, principal: changedText(context.principal) },
        { ...context, filterDigest: changedText(context.filterDigest) },
        { ...context, sort: changedText(context.sort) },
        { ...context, limit: context.limit + 1 },
        { ...context, protocolVersion: changedText(context.protocolVersion) },
      ];
      for (const changed of changes) {
        expect(verifyPublicationDirectoryCursor(cursor, changed, key)).toEqual(invalidCursor);
      }
    }), options());
  });

  it('rejects Directory cursor character tampering, truncation, and a different key', () => {
    fc.assert(fc.property(directoryScope, signingKey, signingKey, fc.nat(), (scope, keyBytes, wrongBytes, seed) => {
      fc.pre(Buffer.compare(Buffer.from(keyBytes), Buffer.from(wrongBytes)) !== 0);
      const key = createPublicationDirectoryCursorHmacKey(keyBytes);
      const wrongKey = createPublicationDirectoryCursorHmacKey(wrongBytes);
      const cursor = createPublicationDirectoryCursor(scope, key);
      const context = directoryContext(scope);
      expect(verifyPublicationDirectoryCursor(mutateCursorSegment(cursor, 'position', seed), context, key))
        .toEqual(invalidCursor);
      expect(verifyPublicationDirectoryCursor(mutateCursorSegment(cursor, 'mac', seed), context, key))
        .toEqual(invalidCursor);
      expect(verifyPublicationDirectoryCursor(cursor.slice(0, -1), context, key)).toEqual(invalidCursor);
      expect(verifyPublicationDirectoryCursor(cursor, context, wrongKey)).toEqual(invalidCursor);
    }), options(TAMPER_RUNS));
  });

  it.each([
    ['two-byte Unicode', 'é'.repeat(29), 32],
    ['two-byte Unicode with maximum key', 'é'.repeat(29), 1024],
    ['four-byte Unicode', `${'😀'.repeat(14)}ab`, 32],
    ['four-byte Unicode with maximum key', `${'😀'.repeat(14)}ab`, 1024],
  ] as const)('accepts a 58-byte %s position with a %i-byte boundary key', (_name, nextPosition, keyLength) => {
    expect(Buffer.byteLength(nextPosition, 'utf8')).toBe(58);
    const snapshotKey = createPublicationSnapshotCursorHmacKey(new Uint8Array(keyLength).fill(0x53));
    const snapshot: PublicationSnapshotCursorScope = {
      revision: '版本😀',
      principal: '用户é',
      root: '根😀',
      depth: 0,
      include: includeValues,
      pageSize: 1,
      nextPosition,
    };
    const snapshotCursor = createPublicationSnapshotCursor(snapshot, snapshotKey);
    expect(verifyPublicationSnapshotCursor(snapshotCursor, snapshotContext(snapshot), snapshotKey))
      .toEqual({ valid: true, nextPosition });

    const directoryKey = createPublicationDirectoryCursorHmacKey(new Uint8Array(keyLength).fill(0x44));
    const directory: PublicationDirectoryCursorScope = {
      principal: '用户😀',
      filterDigest: '筛选é',
      sort: '更新😀',
      limit: 1,
      protocolVersion: '版本1',
      nextPosition,
    };
    const directoryCursor = createPublicationDirectoryCursor(directory, directoryKey);
    expect(verifyPublicationDirectoryCursor(directoryCursor, directoryContext(directory), directoryKey))
      .toEqual({ valid: true, nextPosition });
  });

  it('canonicalizes Directory filter field order while framing presence and values distinctly', () => {
    const field = fc.constantFrom(
      'tag', 'creator', 'kind', 'updatedSince', 'q',
    );
    fc.assert(fc.property(field, boundedText(), boundedText(), (selected, value, otherValue) => {
      fc.pre(value !== otherValue);
      const entries = [
        ['tag', 'tag-value'],
        ['creator', 'creator-value'],
        ['kind', 'kind-value'],
        ['updatedSince', '2026-07-18T00:00:00Z'],
        ['q', 'query-value'],
      ] as const;
      const forward = Object.fromEntries(entries) as PublicationDirectoryCursorFilter;
      const reversed = Object.fromEntries([...entries].reverse()) as PublicationDirectoryCursorFilter;
      expect(createPublicationDirectoryFilterDigest(reversed))
        .toBe(createPublicationDirectoryFilterDigest(forward));

      const absent = { ...forward } as Record<string, string | undefined>;
      delete absent[selected];
      const present = { ...absent, [selected]: value };
      const changed = { ...absent, [selected]: otherValue };
      expect(createPublicationDirectoryFilterDigest(present)).not.toBe(
        createPublicationDirectoryFilterDigest(absent),
      );
      expect(createPublicationDirectoryFilterDigest(present)).not.toBe(
        createPublicationDirectoryFilterDigest(changed),
      );
    }), options());
  });

  it('round-trips valid Snapshot query DTOs without changing repeated include order', () => {
    const query = fc.record({
      root: fc.option(opaqueText, { nil: undefined }),
      depth: fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
      include: fc.option(fc.uniqueArray(fc.constantFrom(...includeValues), {
        minLength: 1,
        maxLength: includeValues.length,
      }), { nil: undefined }),
      limit: fc.option(fc.integer({ min: 1, max: 500 }), { nil: undefined }),
      pageCursor: fc.option(opaqueText, { nil: undefined }),
    });
    fc.assert(fc.property(query, fc.array(fc.nat(), { minLength: 5, maxLength: 5 }), (input, order) => {
      const normalized = Object.fromEntries(
        Object.entries(input).filter((entry) => entry[1] !== undefined),
      );
      const reordered = Object.fromEntries(Object.entries(normalized).sort(
        ([left], [right]) => (order[['root', 'depth', 'include', 'limit', 'pageCursor'].indexOf(left)] ?? 0)
          - (order[['root', 'depth', 'include', 'limit', 'pageCursor'].indexOf(right)] ?? 0),
      ));
      const baseline = preparePublicationQuery(
        'snapshot',
        'https://publication.example/snapshot',
        normalized,
        validators,
      );
      const encoded = preparePublicationQuery(
        'snapshot',
        'https://publication.example/snapshot',
        reordered,
        validators,
      );
      expect(encoded.search).toBe(baseline.search);
      const decoded = decodePublicationQuery('snapshot', encoded.search, validators);
      expect(decoded.valid).toBe(true);
      if (decoded.valid) expect(decoded.value).toEqual(normalized);
    }), options());
  });

  it('round-trips valid Directory query DTOs with canonical ordering independent of insertion order', () => {
    const query = fc.record({
      cursor: fc.option(opaqueText, { nil: undefined }),
      limit: fc.option(fc.integer({ min: 1, max: 500 }), { nil: undefined }),
      tag: fc.option(boundedText(6), { nil: undefined }),
      creator: fc.option(boundedText(6), { nil: undefined }),
      kind: fc.option(fc.constantFrom('bookmarks', 'reading_path', 'knowledge_collection', 'mixed'), { nil: undefined }),
      updatedSince: fc.option(fc.constantFrom('2026-07-18T00:00:00Z', '2025-01-01T12:34:56.789Z'), { nil: undefined }),
      q: fc.option(boundedText(6), { nil: undefined }),
    });
    fc.assert(fc.property(query, (input) => {
      const normalized = Object.fromEntries(
        Object.entries(input).filter((entry) => entry[1] !== undefined),
      );
      const reversed = Object.fromEntries(Object.entries(normalized).reverse());
      const baseline = preparePublicationQuery(
        'directory', 'https://publication.example/directory', normalized, validators,
      );
      const encoded = preparePublicationQuery(
        'directory', 'https://publication.example/directory', reversed, validators,
      );
      expect(encoded.search).toBe(baseline.search);
      const decoded = decodePublicationQuery('directory', encoded.search, validators);
      expect(decoded.valid).toBe(true);
      if (decoded.valid) expect(decoded.value).toEqual(normalized);
    }), options());
  });

  it('rejects duplicate scalars, unknown parameters, and empty known values at the server boundary', () => {
    const invalidSearch = fc.oneof(
      fc.constantFrom(
        ['directory', '?limit=1&limit=2'],
        ['directory', '?cursor=page_1&cursor=page_2'],
        ['directory', '?q=first&q=second'],
        ['snapshot', '?depth=1&depth=2'],
        ['snapshot', '?root=node_1&root=node_2'],
        ['snapshot', '?pageCursor=page_1&pageCursor=page_2'],
      ),
      fc.tuple(
        fc.constantFrom('directory', 'snapshot', 'node'),
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,11}$/u),
      ).filter(([, name]) => ![
        'cursor', 'limit', 'tag', 'creator', 'kind', 'updatedSince', 'q',
        'pageCursor', 'include', 'depth', 'root',
      ].includes(name)).map(([endpoint, name]) => [endpoint, `?${name}=value`] as const),
      fc.constantFrom(
        ['directory', '?cursor='],
        ['directory', '?tag='],
        ['directory', '?creator='],
        ['directory', '?q='],
        ['snapshot', '?pageCursor='],
        ['snapshot', '?include='],
        ['snapshot', '?root='],
        ['node', '?include='],
      ),
    );
    fc.assert(fc.property(invalidSearch, ([endpoint, search]) => {
      expect(decodePublicationQuery(endpoint, search, validators)).toMatchObject({
        valid: false,
        status: 400,
        code: 'invalid_query',
      });
    }), options());
  });

  it('rejects duplicate include parameters instead of silently treating them as a set', () => {
    fc.assert(fc.property(fc.constantFrom(...includeValues), (include) => {
      const prepared = () => preparePublicationQuery(
        'snapshot',
        'https://publication.example/snapshot',
        { include: [include, include] },
        validators,
      );
      expect(prepared).toThrow(/invalid_query/u);
      expect(decodePublicationQuery(
        'snapshot',
        `?include=${include}&include=${include}`,
        validators,
      )).toMatchObject({ valid: false, code: 'invalid_query' });
    }), options(12));
  });

  it('canonicalizes ETag JSON key order and Snapshot include set order', () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.constantFrom(...includeValues), { minLength: 1, maxLength: 3 }),
      fc.integer({ min: 0, max: 64 }),
      fc.integer({ min: 1, max: 500 }),
      (include, depth, limit) => {
        const baseline: PublicationRepresentationEtagInput = {
          representation: '{"nodes":[]}',
          revision: 'revision-1',
          projectionKey: 'publication:public',
          queryContract: 'snapshotQuery',
          query: { root: 'root-1', depth, include, limit },
          negotiatedMediaType: 'application/json',
          protocolVersion: '0.1',
          pageIdentity: { pageNumber: 1 },
        };
        const reordered = {
          limit,
          include: [...include].reverse(),
          depth,
          root: 'root-1',
        };
        const duplicated = { ...reordered, include: [...reordered.include, reordered.include[0] as string] };
        const expected = createPublicationRepresentationEtag(baseline);
        expect(createPublicationRepresentationEtag({ ...baseline, query: reordered })).toBe(expected);
        expect(createPublicationRepresentationEtag({ ...baseline, query: duplicated })).toBe(expected);
      },
    ), options());
  });

  it('changes ETags when projection, media, page, principal, or query selection changes', () => {
    fc.assert(fc.property(boundedText(), fc.integer({ min: 1, max: 500 }), (principal, limit) => {
      const baseline: PublicationRepresentationEtagInput = {
        representation: '{"nodes":[]}',
        revision: 'revision-1',
        projectionKey: 'publication:public',
        queryContract: 'snapshotQuery',
        query: { include: ['annotations'], limit },
        negotiatedMediaType: 'application/json',
        protocolVersion: '0.1',
        pageIdentity: { pageNumber: 1 },
        principalScope: principal,
      };
      const tag = createPublicationRepresentationEtag(baseline);
      const variants: PublicationRepresentationEtagInput[] = [
        { ...baseline, representation: '{"nodes":[{}]}' },
        { ...baseline, projectionKey: 'publication:private' },
        { ...baseline, negotiatedMediaType: 'application/vnd.collection+json' },
        { ...baseline, protocolVersion: '0.2' },
        { ...baseline, pageIdentity: { pageNumber: 2 } },
        { ...baseline, principalScope: changedText(principal) },
        { ...baseline, query: { include: ['annotations'], limit: limit + 1 } },
        { ...baseline, query: { include: ['attachments'], limit } },
        { ...baseline, query: { include: ['annotations'], limit, root: 'root-1' } },
        { ...baseline, query: { include: ['annotations'], limit, depth: 0 } },
        { ...baseline, query: { include: ['annotations'], limit, pageCursor: 'page-2' } },
      ];
      for (const variant of variants) {
        expect(createPublicationRepresentationEtag(variant)).not.toBe(tag);
      }
    }), options());
  });
});
