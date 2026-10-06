import {
  validateWireDocument,
  type DefinitionName,
  type SemanticValidationResultLike,
  type ValidatorRegistry,
  type WireDocumentValidationResult,
} from '../schema/index.js';
import { deepFreeze } from './deep-freeze.js';

export type ValidatedWriteResult<Value, Issue, Result> =
  | Exclude<WireDocumentValidationResult<Value, Issue>, { readonly valid: true }>
  | { readonly valid: true; readonly value: Readonly<Value>; readonly result: Result };

export type SemanticWriteValidator<Value, Issue> = (
  value: Readonly<Value>,
) => SemanticValidationResultLike<Issue>;

export type PersistenceWriter<Value, Result> = (value: Readonly<Value>) => Promise<Result>;

const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function assertJsonData(value: unknown, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Write candidate numbers must be finite JSON numbers.');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError('Write candidate integers must be within the I-JSON safe range.');
    }
    return;
  }
  if (typeof value !== 'object') throw new TypeError('Write candidate must contain only JSON values.');
  if (ancestors.has(value)) throw new TypeError('Write candidate must not contain cycles.');

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Write candidate objects must have a plain or null prototype.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('Write candidate must not contain symbol properties.');
  }
  if (keys.some((key) => typeof key === 'string' && prototypeKeys.has(key))) {
    throw new TypeError('Write candidate must not contain prototype-polluting member names.');
  }
  if (Array.isArray(value)) {
    const expected = new Set([...value.keys()].map(String).concat('length'));
    const hasHole = [...value.keys()].some((index) => !(index in value));
    if (keys.some((key) => !expected.has(key as string)) || hasHole) {
      throw new TypeError('Write candidate arrays must be dense JSON arrays without extra properties.');
    }
  }

  ancestors.add(value);
  for (const key of keys) {
    if (key === 'length' && Array.isArray(value)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Write candidate members must be enumerable data properties.');
    }
    assertJsonData(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function immutableCandidate<Value>(value: unknown): Readonly<Value> {
  // Input is already constrained to the JSON-data subset; structuredClone of that
  // subset cannot introduce non-JSON values, so a second assert is redundant.
  assertJsonData(value);
  const candidate = structuredClone(value) as Value;
  return deepFreeze(candidate);
}

function normalizeSemanticResult<Issue>(
  candidate: unknown,
): SemanticValidationResultLike<Issue> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new TypeError('Semantic validator must return a validation result object.');
  }
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Semantic validator must return a plain validation result object.');
  }
  const keys = Reflect.ownKeys(candidate);
  if (
    keys.length !== 2
    || !keys.includes('valid')
    || !keys.includes('issues')
    || keys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError('Semantic validation result must contain only valid and issues.');
  }
  const validDescriptor = Object.getOwnPropertyDescriptor(candidate, 'valid');
  const issuesDescriptor = Object.getOwnPropertyDescriptor(candidate, 'issues');
  if (
    validDescriptor === undefined
    || issuesDescriptor === undefined
    || !validDescriptor.enumerable
    || !issuesDescriptor.enumerable
    || !('value' in validDescriptor)
    || !('value' in issuesDescriptor)
    || typeof validDescriptor.value !== 'boolean'
    || !Array.isArray(issuesDescriptor.value)
  ) {
    throw new TypeError('Semantic validation result must contain a boolean valid and an issues array.');
  }
  const valid = validDescriptor.value;
  const issues = Object.freeze([...issuesDescriptor.value] as Issue[]);
  if (valid === (issues.length !== 0)) {
    throw new TypeError('Semantic validation result valid flag contradicts its issues.');
  }
  return valid
    ? Object.freeze({ valid: true, issues: [] as const })
    : Object.freeze({ valid: false, issues });
}

function requirePromise<Result>(candidate: Promise<Result>): Promise<Result> {
  if (!(candidate instanceof Promise)) {
    throw new TypeError('Persistence writer must return a Promise.');
  }
  return candidate;
}

/**
 * Authorizes one persistence call only after canonical structure/format and
 * semantic validation have succeeded for an immutable, detached candidate.
 */
export async function executeValidatedWrite<Value, Issue, Result>(
  validators: ValidatorRegistry,
  definition: DefinitionName,
  value: unknown,
  validateSemantics: SemanticWriteValidator<Value, Issue>,
  write: PersistenceWriter<Value, Result>,
): Promise<ValidatedWriteResult<Value, Issue, Result>> {
  const candidate = immutableCandidate<Value>(value);
  const validation = validateWireDocument<Value, Issue>(
    validators,
    definition,
    candidate,
    (validated) => {
      assertJsonData(validated);
      const result: unknown = validateSemantics(validated);
      return normalizeSemanticResult<Issue>(result);
    },
  );
  if (!validation.valid) return validation;

  const result = await requirePromise(write(validation.value));
  return Object.freeze({ valid: true, value: validation.value, result });
}
