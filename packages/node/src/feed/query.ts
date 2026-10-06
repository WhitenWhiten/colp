import { isProxy } from 'node:util/types';

import {
  createValidatorRegistry,
  type ValidatorRegistry,
} from '../schema/index.js';
import { parseProtocolQuery, type QueryParseResult } from '../shared/query.js';
import type { FeedQuery } from '../types/index.js';

export type FeedQueryDecodeResult =
  | { readonly valid: true; readonly value: FeedQuery }
  | { readonly valid: false; readonly code: 'invalid_query'; readonly errors: readonly string[] };

let defaultValidators: ReturnType<typeof createValidatorRegistry> | undefined;

function validatorsOrDefault(validators?: ValidatorRegistry): ValidatorRegistry {
  if (validators !== undefined) return validators;
  defaultValidators ??= createValidatorRegistry();
  return defaultValidators;
}

/**
 * Decodes Feed query parameters (`cursor` / `from` / `limit`).
 *
 * Unknown parameters, duplicate scalars, empty values, and the illegal
 * `from`+`cursor` combination reject as registered `400 invalid_query`.
 */
export function decodeFeedQuery(
  parameters: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
  validators?: ValidatorRegistry,
): FeedQueryDecodeResult {
  const search = toSearchParams(parameters);
  const parsed: QueryParseResult = parseProtocolQuery(
    'feedQuery',
    search,
    validatorsOrDefault(validators),
  );
  if (!parsed.valid) {
    return Object.freeze({
      valid: false,
      code: 'invalid_query',
      errors: parsed.errors,
    });
  }

  const value = parsed.value as FeedQuery;
  if (value.cursor !== undefined && value.from !== undefined) {
    return Object.freeze({
      valid: false,
      code: 'invalid_query',
      errors: Object.freeze(['from and cursor must not appear together']),
    });
  }

  return Object.freeze({ valid: true, value: Object.freeze({ ...value }) });
}

function toSearchParams(
  parameters: URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>,
): URLSearchParams {
  if (parameters instanceof URLSearchParams) {
    return parameters;
  }
  if (typeof parameters !== 'object' || parameters === null || isProxy(parameters)) {
    throw new TypeError('Feed query parameters must be URLSearchParams or a plain object.');
  }
  const search = new URLSearchParams();
  for (const [name, raw] of Object.entries(parameters)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string') search.append(name, item);
      }
    } else if (typeof raw === 'string') {
      search.append(name, raw);
    }
  }
  return search;
}
