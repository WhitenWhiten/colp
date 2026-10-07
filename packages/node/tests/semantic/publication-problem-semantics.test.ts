import { describe, expect, it } from 'vitest';

import * as client from '../../src/client/index.js';
import {
  classifyPublicationProblem,
  validatePublicationProblemSemantics,
} from '../../src/semantic/index.js';
import type { Problem } from '../../src/types/index.js';

const problem: Problem = {
  type: 'https://know-n.com/colp/problems/precondition-failed',
  title: 'Precondition failed',
  status: 412,
  code: 'precondition_failed',
  currentRevision: 'r_18',
};

const check = (contentType: string | null) =>
  validatePublicationProblemSemantics(problem, { httpStatus: 412, contentType });

describe('Problem semantics on the semantic entry', () => {
  it('is the same function the client entry exports', () => {
    expect(validatePublicationProblemSemantics).toBe(client.validatePublicationProblemSemantics);
    expect(classifyPublicationProblem).toBe(client.classifyPublicationProblem);
  });

  it('classifies recovery data without a client', () => {
    expect(classifyPublicationProblem(problem)).toEqual({
      code: 'precondition_failed',
      status: 412,
      known: true,
      retryable: true,
      recovery: { currentRevision: 'r_18' },
    });
  });

  it.each([
    ['application/problem+json', undefined],
    ['application/problem+json;charset="utf-8"', undefined],
    ['Application/Problem+JSON ; Charset = UTF-8', undefined],
    ['application/problem+json; profile="a\\"b"', undefined],
    [null, 'problem_content_type_missing'],
    ['', 'problem_content_type_invalid'],
    ['application/problem+json\r\nx: y', 'problem_content_type_invalid'],
    ['/problem+json', 'problem_content_type_invalid'],
    ['application/json', 'problem_content_type_mismatch'],
    ['text/problem+json', 'problem_content_type_mismatch'],
    ['application/problem+json x', 'problem_content_type_ambiguous'],
    ['application/problem+json; =utf-8', 'problem_content_type_invalid'],
    ['application/problem+json; charset=utf-8; charset=utf-8', 'problem_content_type_ambiguous'],
    ['application/problem+json; charset', 'problem_content_type_invalid'],
    ['application/problem+json; charset=', 'problem_content_type_invalid'],
    ['application/problem+json; charset="utf-8', 'problem_content_type_invalid'],
    ['application/problem+json; profile="a\\', 'problem_content_type_invalid'],
    ['application/problem+json; profile="a\\\u0001"', 'problem_content_type_invalid'],
    ['application/problem+json; profile="a\u0001"', 'problem_content_type_invalid'],
    ['application/problem+json; charset=latin1', 'problem_content_type_charset'],
  ])('Content-Type %j -> %s', (contentType, code) => {
    const result = check(contentType);
    if (code === undefined) {
      expect(result).toEqual({ valid: true, issues: [] });
    } else {
      expect(result).toMatchObject({ valid: false, issues: [expect.objectContaining({ code })] });
    }
  });
});
