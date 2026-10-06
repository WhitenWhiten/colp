import { describe, expect, it } from 'vitest';

import { evaluatePublisherWritePrecondition } from '../../src/publisher/preconditions.js';

const evidence = 'publisher.if-match-required';
const existingResource = {
  existingResource: true,
  currentRevision: 'revision-current',
  currentEtag: '"etag-current"',
} as const;

describe(`PUBLISH-0006 existing-resource If-Match gate [evidence:${evidence}]`, () => {
  it(`rejects an existing-resource write without If-Match with 428 [evidence:${evidence}]`, () => {
    expect(evaluatePublisherWritePrecondition(existingResource)).toEqual({
      state: 'rejected',
      status: 428,
      code: 'precondition_required',
      currentRevision: 'revision-current',
      currentEtag: '"etag-current"',
    });
  });

  it(`rejects an existing-resource write with a non-matching If-Match with 412 [evidence:${evidence}]`, () => {
    expect(evaluatePublisherWritePrecondition({
      ...existingResource,
      ifMatch: '"etag-stale"',
    })).toMatchObject({
      state: 'rejected',
      status: 412,
      code: 'precondition_failed',
    });
  });

  it(`bypasses the If-Match gate for create requests [evidence:${evidence}]`, () => {
    expect(evaluatePublisherWritePrecondition({
      ...existingResource,
      existingResource: false,
    })).toEqual({
      state: 'satisfied',
      status: 200,
      matched: 'not-required',
    });
  });

  it(`fails closed when If-Match contains a malformed member [evidence:${evidence}]`, () => {
    expect(evaluatePublisherWritePrecondition({
      ...existingResource,
      ifMatch: ['"etag-current"', 'malformed-token'],
    })).toMatchObject({
      state: 'rejected',
      status: 412,
      code: 'precondition_failed',
    });
  });

  it(`fails closed when existingResource is not a boolean [evidence:${evidence}]`, () => {
    expect(() => evaluatePublisherWritePrecondition({
      ...existingResource,
      existingResource: 'false',
    } as unknown as typeof existingResource)).toThrow(/existingResource boolean/iu);
  });
});
