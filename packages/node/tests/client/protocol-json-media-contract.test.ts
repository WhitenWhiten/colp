import { describe, expect, it } from 'vitest';

import {
  parseProtocolJsonResponseMediaType,
  protocolVendorJsonMediaType,
  protocolVendorJsonResourceForDefinition,
} from '../../src/client/protocol-json-media.js';

const evidence = '[evidence:http.protocol-json-media]';

describe(`protocol JSON media canonical exports ${evidence}`, () => {
  it.each([
    ['manifest', 'manifest'],
    ['collectionDirectory', 'catalog'],
    ['collection', 'collection'],
    ['collectionMetadata', 'collection'],
    ['snapshot', 'snapshot'],
    ['node', 'node'],
    ['nodeDetail', 'node'],
  ] as const)('maps definition %s to vendor resource %s', (definition, resource) => {
    expect(protocolVendorJsonResourceForDefinition(definition)).toBe(resource);
  });

  it('returns undefined for unregistered definitions', () => {
    expect(protocolVendorJsonResourceForDefinition('problem')).toBeUndefined();
    expect(protocolVendorJsonResourceForDefinition('unknown')).toBeUndefined();
  });

  it.each(['catalog', 'collection', 'snapshot', 'node', 'manifest'] as const)(
    'builds the registered vendor media type for %s',
    (resource) => {
      expect(protocolVendorJsonMediaType(resource)).toBe(
        `application/vnd.collection-protocol.${resource}+json;version=0.1`,
      );
    },
  );

  it('rejects unknown vendor resources at the media-type boundary', () => {
    expect(() => protocolVendorJsonMediaType('problem' as 'catalog')).toThrow(
      /Unknown protocol vendor JSON resource/u,
    );
  });

  it('requires Content-Type for JSON and Problem parsing boundaries', () => {
    expect(() => parseProtocolJsonResponseMediaType(null, 'json')).toThrow(
      /declare application\/json/u,
    );
    expect(() => parseProtocolJsonResponseMediaType(null, 'problem')).toThrow(
      /application\/problem\+json/u,
    );
  });

  it('accepts generic JSON and registered vendor JSON with UTF-8 charset', () => {
    expect(parseProtocolJsonResponseMediaType('application/json; charset=utf-8', 'json'))
      .toBe('application/json');
    expect(parseProtocolJsonResponseMediaType(
      'application/vnd.collection-protocol.snapshot+json;version=0.1;charset="utf-8"',
      'json',
      'snapshot',
    )).toBe('application/vnd.collection-protocol.snapshot+json');
  });

  it('rejects Problem responses that use a vendor +json substitute', () => {
    expect(() => parseProtocolJsonResponseMediaType(
      'application/vnd.collection-protocol.problem+json;version=0.1',
      'problem',
    )).toThrow(/application\/problem\+json/u);
  });

  it('rejects ambiguous or non-UTF-8 Content-Type values', () => {
    expect(() => parseProtocolJsonResponseMediaType(
      'application/json, application/json',
      'json',
    )).toThrow(/ambiguous/u);
    expect(() => parseProtocolJsonResponseMediaType(
      'application/json;charset=iso-8859-1',
      'json',
    )).toThrow(/UTF-8/u);
  });
});
