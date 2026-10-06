import { types as nodeTypes } from 'node:util';

import type { ProblemCode } from '../shared/problems.js';

/** Input needed to evaluate the HTTP write precondition for an existing resource. */
export interface PublisherWritePreconditionInput {
  /** Whether the target is an existing resource (create requests bypass this gate). */
  readonly existingResource: boolean;
  /** Raw HTTP If-Match value, including its entity-tag syntax. */
  readonly ifMatch?: string | readonly string[] | null | undefined;
  /** Current authoritative resource revision. */
  readonly currentRevision: string;
  /** Current representation ETag, when the adapter exposes one. */
  readonly currentEtag?: string;
}

export interface PublisherWritePreconditionSatisfied {
  readonly state: 'satisfied';
  readonly status: 200;
  readonly matched: 'etag' | 'revision' | 'wildcard' | 'not-required';
  /** Absent on satisfied results; `never` keeps failure code access type-safe. */
  readonly code: never;
}

export interface PublisherWritePreconditionFailure {
  readonly state: 'rejected';
  readonly status: 412 | 428;
  readonly code: Extract<ProblemCode, 'precondition_failed' | 'precondition_required'>;
  /** Current values are safe for the adapter to expose in ETag/Revision headers. */
  readonly currentRevision: string;
  readonly currentEtag?: string;
}

export interface PublisherWritePreconditionFailureWithEtag
  extends PublisherWritePreconditionFailure {
  readonly currentEtag: string;
}

export type PublisherWritePreconditionResult =
  | PublisherWritePreconditionSatisfied
  | PublisherWritePreconditionFailure;

export type PublisherWritePreconditionResultWithEtag =
  | PublisherWritePreconditionSatisfied
  | PublisherWritePreconditionFailureWithEtag;

const MAX_IF_MATCH_LENGTH = 16 * 1024;
const MAX_IF_MATCH_FIELD_VALUES = 1_024;
const CONTROL_OR_OBS_FOLD_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f]/u;
const STRONG_ENTITY_TAG_PATTERN = /^"[\x21\x23-\x7E\x80-\u00FF]*"$/u;

interface IfMatchCandidate {
  readonly opaqueTag: string;
  readonly weak: boolean;
}

function normalizeHeaderValues(
  value: PublisherWritePreconditionInput['ifMatch'],
): readonly string[] | undefined {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  // An explicitly empty repeated header has no members, so it is equivalent
  // to an omitted If-Match field for the required-precondition gate.
  if (values.length === 0) return [];
  if (values.some((item) => typeof item !== 'string')) return undefined;
  if (values.length > MAX_IF_MATCH_FIELD_VALUES) return undefined;
  let combinedLength = values.length - 1;
  for (const item of values) {
    combinedLength += item.length;
    if (combinedLength > MAX_IF_MATCH_LENGTH || CONTROL_OR_OBS_FOLD_PATTERN.test(item)) return undefined;
  }
  return Object.freeze([...values]);
}

function parseIfMatch(values: readonly string[]): '*' | readonly IfMatchCandidate[] | undefined {
  const combined = values.join(',');
  const trimmed = trimOws(combined);
  if (trimmed === '*') return '*';
  // RFC 9110: wildcard is an alternative field form, never a list member.
  if (trimmed.length === 0) return undefined;

  const candidates: IfMatchCandidate[] = [];
  let index = 0;
  while (index < combined.length) {
    index = skipOws(combined, index);
    // RFC 9110 section 5.6.1 requires list recipients to ignore a
    // reasonable number of empty members.
    while (combined[index] === ',') {
      index += 1;
      index = skipOws(combined, index);
    }
    if (index >= combined.length) break;

    const weak = combined.startsWith('W/', index);
    if (weak) index += 2;
    if (combined[index] !== '"') return undefined;
    const close = combined.indexOf('"', index + 1);
    if (close < 0) return undefined;
    const opaqueTag = combined.slice(index, close + 1);
    if (!STRONG_ENTITY_TAG_PATTERN.test(opaqueTag)) return undefined;
    candidates.push(Object.freeze({ opaqueTag, weak }));
    index = skipOws(combined, close + 1);
    if (index >= combined.length) break;
    if (combined[index] !== ',') return undefined;
    index += 1;
  }
  return candidates.length === 0 ? undefined : Object.freeze(candidates);
}

function skipOws(value: string, index: number): number {
  while (value[index] === ' ' || value[index] === '\t') index += 1;
  return index;
}

function trimOws(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/gu, '');
}

/**
 * Evaluates the Publisher existing-resource write gate.
 *
 * This function deliberately does not authenticate, authorize, conceal, or inspect
 * read-only policy. Hosts compose those checks before invoking it and must fail closed
 * when the authoritative revision is unavailable.
 */
