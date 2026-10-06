import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  areUrlHashDeduplicationCandidates,
  createUrlHash,
  isUrlHash,
  urlHashMatches,
} from '../../src/semantic/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  validateWireDocument,
  type DefinitionName,
} from '../../src/schema/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import { UuidV7Generator } from '../../src/server/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:core.url-hash-dedup-hint]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();
const zeroDigest = `sha-256=:${'A'.repeat(43)}=:`;

type JsonRecord = Record<string, any>;

function fixture(name: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonRecord;
}

function expectedUrlHash(url: string): string {
  return `sha-256=:${createHash('sha256').update(url, 'utf8').digest('base64')}:`;
}

function bookmarkNode(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'bookmark-1',
    collectionId: 'collection-1',
    kind: 'bookmark',
    parentId: 'root-1',
    position: 'a',
    title: 'Example',
    url: 'https://example.com/saved?b=2&a=1#kept',
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    revision: 'revision-1',
    ...overrides,
  };
}

function expectInvalid(definition: DefinitionName, value: unknown, path: string): void {
  const result = validators.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ instancePath: path })]),
  );
}

describe(`CORE-0020 URL hash carrier ${evidence}`, () => {
  it('defines the optional SHA-256 digest hint with the protocol digest grammar', () => {
    expect(collectionProtocolSchema.$defs.urlHash).toMatchObject({
      type: 'string',
      pattern: '^sha-256=:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=:$',
      minLength: 54,
      maxLength: 54,
    });
    expect(validators.validate('urlHash', zeroDigest)).toEqual({ valid: true, errors: [] });
    expect(isUrlHash(zeroDigest)).toBe(true);
  });

  it.each([
    '',
    'sha-256=:AAAA:',
    `sha256=:${'A'.repeat(43)}=:`,
    `SHA-256=:${'A'.repeat(43)}=:`,
    `sha-256:${'A'.repeat(43)}=`,
    `sha-256=:${'A'.repeat(42)}==:`,
    `sha-256=:${'A'.repeat(43)}:`,
    `sha-256=:${'_'.repeat(43)}=:`,
    `sha-256=:${'A'.repeat(44)}=:`,
    `sha-256=:${'A'.repeat(42)}B=:`,
  ])('rejects malformed or non-protocol hash syntax %j', (value) => {
    expect(validators.validate('urlHash', value).valid).toBe(false);
    expect(isUrlHash(value)).toBe(false);
  });

  it.each([
    ['node', bookmarkNode({ urlHash: zeroDigest })],
    [
      'nodeCreate',
      {
        kind: 'bookmark',
        title: 'Example',
        url: 'https://example.com/saved',
        urlHash: zeroDigest,
      },
    ],
    ['nodeMergePatch', { urlHash: zeroDigest }],
    ['nodeMergePatch', { urlHash: null }],
  ] as const)('carries an optional hint through the %s Bookmark shape', (definition, value) => {
    expect(validators.validate(definition, value)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['node', bookmarkNode()],
    ['nodeCreate', { kind: 'bookmark', title: 'Example', url: 'https://example.com/' }],
    ['nodeMergePatch', { title: 'Still optional' }],
  ] as const)('does not require a URL hash on %s', (definition, value) => {
    expect(validators.validate(definition, value)).toEqual({ valid: true, errors: [] });
  });

  it('limits the hint to URL-bearing Bookmark representations', () => {
    expectInvalid(
      'nodeCreate',
      { kind: 'folder', title: 'Folder', urlHash: zeroDigest },
      '',
    );
    const redacted = bookmarkNode({
      redacted: true,
      visibility: 'private',
      urlHash: zeroDigest,
    });
    delete redacted.url;
    expectInvalid('node', redacted, '');
  });
});

describe(`CORE-0020 exact-input hash behavior ${evidence}`, () => {
  it.each([
    '',
    'https://example.com/path',
    'HTTP://EXAMPLE.COM:80/path',
    'https://example.com/%7Euser?q=%2F#section',
    'https://example.com/\u7528\u6237?\u952e=\u503c',
  ])('hashes the exact UTF-8 URL deterministically for %j', (url) => {
    expect(createUrlHash(url)).toBe(expectedUrlHash(url));
    expect(createUrlHash(url)).toBe(createUrlHash(url));
    expect(validators.validate('urlHash', createUrlHash(url))).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('hashes large URL strings without truncating their UTF-8 input', () => {
    const url = `https://example.com/${'a'.repeat(1_000_000)}\u7528\u6237`;
    expect(createUrlHash(url)).toBe(expectedUrlHash(url));
  });

  it('rejects non-string crypto inputs instead of coercing them', () => {
    expect(() => createUrlHash(new Uint8Array([0x61]) as unknown as string)).toThrow(TypeError);
  });

  it.each([
    ['HTTP://EXAMPLE.COM:80/path', 'http://example.com/path', 'scheme/host/default-port spelling'],
    ['https://example.com/path#one', 'https://example.com/path#two', 'fragment'],
    ['https://example.com/?a=1&b=2', 'https://example.com/?b=2&a=1', 'query order'],
    ['https://example.com/?utm_source=a', 'https://example.com/', 'tracking parameter'],
    ['https://example.com/?token=one', 'https://example.com/?token=two', 'signed or temporary value'],
  ])('does not apply an unnamed %s normalization rule', (left, right) => {
    expect(createUrlHash(left)).not.toBe(createUrlHash(right));
  });

  it('preserves the original URL bytes when a hash hint is present', () => {
    const url = 'HTTP://EXAMPLE.COM:80/%7Ealice?b=2&a=1#keep';
    const value = bookmarkNode({ url, urlHash: createUrlHash(url) });
    const result = validateWireDocument(
      validators,
      'node',
      value,
      () => ({ valid: true as const, issues: [] as const }),
    );

    expect(result).toEqual({ valid: true, value });
    if (result.valid) expect((result.value as JsonRecord).url).toBe(url);
  });

  it('matches only the exact preserved URL and rejects invalid claimed hashes', () => {
    const preserved = 'HTTP://EXAMPLE.COM:80/path#kept';
    const urlHash = createUrlHash(preserved);

    expect(urlHashMatches(preserved, urlHash)).toBe(true);
    expect(urlHashMatches('http://example.com/path#kept', urlHash)).toBe(false);
    expect(urlHashMatches(preserved, 'not-a-url-hash')).toBe(false);
  });

  it('rejects a syntactically valid but mismatched hash during Snapshot semantic validation', () => {
    const snapshot = fixture('sync-snapshot.json');
    const bookmarkIndex = snapshot.nodes.findIndex((node: JsonRecord) => node.kind === 'bookmark');
    const bookmark = snapshot.nodes[bookmarkIndex] as JsonRecord;
    bookmark.urlHash = createUrlHash(`${bookmark.url}#different-input`);

    const result = validateSnapshotSemantics(snapshot as Snapshot);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'url_hash_mismatch',
        path: `/nodes/${bookmarkIndex}/urlHash`,
      }),
    );
  });
});

