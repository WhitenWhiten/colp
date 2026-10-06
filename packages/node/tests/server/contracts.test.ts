import { describe, expect, it } from 'vitest';

import { createCanonicalRequestDigest } from '../../src/publisher/index.js';
import { createValidatorRegistry, parseIJson } from '../../src/schema/index.js';
import { getProblemDefinition, parseProtocolQuery } from '../../src/server/index.js';

describe('I-JSON parsing', () => {
  it('rejects duplicate members, unsafe integers, and prototype keys', () => {
    expect(() => parseIJson('{"a":1,"a":2}')).toThrow();
    expect(() => parseIJson('{"value":9007199254740992}')).toThrow();
    expect(() => parseIJson('{"__proto__":{"polluted":true}}')).toThrow();
    expect(() => parseIJson('{"value":1e9999}')).toThrow();
  });

  it('parses interoperable JSON numbers', () => {
    expect(parseIJson('{"integer":42,"fraction":0.5,"array":[1]}')).toEqual({ integer: 42, fraction: 0.5, array: [1] });
  });
});

describe('query codecs', () => {
  const validators = createValidatorRegistry();

  it('decodes distinct repeated arrays in their original order and typed scalars', () => {
    const query = new URLSearchParams('include=annotations&include=attachments&limit=20&depth=2');
    expect(parseProtocolQuery('snapshotQuery', query, validators)).toEqual({
      valid: true,
      value: { include: ['annotations', 'attachments'], limit: 20, depth: 2 },
    });
  });

  it('rejects duplicate array values instead of normalizing them', () => {
    expect(
      parseProtocolQuery(
        'snapshotQuery',
        new URLSearchParams('include=annotations&include=annotations'),
        validators,
      ),
    ).toMatchObject({ valid: false, code: 'invalid_query' });
  });

  it.each([
    ['snapshotQuery', new URLSearchParams('limit=1&limit=2')],
    ['snapshotQuery', new URLSearchParams('unknown=value')],
    ['nodeDeleteQuery', new URLSearchParams('recursive=yes')],
    ['snapshotQuery', new URLSearchParams('include=annotations,attachments')],
  ] as const)('rejects ambiguous or unknown input for %s', (contractName, query) => {
    expect(parseProtocolQuery(contractName, query, validators)).toMatchObject({
      valid: false,
      code: 'invalid_query',
    });
  });

  it('decodes boolean values and rejects unsafe integers', () => {
    expect(parseProtocolQuery('nodeDeleteQuery', new URLSearchParams('recursive=true'), validators)).toEqual({
      valid: true,
      value: { recursive: true },
    });
    expect(
      parseProtocolQuery('snapshotQuery', new URLSearchParams('limit=9007199254740992'), validators).valid,
    ).toBe(false);
  });
});

describe('canonical request digests and problems', () => {
  it('canonicalizes JSON member order', () => {
    const left = createCanonicalRequestDigest({
      protocolVersion: '0.1',
      endpointKey: 'nodes',
      resourceIdentity: 'collection-1',
      method: 'post',
      query: {},
      mediaType: 'Application/JSON; Charset=UTF-8',
      body: { title: 'Example', tags: ['a', 'b'] },
    });
    const right = createCanonicalRequestDigest({
      protocolVersion: '0.1',
      endpointKey: 'nodes',
      resourceIdentity: 'collection-1',
      method: 'POST',
      query: {},
      mediaType: 'application/json;charset=utf-8',
      body: { tags: ['a', 'b'], title: 'Example' },
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^sha-256:[A-Za-z0-9_-]+$/u);
  });

  it('rejects non-JSON canonical request inputs', () => {
    expect(() =>
      createCanonicalRequestDigest({
        protocolVersion: '0.1',
        endpointKey: 'nodes',
        resourceIdentity: 'collection-1',
        method: 'POST',
        query: {},
        mediaType: 'application/json',
        body: undefined,
      }),
    ).toThrow();
  });

  it('exposes stable problem definitions', () => {
    expect(getProblemDefinition('payload_too_large')).toEqual({ status: 413, retryable: false });
    expect(getProblemDefinition('service_unavailable')).toEqual({ status: 503, retryable: true });
  });
});
