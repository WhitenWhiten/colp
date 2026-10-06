import { describe, expect, it } from 'vitest';

import { parseProtocolJsonResponseMediaType } from '../../src/client/protocol-json-media.js';

const evidence = '[evidence:http.vendor-json]';

describe(`PUB-0020 vendor JSON media contract ${evidence}`, () => {
  it('requires explicit Content-Type metadata at every JSON parsing boundary', () => {
    expect(() => parseProtocolJsonResponseMediaType(null, 'json')).toThrow(/declare application\/json/u);
    expect(() => parseProtocolJsonResponseMediaType(null, 'problem')).toThrow(/application\/problem\+json/u);
  });

  it.each([
    ['manifest', 'application/vnd.collection-protocol.manifest+json;version=0.1', 'json', 'application/vnd.collection-protocol.manifest+json'],
    ['directory', 'application/vnd.collection-protocol.catalog+json;version=0.1', 'json', 'application/vnd.collection-protocol.catalog+json'],
    ['snapshot', 'application/vnd.collection-protocol.snapshot+json;version=0.1', 'json', 'application/vnd.collection-protocol.snapshot+json'],
    ['case and OWS', ' Application/Vnd.Collection-Protocol.Catalog+Json ; version = 0.1 ; charset = UTF-8 ', 'json', 'application/vnd.collection-protocol.catalog+json'],
    ['quoted charset', 'application/vnd.collection-protocol.snapshot+json;version=0.1;charset="utf-8"', 'json', 'application/vnd.collection-protocol.snapshot+json'],
  ] as const)('accepts the precise %s vendor representation %s [evidence:http.vendor-json]', (_name, value, expected, normalized) => {
    expect(parseProtocolJsonResponseMediaType(value, expected)).toBe(normalized);
  });

  it.each([
    ['unknown resource', 'application/vnd.collection-protocol.unknown+json;version=0.1'],
    ['unknown version', 'application/vnd.collection-protocol.catalog+json;version=0.2'],
    ['missing version', 'application/vnd.collection-protocol.catalog+json'],
    ['duplicate version', 'application/vnd.collection-protocol.catalog+json;version=0.1;version=0.1'],
    ['duplicate Accept values', 'application/vnd.collection-protocol.catalog+json;version=0.1, application/json'],
    ['weighted alternative', 'application/vnd.collection-protocol.catalog+json;version=0.1;q=0.9'],
    ['wildcard', 'application/vnd.collection-protocol.*+json;version=0.1'],
    ['wrong charset', 'application/vnd.collection-protocol.catalog+json;version=0.1;charset=iso-8859-1'],
    ['invalid UTF-8 declaration', 'application/vnd.collection-protocol.catalog+json;version=0.1;charset=\u00ff'],
    ['vendor Problem substitute', 'application/vnd.collection-protocol.problem+json;version=0.1'],
  ] as const)('rejects %s vendor declaration [evidence:http.vendor-json]', (_name, value) => {
    expect(() => parseProtocolJsonResponseMediaType(value, 'json')).toThrow();
  });

  it(`keeps application/json support (PUB-0019 regression) ${evidence}`, () => {
    expect(parseProtocolJsonResponseMediaType('Application/Json; charset=utf-8', 'json')).toBe('application/json');
  });

  it(`does not let a vendor +json type replace application/problem+json ${evidence}`, () => {
    expect(() => parseProtocolJsonResponseMediaType(
      'application/vnd.collection-protocol.problem+json;version=0.1',
      'problem',
    )).toThrow(/application\/problem\+json/u);
  });
});
