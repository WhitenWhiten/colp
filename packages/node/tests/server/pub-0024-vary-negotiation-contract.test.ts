import { describe, expect, it } from 'vitest';

import {
  createPublicationCachePolicy,
  createPublicationRepresentationHttpHeaders,
  type PublicationRepresentationHttpHeadersInput,
} from '../../src/server/index.js';
import { mergePublicationVary } from '../../src/server/publication-vary.js';

const evidence = '[evidence:http.vary.negotiation]';
const base = {
  representation: '{"items":[]}',
  revision: 'rev-1',
  projectionKey: 'public',
  queryContract: 'none' as const,
  query: {},
  negotiatedMediaType: 'application/json',
  protocolVersion: '0.1',
  lastModified: new Date('2026-07-18T01:02:03Z'),
};

function create(
  headers?: PublicationRepresentationHttpHeadersInput['headers'],
): Headers {
  return createPublicationRepresentationHttpHeaders({
    ...base,
    ...(headers === undefined ? {} : { headers }),
  });
}

function varyTokens(headers: Headers): string[] {
  return (headers.get('Vary') ?? '').split(',').map((token) => token.trim()).filter(Boolean);
}

describe(`PUB-0024 negotiated Publication Vary handling ${evidence}`, () => {
  it(`validates required field tokens and wildcard conflicts at the merge boundary ${evidence}`, () => {
    expect(mergePublicationVary('Origin', ['Accept', 'accept'])).toBe('Origin, Accept');
    expect(mergePublicationVary('*', [])).toBe('*');
    expect(mergePublicationVary('*', ['Accept'])).toBe('*');
    expect(() => mergePublicationVary('Origin', ['Bad Header'])).toThrow(/token/iu);
    expect(() => mergePublicationVary('Origin', ['*'])).toThrow(/token/iu);
  });

  it(`rejects malformed repeated Vary values and enforces the aggregate size limit ${evidence}`, () => {
    expect(() => mergePublicationVary([], ['Accept'])).toThrow(/non-empty array/iu);
    expect(() => mergePublicationVary(['Origin', ''], ['Accept'])).toThrow(/invalid/iu);
    expect(() => mergePublicationVary([`X${'a'.repeat(8 * 1024)}`, `Y${'b'.repeat(8 * 1024)}`], ['Accept']))
      .toThrow(/exceed|length/iu);
  });
  it(`adds both media-type and protocol-version negotiation fields to a normal response ${evidence}`, () => {
    expect(create().get('Vary')).toBe('Accept, Collection-Protocol-Version');
  });

  it(`preserves Authorization and Origin while adding negotiation fields ${evidence}`, () => {
    expect(create({ Vary: 'Authorization, Origin' }).get('Vary')).toBe(
      'Authorization, Origin, Accept, Collection-Protocol-Version',
    );
  });

  it.each([
    [
      'lowercase required fields',
      'accept, collection-protocol-version',
      ['accept', 'collection-protocol-version'],
    ],
    [
      'mixed-case duplicate fields',
      'AcCePt, ACCEPT, Collection-Protocol-Version, collection-protocol-version',
      ['AcCePt', 'Collection-Protocol-Version'],
    ],
    [
      'preserved fields and duplicate required fields',
      'Origin, origin, ACCEPT, Authorization, authorization',
      ['Origin', 'ACCEPT', 'Authorization', 'Collection-Protocol-Version'],
    ],
  ] as const)(`deduplicates %s case-insensitively while retaining first spelling and order ${evidence}`, (_name, vary, expected) => {
    expect(varyTokens(create({ Vary: vary }))).toEqual(expected);
  });

  it(`merges repeated Vary field values without losing existing fields ${evidence}`, () => {
    const headers = create([
      ['Vary', 'Origin, Accept'],
      ['Vary', 'Authorization'],
      ['Vary', 'collection-protocol-version, X-Tenant'],
    ]);
    expect(varyTokens(headers)).toEqual([
      'Origin',
      'Accept',
      'Authorization',
      'collection-protocol-version',
      'X-Tenant',
    ]);
  });

  it.each([
    ['media-only existing negotiation', 'Accept', ['Accept', 'Collection-Protocol-Version']],
    ['version-only existing negotiation', 'Collection-Protocol-Version', ['Collection-Protocol-Version', 'Accept']],
    ['both negotiation fields already present', 'Accept, Collection-Protocol-Version', ['Accept', 'Collection-Protocol-Version']],
    ['no negotiation fields present', 'Origin', ['Origin', 'Accept', 'Collection-Protocol-Version']],
  ] as const)(`handles the %s boundary ${evidence}`, (_name, vary, expected) => {
    expect(varyTokens(create({ Vary: vary }))).toEqual(expected);
  });

  it(`preserves a standalone Vary wildcard because it is stronger than named negotiation fields ${evidence}`, () => {
    expect(create({ Vary: '*' }).get('Vary')).toBe('*');
  });

  it.each([
    ['wildcard mixed with a named field', '*, Origin'],
    ['empty member', 'Origin,,Accept'],
    ['invalid field-name token', 'Origin, Bad Header'],
    ['CRLF injection', 'Origin\r\nX-Injected: yes'],
    ['oversized value', `X${'a'.repeat(16 * 1024)}`],
  ] as const)(`fails closed for %s ${evidence}`, (_name, vary) => {
    expect(() => create({ Vary: vary })).toThrow(/Vary|header|token|length|wildcard|CR|LF/iu);
  });

  it.each([
    ['success', 200],
    ['no content', 204],
    ['not modified', 304],
    ['authorization denial', 403],
    ['concealed response', 404],
  ] as const)(`retains negotiated Vary fields on a %s response status ${evidence}`, (_name, status) => {
    const response = new Response(status === 204 || status === 304 ? null : '{}', {
      status,
      headers: create({ Vary: 'Origin' }),
    });
    expect(response.headers.get('Vary')).toBe('Origin, Accept, Collection-Protocol-Version');
  });

  it(`retains the PUB-0023 private no-store Authorization policy while adding negotiation fields ${evidence}`, () => {
    const cachePolicy = createPublicationCachePolicy({
      kind: 'authorization-varying',
      existingVary: 'Origin',
    });
    const headers = create({
      'Cache-Control': cachePolicy['Cache-Control']!,
      Vary: cachePolicy.Vary!,
    });
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    expect(headers.get('Vary')).toBe('Origin, Authorization, Accept, Collection-Protocol-Version');
  });
});
