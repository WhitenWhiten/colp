import { describe, expect, it } from 'vitest';
import { createValidatorRegistry } from '../../src/schema/index.js';
import { parseProtocolQuery, QUERY_PARSE_LIMITS } from '../../src/shared/query.js';

describe('Protocol query diagnostic budget', () => {
  it('caps unknown-name errors at the diagnostic limit', () => {
    const query = new URLSearchParams();
    for (let index = 0; index < QUERY_PARSE_LIMITS.maxParameters; index += 1) query.append(`unknown${index}`, 'x');
    const result = parseProtocolQuery('feedQuery', query, createValidatorRegistry());
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors).toHaveLength(QUERY_PARSE_LIMITS.maxErrors);
  });
});
