import { describe, expect, it } from 'vitest';

import { decodeFeedQuery } from '../../src/feed/query.js';
import { createValidatorRegistry } from '../../src/schema/index.js';

const evidence = 'http.query-codec';
const validators = createValidatorRegistry();

describe(`Feed query decode [evidence:${evidence}]`, () => {
  it(`[success] decodes cursor and limit [evidence:${evidence}]`, () => {
    const result = decodeFeedQuery(new URLSearchParams('cursor=feed_01&limit=50'), validators);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ cursor: 'feed_01', limit: 50 });
    }
  });

  it(`[success] decodes from=now without cursor [evidence:${evidence}]`, () => {
    const result = decodeFeedQuery({ from: 'now' }, validators);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.from).toBe('now');
  });

  it(`[success] decodes from=beginning and the minimum limit [evidence:${evidence}]`, () => {
    const result = decodeFeedQuery(
      new URLSearchParams('from=beginning&limit=1'),
      validators,
    );
    expect(result).toEqual({
      valid: true,
      value: { from: 'beginning', limit: 1 },
    });
  });

  it(`[success] accepts the safe integer limit boundary [evidence:${evidence}]`, () => {
    const result = decodeFeedQuery(
      new URLSearchParams('limit=9007199254740991'),
      validators,
    );
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.limit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it(`[negative] rejects from+cursor together [evidence:${evidence}]`, () => {
    const result = decodeFeedQuery(
      new URLSearchParams('from=now&cursor=abc'),
      validators,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('invalid_query');
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it(`[negative] rejects unknown query parameters [evidence:${evidence}]`, () => {
    const result = decodeFeedQuery(new URLSearchParams('nope=1'), validators);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('invalid_query');
  });

  it(`[negative] rejects duplicate scalar parameters [evidence:${evidence}]`, () => {
    const params = new URLSearchParams();
    params.append('limit', '10');
    params.append('limit', '20');
    const result = decodeFeedQuery(params, validators);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.code).toBe('invalid_query');
  });

  it.each(['cursor', 'from', 'limit'])(
    `[negative] rejects an empty %s value [evidence:${evidence}]`,
    (name) => {
      const result = decodeFeedQuery(new URLSearchParams(`${name}=`), validators);
      expect(result).toEqual(expect.objectContaining({ valid: false, code: 'invalid_query' }));
      if (!result.valid) expect(result.errors.join(' ')).toMatch(/must not be empty/u);
    },
  );

  it(`[negative] rejects non-enum array members and repeated scalar array values [evidence:${evidence}]`, () => {
    const invalidFrom = decodeFeedQuery({ from: ['later'] }, validators);
    expect(invalidFrom.valid).toBe(false);
    const repeatedLimit = decodeFeedQuery({ limit: ['1', '2'] }, validators);
    expect(repeatedLimit.valid).toBe(false);
  });

  it(`[negative] rejects unsafe integer and oversized query input [evidence:${evidence}]`, () => {
    const unsafeLimit = decodeFeedQuery(
      new URLSearchParams('limit=9007199254740992'),
      validators,
    );
    expect(unsafeLimit.valid).toBe(false);

    const oversizedCursor = decodeFeedQuery(
      new URLSearchParams(`cursor=${'c'.repeat(512)}`),
      validators,
    );
    expect(oversizedCursor.valid).toBe(false);
  });

  it(`[boundary] rejects Proxy parameter containers before property enumeration [evidence:${evidence}]`, () => {
    let trapCalls = 0;
    const parameters = new Proxy({ limit: '1' }, {
      ownKeys() {
        trapCalls += 1;
        return ['limit'];
      },
    });
    expect(() => decodeFeedQuery(parameters, validators)).toThrow(TypeError);
    expect(trapCalls).toBe(0);
  });
});
