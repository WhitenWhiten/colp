import {
  validateWireDocument,
  type DefinitionName,
  type SemanticValidationResultLike,
  type ValidatorRegistry,
  type WireDocumentValidationResult,
} from '../schema/index.js';
import { immutableJsonData } from '../shared/immutable-json.js';

export type ValidatedWriteResult<Value, Issue, Result> =
  | Exclude<WireDocumentValidationResult<Value, Issue>, { readonly valid: true }>
  | { readonly valid: true; readonly value: Readonly<Value>; readonly result: Result };

export type SemanticWriteValidator<Value, Issue> = (
  value: Readonly<Value>,
) => SemanticValidationResultLike<Issue>;

export type PersistenceWriter<Value, Result> = (value: Readonly<Value>) => Promise<Result>;

const prototypeKeys = new Set(['__proto__', 'constructor', 'prototype']);

function immutableCandidate<Value>(value: unknown): Readonly<Value> {
  // immutableJsonData performs the same plain JSON checks and creates a detached
  // frozen snapshot with hard depth/member/byte budgets. Keeping the budget at
  // this boundary prevents an attacker-controlled object from being recursively
  // walked without a resource limit before schema validation runs.
  const candidate = immutableJsonData(value, 'Write candidate') as Readonly<Value>;
  // Preserve the write boundary's prototype-pollution policy while walking
  // only the already bounded detached snapshot. This second pass cannot be
  // driven into unbounded recursion by the caller.
  const pending: unknown[] = [candidate];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object') continue;
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === 'string' && prototypeKeys.has(key)) {
        throw new TypeError('Write candidate must not contain prototype-polluting member names.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && 'value' in descriptor) pending.push(descriptor.value);
    }
  }
  return candidate;
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
      const result: unknown = validateSemantics(validated);
      return normalizeSemanticResult<Issue>(result);
    },
  );
  if (!validation.valid) return validation;

  const result = await requirePromise(write(validation.value));
  return Object.freeze({ valid: true, value: validation.value, result });
}
