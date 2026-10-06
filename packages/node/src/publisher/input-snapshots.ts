import { types as nodeTypes } from 'node:util';

import { immutableJsonData } from '../shared/immutable-json.js';
import { DEFAULT_I_JSON_PARSE_LIMITS } from '../schema/index.js';
import type {
  CanonicalRequestDigestInput,
  IdempotencyBinding,
  PublisherIdempotencyKeyRequirementInput,
  PublisherIdempotencyRequest,
} from './index.js';

export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`Canonical request ${name} must be a non-empty string.`);
  }
}

export function isPlainJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !nodeTypes.isProxy(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && isJsonValue(value);
}

function hasOnlyUnicodeScalarValues(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const prototypePollutionKeys = new Set(['__proto__', 'constructor', 'prototype']);

interface JsonValidationState {
  members: number;
}

export function isJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
  depth = 0,
  state: JsonValidationState = { members: 0 },
): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return hasOnlyUnicodeScalarValues(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  }
  if (typeof value !== 'object' || ancestors.has(value) || nodeTypes.isProxy(value)
    || depth > DEFAULT_I_JSON_PARSE_LIMITS.maxDepth) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.at(-1) !== 'length'
      || !Object.keys(value).every((key, index) => key === String(index))) return false;
    state.members += value.length;
    if (state.members > DEFAULT_I_JSON_PARSE_LIMITS.maxMembers) return false;
    ancestors.add(value);
    const valid = value.every((item) => isJsonValue(item, ancestors, depth + 1, state));
    ancestors.delete(value);
    return valid;
  }
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  state.members += keys.length;
  if (state.members > DEFAULT_I_JSON_PARSE_LIMITS.maxMembers) return false;
  ancestors.add(value);
  const valid = keys.every((key) => {
    if (typeof key !== 'string' || prototypePollutionKeys.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
      && isJsonValue(descriptor.value, ancestors, depth + 1, state);
  });
  ancestors.delete(value);
  return valid;
}

/** Snapshots the canonical digest envelope without invoking caller accessors. */
export function snapshotCanonicalRequestDigestInput(input: unknown): CanonicalRequestDigestInput {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Canonical request input is required.');
  }
  if (nodeTypes.isProxy(input) || Array.isArray(input)) {
    throw new TypeError('Canonical request input must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Canonical request input must be a plain object.');
  }
  const requiredKeys = [
    'protocolVersion', 'endpointKey', 'resourceIdentity', 'method', 'query', 'mediaType', 'body',
  ] as const;
  const allowedKeys = new Set<string>(['principalId', 'ifMatch', ...requiredKeys]);
  const ownKeys = Reflect.ownKeys(input);
  const optionalKeyCount = Number(Object.hasOwn(input, 'principalId'))
    + Number(Object.hasOwn(input, 'ifMatch'));
  if (
    ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    || !requiredKeys.every((key) => Object.hasOwn(input, key))
    || ownKeys.length !== requiredKeys.length + optionalKeyCount
  ) {
    throw new TypeError('Canonical request input contains unknown or missing fields.');
  }
  const candidate = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new TypeError('Canonical request input must contain string data fields.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Canonical request input members must be enumerable data properties.');
    }
    candidate[key] = descriptor.value;
  }
  return Object.freeze(candidate) as unknown as CanonicalRequestDigestInput;
}

/** Snapshots the complete Publisher idempotency request envelope. */
export function snapshotPublisherIdempotencyRequest(input: unknown): PublisherIdempotencyRequest {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('Publisher idempotency request is required.');
  }
  if (nodeTypes.isProxy(input)) {
    throw new TypeError('Publisher idempotency request must not contain Proxy objects.');
  }
  if (Array.isArray(input)) {
    throw new TypeError('Publisher idempotency request must be a plain object.');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Publisher idempotency request must be a plain object.');
  }
  const expectedKeys = [
    'principalId', 'protocolVersion', 'method', 'endpointKey', 'resourceIdentity',
    'idempotencyKey', 'decodedQuery', 'mediaType', 'body',
  ] as const;
  const allowedKeys = new Set<string>([...expectedKeys, 'ifMatch']);
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    || (ownKeys.length !== expectedKeys.length && ownKeys.length !== expectedKeys.length + 1)
    || !expectedKeys.every((key) => Object.hasOwn(input, key))
  ) {
    throw new TypeError('Publisher idempotency request contains unknown or missing fields.');
  }
  const candidate = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new TypeError('Publisher idempotency request must contain string data fields.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Publisher idempotency request members must be enumerable data properties.');
    }
    candidate[key] = descriptor.value;
  }
  return Object.freeze(candidate) as unknown as PublisherIdempotencyRequest;
}

/** Snapshots the idempotency-key envelope before method-dependent inspection. */
export function snapshotPublisherIdempotencyKeyInput(
  input: unknown,
): PublisherIdempotencyKeyRequirementInput {
  if (input === null || typeof input !== 'object' || nodeTypes.isProxy(input) || Array.isArray(input)) {
    throw new TypeError('Publisher idempotency-key evaluation input is required.');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Publisher idempotency-key evaluation input must be a plain object.');
  }
  const allowedKeys = new Set(['method', 'retryable', 'idempotencyKey', 'binding']);
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    || !Object.hasOwn(input, 'method')
    || !Object.hasOwn(input, 'retryable')
    || !Object.hasOwn(input, 'binding')
    || ownKeys.length < 3
    || ownKeys.length > 4
  ) {
    throw new TypeError('Publisher idempotency-key evaluation input contains unknown or missing fields.');
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    if (typeof key !== 'string') {
      throw new TypeError('Publisher idempotency-key evaluation input must contain string data fields.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Publisher idempotency-key evaluation input members must be enumerable data properties.');
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot) as unknown as PublisherIdempotencyKeyRequirementInput;
}

/** Deep-snapshots the binding base before constructing the satisfied result. */
export function snapshotPublisherIdempotencyBindingBase(
  value: unknown,
): Omit<IdempotencyBinding, 'method' | 'key'> {
  const candidate = immutableJsonData(value, 'Publisher idempotency binding') as Record<string, unknown>;
  const requiredKeys = ['principalId', 'protocolVersion', 'endpointKey', 'resourceIdentity', 'requestDigest'] as const;
  if (
    Array.isArray(candidate)
    || !requiredKeys.every((key) => Object.hasOwn(candidate, key))
    || !requiredKeys.every((key) => typeof candidate[key] === 'string')
  ) {
    throw new TypeError('Publisher idempotency binding contains unknown or missing fields.');
  }
  return Object.freeze({
    principalId: candidate.principalId as string,
    protocolVersion: candidate.protocolVersion as string,
    endpointKey: candidate.endpointKey as string,
    resourceIdentity: candidate.resourceIdentity as string,
    requestDigest: candidate.requestDigest as string,
  });
}
