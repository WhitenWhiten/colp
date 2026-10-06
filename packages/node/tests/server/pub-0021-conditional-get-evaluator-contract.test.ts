import { describe, expect, it } from 'vitest';

import {
  createPublicationRepresentationHttpHeaders,
  evaluatePublicationConditionalGet,
  type EvaluatePublicationConditionalGetInput,
  type EvaluatePublicationConditionalGetResult,
} from '../../src/server/index.js';

const evidence = '[evidence:http.validators]';

/** Representative strong Publication representation ETag (quoted opaque-tag). */
const currentEtag = '"pub.r1.abcdefghijklmnopqrstuvwxyz0123456789ABCDE"';
const otherEtag = '"pub.r1.ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxwv"';
const thirdEtag = '"pub.r1.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcde"';

function evaluate(
  change: Partial<EvaluatePublicationConditionalGetInput> = {},
): EvaluatePublicationConditionalGetResult {
  return evaluatePublicationConditionalGet({
    etag: currentEtag,
    ...change,
  });
}

function expectStatus(
  result: EvaluatePublicationConditionalGetResult,
  status: 200 | 304,
): void {
  expect(result).toEqual({ status });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.keys(result)).toEqual(['status']);
}

describe(`PUB-0021/PUB-0022 Publication conditional GET evaluator ${evidence}`, () => {
  it(`uses RFC 9110 weak comparison for both strong and weak request validators ${evidence}`, () => {
    expectStatus(evaluate({ ifNoneMatch: currentEtag }), 304);
    expectStatus(evaluate({ ifNoneMatch: `W/${currentEtag}` }), 304);
  });

  it(`accepts legal commas inside opaque-tags without treating them as list separators ${evidence}`, () => {
    const commaEtag = '"publication,revision,one"';
    expectStatus(evaluatePublicationConditionalGet({
      etag: commaEtag,
      ifNoneMatch: commaEtag,
    }), 304);
    expectStatus(evaluatePublicationConditionalGet({
      etag: commaEtag,
      ifNoneMatch: `${otherEtag}, W/${commaEtag}`,
    }), 304);
    expectStatus(evaluatePublicationConditionalGet({
      etag: commaEtag,
      ifNoneMatch: '"publication,revision,two"',
    }), 200);
  });

  it(`returns 200 when If-None-Match is a different strong ETag ${evidence}`, () => {
    expectStatus(evaluate({ ifNoneMatch: otherEtag }), 200);
  });

  it(`returns 200 when the precondition is absent (null, undefined, or omitted) ${evidence}`, () => {
    expectStatus(evaluate({ ifNoneMatch: null }), 200);
    expectStatus(evaluate({ ifNoneMatch: undefined }), 200);
    expectStatus(evaluatePublicationConditionalGet({ etag: currentEtag }), 200);
  });

  it(`returns 304 when a strong or weak match appears anywhere in a multi-tag list ${evidence}`, () => {
    expectStatus(
      evaluate({ ifNoneMatch: `${otherEtag}, ${currentEtag}, ${thirdEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `${currentEtag}, ${otherEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `${otherEtag}, ${thirdEtag}, ${currentEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `${otherEtag}, W/${currentEtag}, W/${thirdEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `W/${otherEtag}, ${currentEtag}` }),
      304,
    );
  });

  it(`returns 200 when a multi-tag list contains only non-matching strong tags ${evidence}`, () => {
    expectStatus(
      evaluate({ ifNoneMatch: `${otherEtag}, ${thirdEtag}` }),
      200,
    );
  });

  it(`accepts optional whitespace around validators and list separators ${evidence}`, () => {
    expectStatus(
      evaluate({ ifNoneMatch: `${otherEtag},${currentEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `  ${otherEtag}\t,\t ${currentEtag}  ` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `\t${otherEtag} ,  ${thirdEtag}\t` }),
      200,
    );
    expectStatus(evaluate({ ifNoneMatch: `  W/${currentEtag}  ` }), 304);
  });

  it(`ignores RFC 9110 empty list members without hiding a valid validator ${evidence}`, () => {
    expectStatus(evaluate({ ifNoneMatch: `${currentEtag},` }), 304);
    expectStatus(evaluate({ ifNoneMatch: `${otherEtag},` }), 200);
    expectStatus(evaluate({ ifNoneMatch: `, ${currentEtag}` }), 304);
    expectStatus(evaluate({ ifNoneMatch: `${otherEtag},, W/${currentEtag}` }), 304);
    expectStatus(evaluate({ ifNoneMatch: `, , ${otherEtag}, ,` }), 200);
    expectStatus(evaluate({ ifNoneMatch: ', , ,' }), 200);
  });

  it(`returns 304 for the If-None-Match wildcard when a current representation ETag is present ${evidence}`, () => {
    expectStatus(evaluate({ ifNoneMatch: '*' }), 304);
    expectStatus(evaluate({ ifNoneMatch: ' * ' }), 304);
    expectStatus(evaluate({ ifNoneMatch: '\t*\t' }), 304);
  });

  it(`treats the weak prefix as case-sensitive and accepts only uppercase W/ ${evidence}`, () => {
    expectStatus(evaluate({ ifNoneMatch: `W/${currentEtag}` }), 304);
    expectStatus(evaluate({ ifNoneMatch: `w/${currentEtag}` }), 200);
    expectStatus(evaluate({ ifNoneMatch: `w/${otherEtag}, W/${currentEtag}` }), 200);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['tabs only', '\t\t'],
    ['unquoted token', 'pub.r1.not-quoted'],
    ['missing closing quote', '"pub.r1.open'],
    ['validators without a separating comma', `${otherEtag} ${currentEtag}`],
    ['garbage between list members', `${otherEtag}; ${currentEtag}`],
    ['whitespace inside weak prefix', `W/ ${currentEtag}`],
    // `*` is only legal as the entire field value, never mixed with tags.
    ['wildcard mixed into a list', `*, ${currentEtag}`],
    ['tag list mixed with wildcard', `${currentEtag}, *`],
    // Matching opaque-tag text must not 304 when the field is hostile/malformed.
    ['CRLF injection with matching tag', `${currentEtag}\r\nX-Injected: yes`],
    ['embedded LF after matching tag', `${currentEtag}\n`],
    ['embedded NUL after matching tag', `${currentEtag}\u0000`],
    ['bare weak prefix', 'W/'],
    ['non-string type via cast path is fail-open', 42 as unknown as string],
  ] as const)(
    `fails open to 200 (never 304) for malformed If-None-Match: %s ${evidence}`,
    (_label, ifNoneMatch) => {
      const result = evaluate({ ifNoneMatch });
      expectStatus(result, 200);
      expect(result.status).not.toBe(304);
    },
  );

  it(`fails open to 200 for oversized If-None-Match rather than matching ${evidence}`, () => {
    const oversized = `"${'a'.repeat(16 * 1024)}"`;
    expect(oversized.length).toBeGreaterThan(16 * 1024);
    expectStatus(evaluate({ ifNoneMatch: oversized }), 200);
  });

  it(`compares only opaque-tag text and ignores weakness in mixed lists ${evidence}`, () => {
    expectStatus(
      evaluate({ ifNoneMatch: `W/${currentEtag}, W/${otherEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `W/${otherEtag}, ${currentEtag}` }),
      304,
    );
    expectStatus(
      evaluate({ ifNoneMatch: `W/${otherEtag}, W/${thirdEtag}` }),
      200,
    );
  });

  it(`rejects invalid server-controlled etag input as a programming error ${evidence}`, () => {
    expect(() => evaluatePublicationConditionalGet({
      etag: '',
      ifNoneMatch: currentEtag,
    })).toThrow(TypeError);

    expect(() => evaluatePublicationConditionalGet({
      etag: `W/${currentEtag}`,
      ifNoneMatch: '*',
    })).toThrow(/strong|etag/iu);

    expect(() => evaluatePublicationConditionalGet({
      etag: `${currentEtag}, ${otherEtag}`,
      ifNoneMatch: currentEtag,
    })).toThrow(/strong|etag|single/iu);

    expect(() => evaluatePublicationConditionalGet({
      etag: 'not-quoted',
      ifNoneMatch: '*',
    })).toThrow(TypeError);

    expect(() => evaluatePublicationConditionalGet({
      etag: `${currentEtag}\r\n`,
      ifNoneMatch: currentEtag,
    })).toThrow(/control|etag/iu);
  });

  it(`rejects non-object and unknown input fields before evaluation ${evidence}`, () => {
    expect(() => evaluatePublicationConditionalGet(null as never)).toThrow(TypeError);
    expect(() => evaluatePublicationConditionalGet([] as never)).toThrow(TypeError);
    expect(() => evaluatePublicationConditionalGet({
      etag: currentEtag,
      ifNoneMatch: currentEtag,
      extra: true,
    } as never)).toThrow(/unsupported field/iu);
  });

  it(`returns detached frozen results so callers cannot mutate the decision ${evidence}`, () => {
    const matched = evaluate({ ifNoneMatch: currentEtag });
    const missed = evaluate({ ifNoneMatch: otherEtag });
    expect(matched).not.toBe(missed);
    expect(Object.isFrozen(matched)).toBe(true);
    expect(Object.isFrozen(missed)).toBe(true);
    expect(() => {
      (matched as { status: number }).status = 200;
    }).toThrow();
    expect(matched.status).toBe(304);
  });

  it(`pairs with representation header ETags: match 304, revision change 200 ${evidence}`, () => {
    const base = {
      representation: '{"items":[1]}',
      revision: 'rev-1',
      projectionKey: 'public',
      queryContract: 'snapshotQuery' as const,
      query: { root: 'root', depth: 1, limit: 20, pageCursor: 'cursor-a' },
      negotiatedMediaType: 'application/json',
      protocolVersion: '0.1',
      lastModified: new Date('2026-07-18T01:02:03.000Z'),
    };
    const first = createPublicationRepresentationHttpHeaders(base).get('etag');
    const second = createPublicationRepresentationHttpHeaders({
      ...base,
      revision: 'rev-2',
    }).get('etag');
    expect(typeof first).toBe('string');
    expect(typeof second).toBe('string');
    expect(first).not.toBe(second);

    expectStatus(
      evaluatePublicationConditionalGet({ etag: first as string, ifNoneMatch: first }),
      304,
    );
    expectStatus(
      evaluatePublicationConditionalGet({ etag: second as string, ifNoneMatch: first }),
      200,
    );
    expectStatus(
      evaluatePublicationConditionalGet({
        etag: second as string,
        ifNoneMatch: `${first}, ${second}`,
      }),
      304,
    );
  });
});
