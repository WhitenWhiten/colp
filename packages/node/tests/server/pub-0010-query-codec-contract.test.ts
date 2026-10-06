import { describe, expect, it, vi } from 'vitest';

import { createValidatorRegistry, type ValidatorRegistry } from '../../src/schema/index.js';
import { endpointContracts } from '../../src/semantic/index.js';
import {
  decodePublicationQuery,
  publicationQueryLimits,
  resolvePublicationQueryContract,
  type PublicationQueryEndpoint,
} from '../../src/server/index.js';

const evidence = 'http.query-codec';

function decode(endpoint: PublicationQueryEndpoint, rawSearch: string) {
  return decodePublicationQuery(endpoint, rawSearch, createValidatorRegistry());
}

function expectInvalid(endpoint: PublicationQueryEndpoint, rawSearch: string, secret?: string): void {
  const result = decode(endpoint, rawSearch);
  expect(result).toMatchObject({ valid: false, status: 400, code: 'invalid_query' });
  expect(Object.isFrozen(result)).toBe(true);
  if (!result.valid) {
    expect(Object.isFrozen(result.errors)).toBe(true);
    if (secret !== undefined) expect(JSON.stringify(result)).not.toContain(secret);
  }
}

describe(`PUB-0010 server Publication query codec [evidence:${evidence}]`, () => {
  it.each([
    ['directory', 'directoryQuery'],
    ['collection', undefined],
    ['snapshot', 'snapshotQuery'],
    ['node', 'nodeDetailQuery'],
  ] as const)(
    'selects the %s GET contract from endpointContracts at runtime [evidence:http.query-codec]',
    (endpoint, queryName) => {
      const operation = endpointContracts[endpoint].operations.find(
        (candidate) => candidate.method === 'GET' && candidate.profile === 'publication',
      )!;
      const resolved = resolvePublicationQueryContract(endpoint);
      expect(resolved).toBe(operation);
      expect(resolved.query).toBe(queryName);
      const result = decode(endpoint, '');
      expect(result).toMatchObject({ valid: true, value: {} });
      if (result.valid) expect(result.contract).toBe(operation);
    },
  );

  it.each([
    ['high surrogate at start', '?q=\ud800value'],
    ['high surrogate in middle', '?q=va\ud800lue'],
    ['high surrogate at end', '?q=value\ud800'],
    ['low surrogate at start', '?q=\udc00value'],
    ['low surrogate in middle', '?q=va\udc00lue'],
    ['low surrogate at end', '?q=value\udc00'],
    ['malformed parameter name', '?na\ud800me=value'],
    ['malformed repeated-array value', '?include=annotations&include=\udc00'],
  ] as const)(
    'rejects literal malformed UTF-16 %s without reflection [evidence:http.query-codec]',
    (_name, rawSearch) => {
      const result = decode(rawSearch.includes('include=') ? 'snapshot' : 'directory', rawSearch);
      expect(result).toEqual({
        valid: false,
        status: 400,
        code: 'invalid_query',
        errors: ['Publication query encoding is invalid.'],
      });
      expect(JSON.stringify(result)).not.toContain('value');
    },
  );

  it('roundtrips legal supplementary characters as exact UTF-8 [evidence:http.query-codec]', () => {
    const result = decode('directory', '?q=A%F0%9F%98%80%F0%90%90%B7Z');
    expect(result).toMatchObject({ valid: true, value: { q: 'A\ud83d\ude00\ud801\udc37Z' } });
  });

  it.each([
    ['directory', '?cursor=cursor_7', { cursor: 'cursor_7' }],
    ['directory', '?limit=1', { limit: 1 }],
    ['directory', '?limit=9007199254740991', { limit: 9007199254740991 }],
    ['directory', '?tag=research', { tag: 'research' }],
    ['directory', '?creator=Alice%20Smith', { creator: 'Alice Smith' }],
    ['directory', '?kind=bookmarks', { kind: 'bookmarks' }],
    ['directory', '?kind=reading_path', { kind: 'reading_path' }],
    ['directory', '?kind=knowledge_collection', { kind: 'knowledge_collection' }],
    ['directory', '?kind=mixed', { kind: 'mixed' }],
    ['directory', '?updatedSince=2026-07-18T01%3A02%3A03Z', { updatedSince: '2026-07-18T01:02:03Z' }],
    ['directory', '?q=caf%C3%A9+notes%2Bmore%25', { q: 'caf\u00e9 notes+more%' }],
    ['snapshot', '?pageCursor=page_2', { pageCursor: 'page_2' }],
    ['snapshot', '?limit=25', { limit: 25 }],
    ['snapshot', '?depth=0', { depth: 0 }],
    ['snapshot', '?depth=37', { depth: 37 }],
    ['snapshot', '?root=root_1', { root: 'root_1' }],
    ['snapshot', '?include=annotations', { include: ['annotations'] }],
    ['snapshot', '?include=annotations&include=attachments&include=relations', { include: ['annotations', 'attachments', 'relations'] }],
    ['node', '?include=relations&include=annotations', { include: ['relations', 'annotations'] }],
  ] as const)(
    'strictly decodes legal %s raw query %s [evidence:http.query-codec]',
    (endpoint, rawSearch, expected) => {
      const result = decode(endpoint, rawSearch);
      expect(result).toMatchObject({ valid: true, value: expected });
      expect(Object.isFrozen(result)).toBe(true);
      if (result.valid) {
        expect(Object.isFrozen(result.value)).toBe(true);
        if ('include' in result.value) expect(Object.isFrozen(result.value.include)).toBe(true);
      }
    },
  );

  it('validates decoded values through the registry named $defs contract [evidence:http.query-codec]', () => {
    const canonical = createValidatorRegistry();
    const validate = vi.fn(canonical.validate.bind(canonical));
    const validators: ValidatorRegistry = {
      definitionNames: canonical.definitionNames,
      get: canonical.get.bind(canonical),
      validate,
    };
    expect(decodePublicationQuery('directory', '?limit=8', validators).valid).toBe(true);
    expect(validate).toHaveBeenCalledWith('directoryQuery', { limit: 8 });

    validate.mockClear();
    expect(decodePublicationQuery('snapshot', '?include=annotations', validators).valid).toBe(true);
    expect(validate).toHaveBeenCalledWith('snapshotQuery', { include: ['annotations'] });

    validate.mockClear();
    expect(decodePublicationQuery('node', '?include=attachments', validators).valid).toBe(true);
    expect(validate).toHaveBeenCalledWith('nodeDetailQuery', { include: ['attachments'] });
  });

  it('accepts the exact raw UTF-8 byte budget and rejects the next byte [evidence:http.query-codec]', () => {
    const exact = `?q=${'a'.repeat(publicationQueryLimits.maxRawBytes - 2)}`;
    expect(decode('directory', exact)).toMatchObject({ valid: true });
    expectInvalid('directory', `${exact}a`);
  });

  it('measures literal supplementary input by UTF-8 bytes at the raw budget [evidence:http.query-codec]', () => {
    const exact = `?q=aa${'\ud83d\ude00'.repeat(4_095)}`;
    const accepted = decode('directory', exact);
    expect(accepted).toMatchObject({ valid: true, value: { q: `aa${'\ud83d\ude00'.repeat(4_095)}` } });
    expectInvalid('directory', `${exact}a`);
  });

  it('bounds raw parameter and repeated-array counts before schema validation [evidence:http.query-codec]', () => {
    const tooManyParameters = Array.from(
      { length: publicationQueryLimits.maxParameters + 1 },
      (_, index) => `unknown${index}=value`,
    ).join('&');
    expectInvalid('directory', `?${tooManyParameters}`);

    const tooManyArrayItems = Array.from(
      { length: publicationQueryLimits.maxArrayItems + 1 },
      () => 'include=annotations',
    ).join('&');
    expectInvalid('snapshot', `?${tooManyArrayItems}`);
  });

  it.each([
    ['directory', '?unknown=value'],
    ['directory', '?%75nknown=value'],
    ['directory', '?limit=1&limit=2'],
    ['directory', '?limit=1&%6cimit=2'],
    ['directory', '?%6Cimit=1&limit=2'],
    ['directory', '?limit='],
    ['directory', '?q='],
    ['directory', '?cursor='],
    ['directory', '?kind=folder'],
    ['directory', '?updatedSince=2026-07-18'],
    ['directory', '?updatedSince=not-a-date'],
    ['directory', '?limit=0'],
    ['directory', '?limit=-1'],
    ['directory', '?limit=1.5'],
    ['directory', '?limit=01'],
    ['directory', '?limit=+1'],
    ['directory', '?limit=1e2'],
    ['directory', '?limit=9007199254740992'],
    ['directory', '?limit=999999999999999999999999999999'],
    ['directory', '?limit=1%00'],
    ['directory', '?__proto__=polluted'],
    ['directory', '?%5f%5fproto%5f%5f=polluted'],
    ['directory', '?constructor=value'],
    ['directory', '?prototype=value'],
    ['directory', '?&q=value'],
    ['directory', '?q=value&&limit=1'],
    ['directory', '?q=value&'],
    ['directory', '?=value'],
    ['snapshot', '?include=annotations,attachments'],
    ['snapshot', '?include=annotations&include=annotations'],
    ['snapshot', '?include=annotations&%69nclude=annotations'],
    ['snapshot', '?include='],
    ['snapshot', '?include=nodes'],
    ['snapshot', '?depth=-1'],
    ['snapshot', '?depth=0.5'],
    ['snapshot', '?depth=00'],
    ['snapshot', '?pageCursor=a&pageCursor=b'],
    ['snapshot', '?root=a&root=b'],
    ['snapshot', '?limit=2&depth=3&unexpected=4'],
    ['node', '?include=attachments,relations'],
    ['node', '?include=relations&include=relations'],
    ['node', '?limit=1'],
    ['node', '?include='],
    ['collection', '?limit=1'],
    ['collection', '?unknown=value'],
    ['collection', '?__proto__=value'],
  ] as const)(
    'rejects ambiguous or schema-invalid %s query %s with the exact machine result [evidence:http.query-codec]',
    (endpoint, rawSearch) => expectInvalid(endpoint, rawSearch),
  );

  it.each([
    ['directory', '?q=%'],
    ['directory', '?q=%2'],
    ['directory', '?q=%GG'],
    ['directory', '?q=%C3'],
    ['directory', '?q=%C3%28'],
    ['directory', '?q=%ED%A0%80'],
    ['directory', '?q=line%0Abreak'],
    ['directory', '?q=tab%09value'],
    ['directory', '?q=line\nbreak'],
    ['directory', '?q=delete\u007fvalue'],
    ['directory', '?q=next%C2%85line'],
    ['directory', '?%00name=value'],
    ['snapshot', '?include=%FF'],
  ] as const)(
    'rejects malformed raw bytes for %s query %s [evidence:http.query-codec]',
    (endpoint, rawSearch) => expectInvalid(endpoint, rawSearch),
  );

  it.each([
    ['directory', '?unknown=super-secret-token', 'super-secret-token'],
    ['directory', '?q=%&secret=private-value', 'private-value'],
    ['snapshot', '?include=private-attachment-name', 'private-attachment-name'],
    ['collection', '?credential=bearer-secret', 'bearer-secret'],
  ] as const)(
    'does not reflect sensitive %s query values in invalid_query output [evidence:http.query-codec]',
    (endpoint, rawSearch, secret) => expectInvalid(endpoint, rawSearch, secret),
  );

  it('returns detached deterministic frozen values and errors [evidence:http.query-codec]', () => {
    const first = decode('snapshot', '?include=relations&include=annotations&depth=2');
    const second = decode('snapshot', '?include=relations&include=annotations&depth=2');
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    if (first.valid && second.valid) {
      expect(first.value).not.toBe(second.value);
      expect(first.value.include).not.toBe(second.value.include);
    }

    const badFirst = decode('directory', '?limit=1&limit=2');
    const badSecond = decode('directory', '?limit=1&limit=2');
    expect(badFirst).toEqual(badSecond);
    expect(badFirst).not.toBe(badSecond);
    if (!badFirst.valid && !badSecond.valid) expect(badFirst.errors).not.toBe(badSecond.errors);
  });
});
