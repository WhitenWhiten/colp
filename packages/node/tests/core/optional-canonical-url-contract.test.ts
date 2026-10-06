import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  collectionProtocolSchema,
  createValidatorRegistry,
  isHttpUrl,
  validateWireDocument,
  type DefinitionName,
} from '../../src/schema/index.js';
import { assembleSnapshotPages, validateSnapshotSemantics } from '../../src/semantic/index.js';
import type { Snapshot } from '../../src/types/index.js';

const evidence = '[evidence:core.optional-canonical-url]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();

type JsonRecord = Record<string, any>;

function fixture(name: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonRecord;
}

function collectionCreate(canonicalUrl?: string): JsonRecord {
  return {
    kind: 'bookmarks',
    title: 'Canonical URL collection',
    visibility: 'private',
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
  };
}

function bookmarkCreate(canonicalUrl?: string): JsonRecord {
  return {
    kind: 'bookmark',
    title: 'Canonical URL bookmark',
    url: 'https://origin.example.test/items/42?signature=a%2Bb#kept',
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
  };
}

function expectCanonicalUrlError(
  definition: DefinitionName,
  value: JsonRecord,
  path = '/canonicalUrl',
): void {
  const result = validators.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ instancePath: path })]),
  );
}

describe(`CORE-0019 optional Canonical URL ${evidence}`, () => {
  it.each([
    ['Collection create', 'collectionCreate', () => collectionCreate()],
    ['Collection representation', 'collection', () => {
      const value = fixture('collection-snapshot.json').collection;
      delete value.canonicalUrl;
      return value;
    }],
    ['Bookmark create', 'nodeCreate', () => bookmarkCreate()],
    ['Bookmark representation', 'node', () => {
      const value = fixture('collection-snapshot.json').nodes[1];
      delete value.canonicalUrl;
      return value;
    }],
  ] as const)('keeps canonicalUrl optional on %s', (_label, definition, build) => {
    expect(validators.validate(definition, build())).toEqual({ valid: true, errors: [] });
  });

  it.each([
    [
      'HTTP Collection create',
      'collectionCreate',
      collectionCreate('http://example.test/collections/42'),
    ],
    ['HTTPS Collection representation', 'collection', (() => {
      const value = fixture('collection-snapshot.json').collection;
      value.canonicalUrl = 'https://example.test/collections/42?view=canonical#record';
      return value;
    })()],
    [
      'HTTP Bookmark create',
      'nodeCreate',
      bookmarkCreate('http://example.test/articles/42'),
    ],
    ['HTTPS Bookmark representation', 'node', (() => {
      const value = fixture('collection-snapshot.json').nodes[1];
      value.canonicalUrl = 'https://example.test/articles/42?edition=2#abstract';
      return value;
    })()],
  ] as const)('accepts an explicit %s', (_label, definition, value) => {
    expect(validators.validate(definition, value)).toEqual({ valid: true, errors: [] });
  });

  it('supports Canonical URL updates and explicit removal through both merge patches', () => {
    for (const definition of ['collectionMergePatch', 'nodeMergePatch'] as const) {
      expect(validators.validate(definition, {
        canonicalUrl: 'https://canonical.example.test/items/42#record',
      })).toEqual({ valid: true, errors: [] });
      expect(validators.validate(definition, { canonicalUrl: null })).toEqual({
        valid: true,
        errors: [],
      });
    }
  });

  it('carries a required HTTP Canonical URL in the publication directory projection', () => {
    const directoryCollection = fixture('collection-directory.json').collections[0];
    expect(validators.validate('directoryCollection', directoryCollection)).toEqual({
      valid: true,
      errors: [],
    });

    delete directoryCollection.canonicalUrl;
    expect(validators.validate('directoryCollection', directoryCollection).valid).toBe(false);
  });

  it.each([
    ['non-HTTP FTP URL', 'ftp://example.test/item'],
    ['local file URL', 'file:///C:/items/42.html'],
    ['opaque absolute URI', 'urn:isbn:9780141036144'],
    ['executable scheme', 'javascript:alert(1)'],
    ['relative reference', '../items/42'],
    ['credential-bearing URL', 'https://user:secret@example.test/items/42'],
    ['missing host', 'https:///items/42'],
    ['malformed IPv6 host', 'https://[::1/items/42'],
    ['space-bearing URL', 'https://example.test/items/has space'],
  ])('rejects a %s', (_label, canonicalUrl) => {
    expect(validators.validate('httpUrl', canonicalUrl).valid).toBe(false);
    expectCanonicalUrlError('collectionCreate', collectionCreate(canonicalUrl));
    expectCanonicalUrlError('nodeCreate', bookmarkCreate(canonicalUrl));
  });

  it('enforces the shared absolute URI length boundary', () => {
    const prefix = 'https://example.test/';
    const maximum = `${prefix}${'a'.repeat(4096 - prefix.length)}`;
    const tooLong = `${maximum}a`;

    expect(maximum).toHaveLength(4096);
    expect(validators.validate('httpUrl', maximum)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('nodeCreate', bookmarkCreate(maximum))).toEqual({
      valid: true,
      errors: [],
    });
    expectCanonicalUrlError('nodeCreate', bookmarkCreate(tooLong));
  });

  it.each([
    ['uppercase scheme', 'HTTPS://example.test/path', true],
    ['localhost and port', 'http://localhost:8080/path?x=1#fragment', true],
    ['IPv6 host and port', 'https://[2001:db8::1]:8443/path', true],
    ['punycode IDN host', 'https://xn--r8jz45g.xn--zckzah/path', true],
    ['query and fragment', 'https://example.test/?signed=a%2Bb&order=2#kept', true],
    ['empty fragment', 'https://example.test/#', true],
    ['raw IDN host', 'https://例え.テスト/path', false],
    ['credentials', 'https://user:pass@example.test/path', false],
    ['host whitespace', 'https://example.test /path', false],
    ['leading whitespace', ' https://example.test/path', false],
    ['tab control', 'https://example.test/\tpath', false],
    ['DEL control', 'https://example.test/\u007fpath', false],
    ['missing host', 'https:///path', false],
    ['malformed IPv6', 'https://[::1/path', false],
    ['maximum length', `https://example.test/${'a'.repeat(4096 - 21)}`, true],
    ['over maximum length', `https://example.test/${'a'.repeat(4096 - 20)}`, false],
  ])('keeps isHttpUrl in exact Schema parity for %s', (_label, value, expected) => {
    expect(validators.validate('httpUrl', value).valid).toBe(expected);
    expect(isHttpUrl(value)).toBe(expected);
  });

  it('does not add semantic false negatives for structurally valid Canonical URLs', () => {
    const snapshot = fixture('collection-snapshot.json') as unknown as Snapshot;
    const canonicalUrl = 'https://[2001:db8::1]:8443/articles/42?edition=2#abstract';
    (snapshot.collection as unknown as JsonRecord).canonicalUrl = canonicalUrl;
    (snapshot.nodes[1] as unknown as JsonRecord).canonicalUrl = canonicalUrl;

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(snapshot)).toEqual({ valid: true, issues: [] });
  });

  it.each([
    ['Collection', '/collection/canonicalUrl', (snapshot: JsonRecord) => {
      snapshot.collection.canonicalUrl = 'https://user:secret@example.test/collection';
    }],
    ['Bookmark', '/nodes/1/canonicalUrl', (snapshot: JsonRecord) => {
      snapshot.nodes[1].canonicalUrl = 'https://user:secret@example.test/bookmark';
    }],
  ] as const)('reports an invalid %s Canonical URL through direct semantic validation', (
    _carrier,
    path,
    mutate,
  ) => {
    const snapshot = fixture('collection-snapshot.json');
    mutate(snapshot);

    const result = validateSnapshotSemantics(snapshot as unknown as Snapshot);
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_canonical_url', path }),
    ]));
  });

  it('validates canonicalUrl without replacing or rewriting the original Bookmark URL', () => {
    const input = bookmarkCreate('https://origin.example.test/items/42');
    const originalUrl = input.url;
    const result = validateWireDocument<JsonRecord, never>(
      validators,
      'nodeCreate',
      input,
      () => ({ valid: true, issues: [] }),
    );

    expect(result).toEqual({ valid: true, value: input });
    if (!result.valid) return;
    expect(result.value).toBe(input);
    expect(result.value.url).toBe(originalUrl);
    expect(result.value.canonicalUrl).not.toBe(result.value.url);
  });

  it.each([
    [
      'folder',
      { kind: 'folder', title: 'Folder', canonicalUrl: 'https://example.test/folder' },
    ],
    ['separator', { kind: 'separator', canonicalUrl: 'https://example.test/separator' }],
    ['alias', {
      kind: 'alias',
      title: 'Alias',
      targetNodeId: 'bookmark-1',
      canonicalUrl: 'https://example.test/alias',
    }],
  ] as const)('forbids canonicalUrl on a %s create form', (_kind, value) => {
    expect(validators.validate('nodeCreate', value).valid).toBe(false);
  });

  it('forbids canonicalUrl on Root and redacted Bookmark representations', () => {
    const snapshot = fixture('collection-snapshot.json');
    snapshot.nodes[0].canonicalUrl = 'https://example.test/root';
    expect(validators.validate('node', snapshot.nodes[0]).valid).toBe(false);

    const redacted = snapshot.nodes[1];
    delete redacted.url;
    redacted.redacted = true;
    redacted.visibility = 'private';
    redacted.canonicalUrl = 'https://example.test/private';
    expect(validators.validate('node', redacted).valid).toBe(false);
  });

  it.each(['folder', 'separator', 'alias'] as const)(
    'forbids canonicalUrl on a full %s representation',
    (kind) => {
      const snapshot = fixture('collection-snapshot.json');
      const root = snapshot.nodes[0];
      const bookmark = snapshot.nodes[1];
      const value = {
        ...bookmark,
        kind,
      };
      delete value.url;
      delete value.canonicalUrl;
      if (kind === 'folder') {
        value.title = 'Folder';
      } else if (kind === 'separator') {
        delete value.title;
      } else {
        value.title = 'Alias';
        value.targetNodeId = root.id;
      }

      expect(validators.validate('node', value)).toEqual({ valid: true, errors: [] });
      value.canonicalUrl = 'https://example.test/not-a-bookmark';
      expect(validators.validate('node', value).valid).toBe(false);
    },
  );

  it('preserves distinct original and Canonical URLs through public Snapshot assembly', () => {
    const snapshot = fixture('collection-snapshot.json') as unknown as Snapshot;
    const bookmark = snapshot.nodes[1] as unknown as JsonRecord;
    bookmark.url = 'https://origin.example.test/items/42?signature=a%2Bb&order=1#kept';
    bookmark.canonicalUrl = 'https://canonical.example.test/articles/42';

    const result = assembleSnapshotPages([snapshot]);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    const assembled = result.snapshot.nodes[1] as unknown as JsonRecord;
    expect(assembled.url).toBe(bookmark.url);
    expect(assembled.canonicalUrl).toBe(bookmark.canonicalUrl);
    expect(assembled.canonicalUrl).not.toBe(assembled.url);
  });

  it('wires every declared canonicalUrl carrier to the HTTP URL contract', () => {
    const definitions = collectionProtocolSchema.$defs as unknown as JsonRecord;
    expect(definitions.collection.properties.canonicalUrl).toEqual({ $ref: '#/$defs/httpUrl' });
    expect(definitions.collectionCreate.properties.canonicalUrl).toEqual({
      $ref: '#/$defs/httpUrl',
    });
    expect(definitions.node.properties.canonicalUrl).toEqual({ $ref: '#/$defs/httpUrl' });
    expect(definitions.nodeCreate.properties.canonicalUrl).toEqual({
      $ref: '#/$defs/httpUrl',
    });
    expect(definitions.collectionMergePatch.properties.canonicalUrl).toEqual({
      oneOf: [{ type: 'null' }, { $ref: '#/$defs/httpUrl' }],
    });
    expect(definitions.nodeMergePatch.properties.canonicalUrl).toEqual({
      oneOf: [{ type: 'null' }, { $ref: '#/$defs/httpUrl' }],
    });
    expect(definitions.directoryCollection.properties.canonicalUrl).toEqual({
      $ref: '#/$defs/httpUrl',
    });
  });
});
