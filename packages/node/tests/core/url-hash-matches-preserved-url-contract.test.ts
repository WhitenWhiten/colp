import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createUrlHash,
  urlHashMatches,
  validateNodeCreateRequestUrlHashSemantics,
  validateNodeCreateUrlHashSemantics,
  validateNodeMergePatchUrlHashSemantics,
  validateNodeUrlHashSemantics,
} from '../../src/semantic/index.js';
import * as adapterExports from '../../src/adapters/index.js';
import {
  createValidatorRegistry,
  validateWireDocument,
} from '../../src/schema/index.js';
import * as serverExports from '../../src/server/index.js';
import { validateSnapshotSemantics } from '../../src/semantic/index.js';
import type {
  CreateNodeOperationPayload,
  Node,
  NodeCreate,
  NodeMergePatch,
  Snapshot,
} from '../../src/types/index.js';

const evidence = '[evidence:core.url-hash-matches-preserved-url]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();

type JsonRecord = Record<string, any>;

function fixture(name = 'sync-snapshot.json'): JsonRecord {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonRecord;
}

function bookmark(snapshot: JsonRecord): JsonRecord {
  return snapshot.nodes.find((node: JsonRecord) => node.kind === 'bookmark') as JsonRecord;
}

function bookmarkIndex(snapshot: JsonRecord): number {
  return snapshot.nodes.findIndex((node: JsonRecord) => node.kind === 'bookmark');
}

function flipOneDigestBit(urlHash: string): string {
  const encoded = urlHash.slice('sha-256=:'.length, -1);
  const digest = Buffer.from(encoded, 'base64');
  digest[0] = (digest[0] ?? 0) ^ 0x01;
  return `sha-256=:${digest.toString('base64')}:`;
}

