import { describe, expect, it } from 'vitest';

import {
  validatePublicationIfNoneMatchEtag,
  validatePublicationProblemSemantics,
} from '../../src/client/index.js';

describe('Publication client ETag validation boundaries [evidence:http.conditional]', () => {
  it.each(['"opaque,tag"', '"unicode-\u00e9"', '"!#$%&\'()*+-.^_`|~"'])
    ('accepts a legal quoted opaque-tag %j verbatim', (etag) => {
      expect(validatePublicationIfNoneMatchEtag(etag)).toBe(etag);
    });

  it.each([
    undefined,
    null,
    'opaque-tag',
    'W/"weak-tag"',
    '"unterminated',
    '"line\nfeed"',
    '"carriage\rreturn"',
    '"control-\u0001"',
  ])('rejects an unsafe or non-strong ETag %j', (etag) => {
    expect(() => validatePublicationIfNoneMatchEtag(etag)).toThrow(TypeError);
  });
});

const problem = {
  type: 'https://collectionprotocol.org/problems/resource-not-found',
  title: 'Resource not found',
  status: 404,
  code: 'resource_not_found',
} as const;

describe('Publication Problem media-parameter grammar [evidence:http.problems]', () => {
  it.each([
    ['', 'problem_content_type_invalid'],
    [`application/problem+json; p=${'a'.repeat(1_025)}`, 'problem_content_type_invalid'],
    ['application problem+json', 'problem_content_type_invalid'],
    ['application/problem+json trailing', 'problem_content_type_ambiguous'],
    ['application/problem+json; profile', 'problem_content_type_invalid'],
    ['application/problem+json; profile=', 'problem_content_type_invalid'],
    ['application/problem+json; profile="bad\\\u0001"', 'problem_content_type_invalid'],
    ['application/problem+json; charset="latin-1"', 'problem_content_type_charset'],
  ])('classifies malformed Content-Type %j as %s', (contentType, expectedCode) => {
    const result = validatePublicationProblemSemantics(problem as never, {
      httpStatus: 404,
      contentType,
    });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: expectedCode, path: '' }),
    ]);
  });

  it.each([
    'not-a-uri',
    'http://vendor.example/problem',
    'https://user@vendor.example/problem',
    `https://vendor.example/${'x'.repeat(2_050)}`,
  ])('rejects an unsafe extension Problem code %j', (code) => {
    const result = validatePublicationProblemSemantics({ ...problem, code } as never, {
      httpStatus: 404,
      contentType: 'application/problem+json',
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: 'problem_extension_code_invalid',
      path: '/code',
    });
  });
});