describe(`CORE-0020 deduplication is not identity ${evidence}`, () => {
  it('allows equal hints on distinct URLs and independently identified objects', () => {
    const snapshot = fixture('sync-snapshot.json');
    const first = snapshot.nodes.find((node: JsonRecord) => node.kind === 'bookmark') as JsonRecord;
    first.urlHash = zeroDigest;
    snapshot.nodes.push({
      ...first,
      id: 'distinct-bookmark-id',
      position: `${first.position}z`,
      url: 'https://different.example/not-proof-of-duplicate',
      urlHash: zeroDigest,
    });

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(first.id).not.toBe(snapshot.nodes.at(-1).id);
    expect(first.url).not.toBe(snapshot.nodes.at(-1).url);
    expect(first.urlHash).toBe(snapshot.nodes.at(-1).urlHash);
    expect(areUrlHashDeduplicationCandidates(first.urlHash, snapshot.nodes.at(-1).urlHash)).toBe(
      true,
    );
  });

  it('treats equality only as a candidate signal and rejects absent or malformed hints', () => {
    const left = createUrlHash('https://first.example/');
    const right = createUrlHash('https://second.example/');

    expect(areUrlHashDeduplicationCandidates(left, left)).toBe(true);
    expect(areUrlHashDeduplicationCandidates(left, right)).toBe(false);
    expect(areUrlHashDeduplicationCandidates(left, undefined)).toBe(false);
    expect(areUrlHashDeduplicationCandidates(left, 'not-a-url-hash')).toBe(false);
  });

  it('does not validate a URL hash as an opaque object ID or substitute it for a missing ID', () => {
    expect(validators.validate('opaqueId', zeroDigest).valid).toBe(false);
    expectInvalid('node', bookmarkNode({ id: zeroDigest, urlHash: zeroDigest }), '/id');

    const withoutId = bookmarkNode({ urlHash: zeroDigest });
    delete withoutId.id;
    expectInvalid('node', withoutId, '');
  });

  it('rejects URL hashes from collection and Node-reference ID fields', () => {
    expectInvalid('node', bookmarkNode({ collectionId: zeroDigest }), '/collectionId');
    expectInvalid('node', {
      id: 'alias-1',
      collectionId: 'collection-1',
      kind: 'alias',
      parentId: 'root-1',
      position: 'b',
      title: 'Alias',
      targetNodeId: zeroDigest,
      createdAt: '2026-07-17T00:00:00Z',
      updatedAt: '2026-07-17T00:00:00Z',
      revision: 'revision-1',
    }, '/targetNodeId');
  });

  it('allocates object IDs solely through the ID generator, independently of URL hashes', () => {
    const options = {
      clock: { now: () => new Date(1_721_234_567_890) },
      randomBytes: (length: number) => new Uint8Array(length).fill(0x5a),
    } as const;
    const firstGenerator = new UuidV7Generator(options);
    const secondGenerator = new UuidV7Generator(options);
    const urlHash = createUrlHash('https://example.com/saved');
    const otherUrlHash = createUrlHash('https://different.example/saved');
    const id = firstGenerator.uuidV7();
    const idWithDifferentHashNearby = secondGenerator.uuidV7();

    expect(urlHash).not.toBe(otherUrlHash);
    expect(idWithDifferentHashNearby).toBe(id);
    expect(id).not.toBe(urlHash);
    expect(validators.validate('opaqueId', id)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('urlHash', id).valid).toBe(false);
    expect(validators.validate('node', bookmarkNode({ id, urlHash })).valid).toBe(true);
  });
});