export function evaluatePublisherWritePrecondition(
  input: PublisherWritePreconditionInput & { readonly currentEtag: string },
): PublisherWritePreconditionResultWithEtag;
export function evaluatePublisherWritePrecondition(
  input: PublisherWritePreconditionInput,
): PublisherWritePreconditionResult;
export function evaluatePublisherWritePrecondition(
  input: PublisherWritePreconditionInput,
): PublisherWritePreconditionResult {
  const snapshot = snapshotPreconditionInput(input);
  if (typeof snapshot.existingResource !== 'boolean') {
    throw new TypeError('Publisher precondition evaluation requires an existingResource boolean.');
  }
  if (typeof snapshot.currentRevision !== 'string' || snapshot.currentRevision.length === 0
    || /[\r\n\u0000]/u.test(snapshot.currentRevision)) {
    throw new TypeError('Publisher precondition evaluation requires a non-empty current revision.');
  }
  if (snapshot.currentEtag !== undefined
    && (typeof snapshot.currentEtag !== 'string' || snapshot.currentEtag.length === 0
      || /[\r\n\u0000]/u.test(snapshot.currentEtag))) {
    throw new TypeError('Publisher current ETag must be a string when provided.');
  }
  if (!snapshot.existingResource) {
    return Object.freeze({
      state: 'satisfied', status: 200, matched: 'not-required',
    }) as PublisherWritePreconditionSatisfied;
  }

  const headerValues = normalizeHeaderValues(snapshot.ifMatch);
  const failure = (status: 412 | 428, code: PublisherWritePreconditionFailure['code']) => Object.freeze({
    state: 'rejected' as const,
    status,
    code,
    currentRevision: snapshot.currentRevision,
    ...(snapshot.currentEtag === undefined ? {} : { currentEtag: snapshot.currentEtag }),
  });
  if (headerValues === undefined) return failure(412, 'precondition_failed');
  if (headerValues.length === 0) return failure(428, 'precondition_required');
  const candidates = parseIfMatch(headerValues);
  if (candidates === undefined) return failure(412, 'precondition_failed');
  if (candidates === '*') return Object.freeze({
    state: 'satisfied', status: 200, matched: 'wildcard',
  }) as PublisherWritePreconditionSatisfied;

  const revision = snapshot.currentRevision;
  const etag = snapshot.currentEtag;
  for (const candidate of candidates) {
    // If-Match uses strong comparison. A weak entity-tag is syntactically
    // valid but can never satisfy this precondition.
    if (candidate.weak) continue;
    const value = candidate.opaqueTag.slice(1, -1);
    if (etag !== undefined && (candidate.opaqueTag === etag || value === etag)) {
      return Object.freeze({
        state: 'satisfied', status: 200, matched: 'etag',
      }) as PublisherWritePreconditionSatisfied;
    }
    if (value === revision) return Object.freeze({
      state: 'satisfied', status: 200, matched: 'revision',
    }) as PublisherWritePreconditionSatisfied;
  }
  return failure(412, 'precondition_failed');
}

function snapshotPreconditionInput(input: PublisherWritePreconditionInput): PublisherWritePreconditionInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || nodeTypes.isProxy(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new TypeError('Publisher precondition evaluation input must be a plain data object.');
  }
  const allowedKeys = new Set(['existingResource', 'ifMatch', 'currentRevision', 'currentEtag']);
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    || !Object.hasOwn(input, 'existingResource') || !Object.hasOwn(input, 'currentRevision')) {
    throw new TypeError('Publisher precondition evaluation input contains unknown or missing fields.');
  }
  const value = <Key extends keyof PublisherWritePreconditionInput>(Key: Key): PublisherWritePreconditionInput[Key] => {
    const descriptor = Object.getOwnPropertyDescriptor(input, Key);
    if (descriptor === undefined) return undefined as PublisherWritePreconditionInput[Key];
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`Publisher precondition evaluation input ${Key} must be an enumerable data property.`);
    }
    return descriptor.value as PublisherWritePreconditionInput[Key];
  };
  const ifMatch = snapshotIfMatch(value('ifMatch'));
  const currentEtag = value('currentEtag');
  return Object.freeze({
    existingResource: value('existingResource'),
    currentRevision: value('currentRevision'),
    ...(ifMatch === undefined ? {} : { ifMatch }),
    ...(currentEtag === undefined ? {} : { currentEtag }),
  });
}

function snapshotIfMatch(
  ifMatch: PublisherWritePreconditionInput['ifMatch'],
): PublisherWritePreconditionInput['ifMatch'] {
  if (!Array.isArray(ifMatch)) return ifMatch;
  if (nodeTypes.isProxy(ifMatch)
    || (Object.getPrototypeOf(ifMatch) !== Array.prototype && Object.getPrototypeOf(ifMatch) !== null)) {
    throw new TypeError('Publisher If-Match values must be a plain array.');
  }
  const keys = Reflect.ownKeys(ifMatch);
  if (keys.length !== ifMatch.length + 1 || keys.at(-1) !== 'length') {
    throw new TypeError('Publisher If-Match values must be a dense array without extra properties.');
  }
  const values = Array.from({ length: ifMatch.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(ifMatch, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Publisher If-Match values must contain only enumerable data properties.');
    }
    return descriptor.value as string;
  });
  return Object.freeze(values);
}

export const evaluatePublisherPrecondition = evaluatePublisherWritePrecondition;
