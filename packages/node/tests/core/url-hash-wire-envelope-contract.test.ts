import { describe, expect, it } from 'vitest';

import { createUrlHash, isUrlHash } from '../../src/semantic/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  type DefinitionName,
} from '../../src/schema/index.js';

const evidence = '[evidence:core.url-hash-wire-envelope]';
const validators = createValidatorRegistry();
const bookmarkUrl = 'https://example.test/saved?order=wire#kept';
const generatedUrlHash = createUrlHash(bookmarkUrl);
const base64Payload = generatedUrlHash.slice('sha-256=:'.length, -1);

type JsonRecord = Record<string, unknown>;

function bookmarkNode(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'bookmark-wire-envelope',
    collectionId: 'collection-1',
    kind: 'bookmark',
    parentId: 'root-1',
    position: 'a',
    title: 'Wire envelope',
    url: bookmarkUrl,
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    revision: 'revision-1',
    ...overrides,
  };
}

function expectEnvelopeParity(value: string, valid: boolean): void {
  const schemaResult = validators.validate('urlHash', value);
  expect(schemaResult.valid).toBe(valid);
  expect(isUrlHash(value)).toBe(valid);
}

describe(`CORE-0038 URL hash wire envelope ${evidence}`, () => {
  it('exposes the exact lowercase algorithm and delimiter boundaries in the Schema', () => {
    const definition = collectionProtocolSchema.$defs.urlHash;

    expect(definition.type).toBe('string');
    expect(definition.pattern.startsWith('^sha-256=:')).toBe(true);
    expect(definition.pattern.endsWith(':$')).toBe(true);
  });

  it('returns a generated digest in the public sha-256=:<base64>: envelope', () => {
    expect(generatedUrlHash.startsWith('sha-256=:')).toBe(true);
    expect(generatedUrlHash.endsWith(':')).toBe(true);
    expect(generatedUrlHash).toBe(`sha-256=:${base64Payload}:`);
    expect(base64Payload).not.toContain(':');
    expectEnvelopeParity(generatedUrlHash, true);
    expect(validators.validate('node', bookmarkNode({ urlHash: generatedUrlHash }))).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validators.validate('nodeCreate', {
        kind: 'bookmark',
        title: 'Wire envelope',
        url: bookmarkUrl,
        urlHash: generatedUrlHash,
      }),
    ).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['uppercase algorithm', `SHA-256=:${base64Payload}:`],
    ['mixed-case algorithm', `Sha-256=:${base64Payload}:`],
    ['wrong algorithm', `sha-512=:${base64Payload}:`],
    ['missing equals sign', `sha-256:${base64Payload}:`],
    ['missing opening colon', `sha-256=${base64Payload}:`],
    ['missing closing colon', `sha-256=:${base64Payload}`],
    ['bare Base64', base64Payload],
    ['leading whitespace', ` ${generatedUrlHash}`],
    ['trailing whitespace', `${generatedUrlHash} `],
    ['internal whitespace', `sha-256=: ${base64Payload}:`],
    ['trailing text', `${generatedUrlHash}trailer`],
  ] as const)('rejects the %s envelope in both Schema and runtime validation', (_case, value) => {
    expectEnvelopeParity(value, false);
  });

  it.each([
    ['node', bookmarkNode()],
    ['nodeCreate', { kind: 'bookmark', title: 'Wire envelope', url: bookmarkUrl }],
  ] as const)('keeps urlHash absent and optional on the %s Bookmark shape', (definition, value) => {
    expect(validators.validate(definition as DefinitionName, value)).toEqual({
      valid: true,
      errors: [],
    });
  });
});