describe(`CORE-0041 URL hash matches the same preserved Bookmark URL ${evidence}`, () => {
  it('accepts an authoritative Snapshot when urlHash is absent', () => {
    const snapshot = fixture();
    delete bookmark(snapshot).urlHash;

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(snapshot as Snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('accepts an authoritative Snapshot when urlHash matches its Bookmark URL', () => {
    const snapshot = fixture();
    const node = bookmark(snapshot);
    node.urlHash = createUrlHash(node.url);

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(snapshot as Snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('validates a complete Node through structural validation before same-object semantics', () => {
    const snapshot = fixture();
    const node = bookmark(snapshot);
    node.urlHash = createUrlHash(node.url);

    expect(validateWireDocument(
      validators,
      'node',
      node,
      (value: Node) => validateNodeUrlHashSemantics(value),
    )).toEqual({ valid: true, value: node });

    node.urlHash = createUrlHash(`${node.url}#other`);
    expect(validateWireDocument(
      validators,
      'node',
      node,
      (value: Node) => validateNodeUrlHashSemantics(value),
    )).toEqual({
      valid: false,
      stage: 'semantic',
      issues: [expect.objectContaining({ code: 'url_hash_mismatch', path: '/urlHash' })],
    });
  });

  it('rejects a one-bit digest mismatch that still has valid wire syntax', () => {
    const snapshot = fixture();
    const index = bookmarkIndex(snapshot);
    const node = snapshot.nodes[index] as JsonRecord;
    node.urlHash = flipOneDigestBit(createUrlHash(node.url));

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(snapshot as Snapshot)).toEqual({
      valid: false,
      issues: [expect.objectContaining({
        code: 'url_hash_mismatch',
        path: `/nodes/${index}/urlHash`,
      })],
    });
  });

  it.each([
    [
      'WHATWG-normalized spelling',
      'HTTP://EXAMPLE.COM:80/%7Ealice?b=2&a=1#Keep',
      'http://example.com/%7Ealice?b=2&a=1#Keep',
    ],
    [
      'canonicalUrl',
      'https://origin.example.test/article?edition=raw#saved',
      'https://canonical.example.test/article',
    ],
    [
      'another Bookmark URL',
      'https://first.example.test/saved',
      'https://second.example.test/saved',
    ],
  ] as const)('rejects a hash computed from %s instead of the preserved url', (
    _source,
    preservedUrl,
    wrongInput,
  ) => {
    const snapshot = fixture();
    const index = bookmarkIndex(snapshot);
    const node = snapshot.nodes[index] as JsonRecord;
    node.url = preservedUrl;
    node.canonicalUrl = wrongInput;
    node.urlHash = createUrlHash(wrongInput);

    const result = validateSnapshotSemantics(snapshot as Snapshot);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'url_hash_mismatch',
      path: `/nodes/${index}/urlHash`,
    }));
  });

  it.each([
    ['scheme and host case', 'HTTPS://EXAMPLE.TEST/path', 'https://example.test/path'],
    ['query order', 'https://example.test/?a=1&b=2', 'https://example.test/?b=2&a=1'],
    ['query value case', 'https://example.test/?token=AbC', 'https://example.test/?token=abc'],
    ['fragment case', 'https://example.test/path#Keep', 'https://example.test/path#keep'],
    ['fragment presence', 'https://example.test/path#kept', 'https://example.test/path'],
  ] as const)('is sensitive to exact %s spelling', (_case, preserved, alternative) => {
    const hash = createUrlHash(preserved);

    expect(urlHashMatches(preserved, hash)).toBe(true);
    expect(urlHashMatches(alternative, hash)).toBe(false);
  });

  it('checks each Bookmark against its own URL rather than another object URL', () => {
    const snapshot = fixture();
    const firstIndex = bookmarkIndex(snapshot);
    const first = snapshot.nodes[firstIndex] as JsonRecord;
    first.url = 'https://first.example.test/saved';
    first.urlHash = createUrlHash(first.url);
    snapshot.nodes.push({
      ...first,
      id: 'distinct-bookmark',
      position: 'B0',
      url: 'https://second.example.test/saved',
      urlHash: first.urlHash,
    });

    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    const result = validateSnapshotSemantics(snapshot as Snapshot);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'url_hash_mismatch',
      path: `/nodes/${snapshot.nodes.length - 1}/urlHash`,
    }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      code: 'url_hash_mismatch',
      path: `/nodes/${firstIndex}/urlHash`,
    }));
  });

  it.each([
    ['truncated digest', 'sha-256=:AAAA=:'],
    ['unpadded digest', `sha-256=:${'A'.repeat(43)}:`],
    ['URL-safe alphabet', `sha-256=:${'_'.repeat(43)}=:`],
  ] as const)('rejects malformed %s structurally before Snapshot semantics', (_case, urlHash) => {
    const snapshot = fixture();
    const index = bookmarkIndex(snapshot);
    snapshot.nodes[index].urlHash = urlHash;

    const result = validateWireDocument(
      validators,
      'snapshot',
      snapshot as Snapshot,
      (value) => validateSnapshotSemantics(value as Snapshot),
    );
    expect(result.valid).toBe(false);
    if (result.valid || result.stage !== 'structural') return;
    expect(result.errors).toContainEqual(expect.objectContaining({
      instancePath: `/nodes/${index}/urlHash`,
    }));
  });

  it('accepts an exact 4096-character preserved URL and its matching digest', () => {
    const snapshot = fixture();
    const node = bookmark(snapshot);
    const prefix = 'https://example.test/bookmark?opaque=';
    node.url = `${prefix}${'x'.repeat(4096 - prefix.length)}`;
    node.urlHash = createUrlHash(node.url);

    expect(node.url).toHaveLength(4096);
    expect(validators.validate('snapshot', snapshot)).toEqual({ valid: true, errors: [] });
    expect(validateSnapshotSemantics(snapshot as Snapshot)).toEqual({ valid: true, issues: [] });
  });

  it('uses the public semantic helper to evaluate Bookmark create pairs', () => {
    const url = 'HTTPS://EXAMPLE.TEST:443/%7euser?b=2&a=1#Keep';
    const matching = { kind: 'bookmark', title: 'Matching', url, urlHash: createUrlHash(url) };
    const absent = { kind: 'bookmark', title: 'Absent', url };
    const mismatched = {
      kind: 'bookmark',
      title: 'Mismatch',
      url,
      urlHash: createUrlHash('https://example.test/~user?a=1&b=2#Keep'),
    };

    expect(validators.validate('nodeCreate', matching)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('nodeCreate', absent)).toEqual({ valid: true, errors: [] });
    expect(validators.validate('nodeCreate', mismatched)).toEqual({ valid: true, errors: [] });
    expect(validateNodeCreateUrlHashSemantics(matching as NodeCreate)).toEqual({
      valid: true,
      issues: [],
    });
    expect(validateNodeCreateUrlHashSemantics(absent as NodeCreate)).toEqual({
      valid: true,
      issues: [],
    });
    expect(validateNodeCreateUrlHashSemantics(mismatched as NodeCreate)).toEqual({
      valid: false,
      issues: [expect.objectContaining({ code: 'url_hash_mismatch', path: '/urlHash' })],
    });
  });

  it('validates a nested create request and reports its nested JSON Pointer', () => {
    const url = 'https://example.test/saved?opaque=AbC#Keep';
    const request = {
      parentId: 'root-node',
      node: {
        kind: 'bookmark',
        title: 'Nested',
        url,
        urlHash: createUrlHash(`${url}#other`),
      },
    };

    expect(validators.validate('createNodeOperationPayload', request)).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateNodeCreateRequestUrlHashSemantics(
      request as CreateNodeOperationPayload,
    )).toEqual({
      valid: false,
      issues: [expect.objectContaining({
        code: 'url_hash_mismatch',
        path: '/node/urlHash',
      })],
    });
  });

  it('rejects malformed Bookmark create hashes structurally', () => {
    const value = {
      kind: 'bookmark',
      title: 'Malformed',
      url: 'https://example.test/saved',
      urlHash: 'sha-256=:AAAA=:',
    };

    const result = validators.validate('nodeCreate', value);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toContainEqual(expect.objectContaining({ instancePath: '/urlHash' }));
  });

  it.each([
    ['node', () => {
      const node = bookmark(fixture());
      node.urlHash = 'sha-256=:AAAA=:';
      return node;
    }],
    ['createNodeOperationPayload', () => ({
      parentId: 'root-node',
      node: {
        kind: 'bookmark',
        title: 'Malformed nested create',
        url: 'https://example.test/saved',
        urlHash: 'sha-256=:AAAA=:',
      },
    })],
    ['nodeMergePatch', () => ({ urlHash: 'sha-256=:AAAA=:' })],
  ] as const)('rejects malformed hashes in %s before invoking semantics', (definition, value) => {
    let semanticCalls = 0;
    const result = validateWireDocument(
      validators,
      definition,
      value(),
      () => {
        semanticCalls += 1;
        return { valid: true as const, issues: [] as const };
      },
    );

    expect(result.valid).toBe(false);
    if (result.valid || result.stage !== 'structural') return;
    expect(semanticCalls).toBe(0);
    expect(result.errors).toContainEqual(expect.objectContaining({
      instancePath: expect.stringMatching(/\/urlHash$/u),
    }));
  });

  it.each([
    ['url alone', { url: 'https://changed.example.test/' }, false],
    ['hash alone', { urlHash: createUrlHash('https://changed.example.test/') }, false],
    [
      'url and matching hash together',
      {
        url: 'https://changed.example.test/',
        urlHash: createUrlHash('https://changed.example.test/'),
      },
      true,
    ],
    ['url with hash removal', { url: 'https://changed.example.test/', urlHash: null }, true],
  ] as const)('evaluates a public %s patch against the resulting Bookmark', (
    _case,
    patch,
    expected,
  ) => {
    const snapshot = fixture();
    const current = bookmark(snapshot);
    current.url = 'https://original.example.test/';
    current.urlHash = createUrlHash(current.url);

    expect(validators.validate('nodeMergePatch', patch)).toEqual({ valid: true, errors: [] });
    const result = validateNodeMergePatchUrlHashSemantics(
      current as Node,
      patch as NodeMergePatch,
    );
    expect(result.valid).toBe(expected);
    if (!expected && !result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'url_hash_mismatch', path: '/urlHash' }),
      ]);
    }
  });

  it('treats explicit undefined as preservation and null as removal in patch semantics', () => {
    const current = bookmark(fixture());
    current.url = 'https://original.example.test/path';
    current.urlHash = createUrlHash(current.url);

    expect(validateNodeMergePatchUrlHashSemantics(
      current as Node,
      { url: undefined, urlHash: undefined } as unknown as NodeMergePatch,
    )).toEqual({ valid: true, issues: [] });
    expect(validateNodeMergePatchUrlHashSemantics(
      current as Node,
      { urlHash: null } as NodeMergePatch,
    )).toEqual({ valid: true, issues: [] });
  });

  it('exposes the same validators from server and adapter integration boundaries', () => {
    expect(serverExports.validateNodeCreateRequestUrlHashSemantics)
      .toBe(validateNodeCreateRequestUrlHashSemantics);
    expect(serverExports.validateNodeMergePatchUrlHashSemantics)
      .toBe(validateNodeMergePatchUrlHashSemantics);
    expect(adapterExports.validateNodeCreateRequestUrlHashSemantics)
      .toBe(validateNodeCreateRequestUrlHashSemantics);
    expect(adapterExports.validateNodeMergePatchUrlHashSemantics)
      .toBe(validateNodeMergePatchUrlHashSemantics);
  });

  it('does not mutate complete, create, nested request, or patch inputs', () => {
    const complete = bookmark(fixture());
    complete.urlHash = createUrlHash(complete.url);
    const create = {
      kind: 'bookmark',
      title: 'Create',
      url: complete.url,
      urlHash: complete.urlHash,
    } as NodeCreate;
    const request = { parentId: 'root-node', node: create } as CreateNodeOperationPayload;
    const patch = { url: complete.url, urlHash: complete.urlHash } as NodeMergePatch;
    const before = structuredClone({ complete, create, request, patch });

    validateNodeUrlHashSemantics(complete as Node);
    validateNodeCreateUrlHashSemantics(create);
    validateNodeCreateRequestUrlHashSemantics(request);
    validateNodeMergePatchUrlHashSemantics(complete as Node, patch);

    expect({ complete, create, request, patch }).toEqual(before);
  });

  it('does not treat a digest of a UTF-8 prefix as a match for the full preserved URL', () => {
    const prefix = 'https://example.test/path?opaque=';
    const suffix = 'signed-fragment#Keep';
    const full = `${prefix}${suffix}`;
    const independentlyHashedPrefix = `sha-256=:${createHash('sha256')
      .update(prefix, 'utf8')
      .digest('base64')}:`;

    expect(urlHashMatches(full, independentlyHashedPrefix)).toBe(false);
    expect(urlHashMatches(full, createUrlHash(full))).toBe(true);
  });
});
