import type { DefinitionName, ValidatorRegistry } from '../schema/index.js';

type QueryValueKind = 'boolean' | 'integer' | 'string' | 'string[]';

/** Hard ceilings applied before materializing query values or diagnostics. */
export const QUERY_PARSE_LIMITS = Object.freeze({
  maxParameters: 64,
  maxValuesPerParameter: 32,
  maxErrors: 32,
});

const queryContracts = {
  auditQuery: { cursor: 'string', limit: 'integer', action: 'string', result: 'string', from: 'string', to: 'string' },
  cursorPageQuery: { cursor: 'string', limit: 'integer' },
  directoryQuery: { cursor: 'string', limit: 'integer', tag: 'string', creator: 'string', kind: 'string', updatedSince: 'string', q: 'string' },
  feedQuery: { cursor: 'string', from: 'string', limit: 'integer' },
  nodeDeleteQuery: { recursive: 'boolean' },
  nodeDetailQuery: { include: 'string[]' },
  snapshotQuery: { pageCursor: 'string', limit: 'integer', include: 'string[]', depth: 'integer', root: 'string' },
  syncPullQuery: { sessionId: 'string', cursor: 'string', limit: 'integer' },
  syncSnapshotQuery: { sessionId: 'string', pageCursor: 'string', limit: 'integer' },
} as const satisfies Readonly<Record<string, Readonly<Record<string, QueryValueKind>>>>;
const forbiddenQueryNames = new Set(['__proto__', 'constructor', 'prototype']);

export type QueryContractName = keyof typeof queryContracts;

export type QueryParseResult =
  | { readonly valid: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly valid: false; readonly code: 'invalid_query'; readonly errors: readonly string[] };

function parseScalar(name: string, kind: Exclude<QueryValueKind, 'string[]'>, value: string): unknown {
  if (kind === 'string') return value;
  if (kind === 'boolean') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new TypeError(`${name} must be true or false`);
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${name} must be a non-negative decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${name} is outside the safe integer range`);
  }
  return parsed;
}

export function parseProtocolQuery(
  contractName: QueryContractName,
  parameters: URLSearchParams,
  validators: ValidatorRegistry,
): QueryParseResult {
  const contract = queryContracts[contractName];
  const errors: string[] = [];
  // A null-prototype record prevents a numeric/unknown `__proto__` parameter
  // from changing the accumulator or confusing the closed contract check.
  const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  if (parameters.size > QUERY_PARSE_LIMITS.maxParameters) {
    return { valid: false, code: 'invalid_query', errors: Object.freeze(['Query contains too many parameters']) };
  }

  const seen = new Set<string>();
  for (const name of parameters.keys()) {
    if (errors.length >= QUERY_PARSE_LIMITS.maxErrors) break;
    if (seen.has(name)) continue;
    seen.add(name);
    if (forbiddenQueryNames.has(name)) {
      errors.push(`Unknown query parameter: ${name}`);
      continue;
    }
    const kind = contract[name as keyof typeof contract] as QueryValueKind | undefined;
    if (kind === undefined) {
      errors.push(`Unknown query parameter: ${name}`);
      continue;
    }
    const values = parameters.getAll(name);
    if (values.length > QUERY_PARSE_LIMITS.maxValuesPerParameter) {
      errors.push(`Query parameter ${name} has too many values`);
      if (errors.length >= QUERY_PARSE_LIMITS.maxErrors) break;
      continue;
    }
    if (kind !== 'string[]' && values.length !== 1) {
      errors.push(`Query parameter ${name} must appear once`);
      continue;
    }
    if (values.some((item) => item.length === 0)) {
      errors.push(`Query parameter ${name} must not be empty`);
      continue;
    }
    try {
      value[name] = kind === 'string[]'
        ? Object.freeze([...values])
        : parseScalar(name, kind, values[0] as string);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length >= QUERY_PARSE_LIMITS.maxErrors) break;
  }

  if (errors.length === 0) {
    const structural = validators.validate(contractName as DefinitionName, value);
    if (!structural.valid) {
      for (const error of structural.errors) {
        if (errors.length >= QUERY_PARSE_LIMITS.maxErrors) break;
        errors.push(`${error.instancePath || '/'} ${error.message ?? 'is invalid'}`);
      }
    }
  }
  return errors.length === 0
    ? { valid: true, value: Object.freeze(value) }
    : { valid: false, code: 'invalid_query', errors: Object.freeze(errors) };
}

