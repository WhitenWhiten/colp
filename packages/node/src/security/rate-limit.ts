import { types as nodeTypes } from 'node:util';

import { assertPlainRecord } from './input-snapshot.js';

export const PUBLIC_RATE_LIMIT_CREDENTIAL_KEY = 'credential:public' as const;

export type RateLimitAuthentication = 'anonymous' | 'authenticated';

export type RateLimitOperation =
  | 'feed-read'
  | 'read'
  | 'sync-pull'
  | 'sync-push'
  | 'write'
  | 'mcp-tool'
  | 'admin'
  | 'key-management';

export type RateLimitBucketCategory =
  | 'anonymous-feed-read'
  | 'authenticated-read'
  | 'sync-pull'
  | 'sync-push'
  | 'general-write'
  | 'mcp-tool-call'
  | 'admin-key-management';

export type RateLimitBucketId =
  | 'publisher:anonymous-feed-read'
  | 'publisher:authenticated-read'
  | 'publisher:sync-pull'
  | 'publisher:sync-push'
  | 'publisher:general-write'
  | 'publisher:mcp-tool-call'
  | 'publisher:admin-key-management';

/** Canonical publisher rate-limit bucket identifiers (exactly seven). */
export const RATE_LIMIT_BUCKET_IDS: ReadonlySet<RateLimitBucketId> = Object.freeze(
  new Set<RateLimitBucketId>([
    'publisher:anonymous-feed-read',
    'publisher:authenticated-read',
    'publisher:sync-pull',
    'publisher:sync-push',
    'publisher:general-write',
    'publisher:mcp-tool-call',
    'publisher:admin-key-management',
  ]),
);

/** Type guard for the seven canonical SEC-0012 bucket identifiers. */
export function isRateLimitBucketId(value: unknown): value is RateLimitBucketId {
  return typeof value === 'string' && (RATE_LIMIT_BUCKET_IDS as ReadonlySet<string>).has(value);
}

export interface RateLimitClassificationInput {
  readonly authentication: RateLimitAuthentication;
  readonly operation: RateLimitOperation;
}

export type RateLimitBucketDecision =
  | {
      readonly classified: true;
      readonly bucketId: RateLimitBucketId;
      readonly category: RateLimitBucketCategory;
      readonly operationSubtype: RateLimitOperation;
    }
  | {
      readonly classified: false;
      readonly reason: 'invalid_input';
    };

const invalidBucketDecision: RateLimitBucketDecision = Object.freeze({
  classified: false,
  reason: 'invalid_input',
});

const bucketDecisions = Object.freeze({
  anonymousFeedRead: Object.freeze({
    classified: true,
    bucketId: 'publisher:anonymous-feed-read',
    category: 'anonymous-feed-read',
    operationSubtype: 'feed-read',
  }),
  authenticatedFeedRead: Object.freeze({
    classified: true,
    bucketId: 'publisher:authenticated-read',
    category: 'authenticated-read',
    operationSubtype: 'feed-read',
  }),
  authenticatedRead: Object.freeze({
    classified: true,
    bucketId: 'publisher:authenticated-read',
    category: 'authenticated-read',
    operationSubtype: 'read',
  }),
  syncPull: Object.freeze({
    classified: true,
    bucketId: 'publisher:sync-pull',
    category: 'sync-pull',
    operationSubtype: 'sync-pull',
  }),
  syncPush: Object.freeze({
    classified: true,
    bucketId: 'publisher:sync-push',
    category: 'sync-push',
    operationSubtype: 'sync-push',
  }),
  generalWrite: Object.freeze({
    classified: true,
    bucketId: 'publisher:general-write',
    category: 'general-write',
    operationSubtype: 'write',
  }),
  mcpToolCall: Object.freeze({
    classified: true,
    bucketId: 'publisher:mcp-tool-call',
    category: 'mcp-tool-call',
    operationSubtype: 'mcp-tool',
  }),
  admin: Object.freeze({
    classified: true,
    bucketId: 'publisher:admin-key-management',
    category: 'admin-key-management',
    operationSubtype: 'admin',
  }),
  keyManagement: Object.freeze({
    classified: true,
    bucketId: 'publisher:admin-key-management',
    category: 'admin-key-management',
    operationSubtype: 'key-management',
  }),
} satisfies Readonly<Record<string, RateLimitBucketDecision>>);

function snapshotClassificationInput(
  input: unknown,
): RateLimitClassificationInput | undefined {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)) return undefined;

  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return undefined;

    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 2 ||
      !keys.includes('authentication') ||
      !keys.includes('operation')
    ) {
      return undefined;
    }

    const authenticationDescriptor = Object.getOwnPropertyDescriptor(input, 'authentication');
    const operationDescriptor = Object.getOwnPropertyDescriptor(input, 'operation');
    if (
      authenticationDescriptor === undefined ||
      !('value' in authenticationDescriptor) ||
      operationDescriptor === undefined ||
      !('value' in operationDescriptor)
    ) {
      return undefined;
    }

    const authentication = authenticationDescriptor.value as unknown;
    const operation = operationDescriptor.value as unknown;
    if (authentication !== 'anonymous' && authentication !== 'authenticated') return undefined;
    if (
      operation !== 'feed-read' &&
      operation !== 'read' &&
      operation !== 'sync-pull' &&
      operation !== 'sync-push' &&
      operation !== 'write' &&
      operation !== 'mcp-tool' &&
      operation !== 'admin' &&
      operation !== 'key-management'
    ) {
      return undefined;
    }

    return Object.freeze({ authentication, operation });
  } catch {
    return undefined;
  }
}

/** Classify a trusted authentication result and semantic publisher operation. */
export function classifyRateLimitBucket(input: unknown): RateLimitBucketDecision {
  const snapshot = snapshotClassificationInput(input);
  if (snapshot === undefined) return invalidBucketDecision;

  if (snapshot.authentication === 'anonymous') {
    return snapshot.operation === 'feed-read'
      ? bucketDecisions.anonymousFeedRead
      : invalidBucketDecision;
  }

  switch (snapshot.operation) {
    case 'feed-read':
      return bucketDecisions.authenticatedFeedRead;
    case 'read':
      return bucketDecisions.authenticatedRead;
    case 'sync-pull':
      return bucketDecisions.syncPull;
    case 'sync-push':
      return bucketDecisions.syncPush;
    case 'write':
      return bucketDecisions.generalWrite;
    case 'mcp-tool':
      return bucketDecisions.mcpToolCall;
    case 'admin':
      return bucketDecisions.admin;
    case 'key-management':
      return bucketDecisions.keyManagement;
  }
}

export type RateLimitDimension = 'credential' | 'ip' | 'instance';

export interface RateLimitCeilingConfiguration {
  readonly policy: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitCeilings {
  readonly credential: RateLimitCeilingConfiguration;
  readonly ip: RateLimitCeilingConfiguration;
  readonly instance: RateLimitCeilingConfiguration;
}

export interface AtomicRateLimitRequest {
  readonly bucket: RateLimitBucketId;
  readonly cost: number;
  readonly credentialId?: string;
  readonly ipAddress: string;
  readonly instanceId: string;
  readonly ceilings: RateLimitCeilings;
}

export interface AtomicRateLimitCeiling {
  readonly dimension: RateLimitDimension;
  readonly key: string;
  readonly policy: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface AtomicRateLimitCharge {
  readonly bucket: RateLimitBucketId;
  readonly cost: number;
  readonly ceilings: readonly [AtomicRateLimitCeiling, AtomicRateLimitCeiling, AtomicRateLimitCeiling];
}

export interface AtomicRateLimitCeilingResult {
  readonly dimension: RateLimitDimension;
  readonly key: string;
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetSeconds: number;
}

export interface AtomicRateLimitResult {
  readonly ceilings: readonly AtomicRateLimitCeilingResult[];
}

/** The implementation must charge all three supplied ceilings in one atomic operation. */
export interface AtomicRateLimitPort {
  charge(input: AtomicRateLimitCharge): Promise<AtomicRateLimitResult>;
}

export interface RateLimitFields {
  readonly policy: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
  readonly windowSeconds: number;
}

export interface GoverningRateLimitCeiling extends AtomicRateLimitCeilingResult {
  readonly policy: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export type RateLimitDecision =
  | {
      readonly allowed: true;
      readonly reason: 'allowed';
      readonly governing: GoverningRateLimitCeiling;
      readonly ceilings: readonly AtomicRateLimitCeilingResult[];
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly allowed: false;
      readonly reason: 'limited';
      readonly governing: GoverningRateLimitCeiling;
      readonly ceilings: readonly AtomicRateLimitCeilingResult[];
      readonly headers: Readonly<Record<string, string>>;
      readonly retryAfterSeconds: number;
    }
  | {
      readonly allowed: false;
      readonly reason: 'invalid_result';
      readonly ceilings: readonly AtomicRateLimitCeilingResult[];
    };

export interface EnforceRateLimitForOperationInput {
  readonly authentication: RateLimitAuthentication;
  readonly operation: RateLimitOperation;
  readonly cost: number;
  readonly credentialId?: string;
  readonly ipAddress: string;
  readonly instanceId: string;
  readonly ceilings: RateLimitCeilings;
}

export type EnforceRateLimitForOperationResult =
  | RateLimitDecision
  | { readonly allowed: false; readonly reason: 'invalid_classification' };

const invalidClassificationResult: Extract<
  EnforceRateLimitForOperationResult,
  { readonly reason: 'invalid_classification' }
> = Object.freeze({
  allowed: false,
  reason: 'invalid_classification',
});

const dimensions = ['credential', 'ip', 'instance'] as const;
const structuredFieldString = /^[\x20-\x7e]*$/u;
const MAX_STRUCTURED_FIELD_INTEGER = 999_999_999_999_999;

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveStructuredFieldInteger(value: number, name: string): void {
  assertPositiveSafeInteger(value, name);
  if (value > MAX_STRUCTURED_FIELD_INTEGER) {
    throw new TypeError(`${name} exceeds the RFC 9651 integer range`);
  }
}

function assertNonNegativeStructuredFieldInteger(value: number, name: string): void {
  assertNonNegativeSafeInteger(value, name);
  if (value > MAX_STRUCTURED_FIELD_INTEGER) {
    throw new TypeError(`${name} exceeds the RFC 9651 integer range`);
  }
}

function assertNonEmptyKey(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty string without control characters`);
  }
}

function quoteStructuredFieldString(value: string): string {
  if (typeof value !== 'string' || !structuredFieldString.test(value)) {
    throw new TypeError('policy must be an RFC 9651 structured field string');
  }
  // Callers provide the bare policy item; reject values already wrapped in
  // structured-string quotes to avoid double-quoting ambiguous input.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    throw new TypeError('policy must not be pre-quoted');
  }
  return `"${value.replace(/(["\\])/gu, '\\$1')}"`;
}

/**
 * Serialize RFC 9651 fields from a bare structured-field item.
 *
 * `policy` must be the unquoted item content; this function owns quoting and
 * escaping. Pre-quoted values are rejected to avoid accepting ambiguous or
 * double-serialized header input. Legacy X-RateLimit headers are omitted.
 */
export function serializeRateLimitFields(input: RateLimitFields): Readonly<Record<string, string>> {
  const policy = quoteStructuredFieldString(input.policy);
  assertPositiveStructuredFieldInteger(input.limit, 'limit');
  assertNonNegativeStructuredFieldInteger(input.remaining, 'remaining');
  assertNonNegativeStructuredFieldInteger(input.resetSeconds, 'resetSeconds');
  assertPositiveStructuredFieldInteger(input.windowSeconds, 'windowSeconds');
  if (input.remaining > input.limit) {
    throw new TypeError('remaining must not exceed limit');
  }
  return Object.freeze({
    RateLimit: `${policy};r=${input.remaining};t=${input.resetSeconds}`,
    'RateLimit-Policy': `${policy};q=${input.limit};w=${input.windowSeconds}`,
  });
}

function createCeiling(
  dimension: RateLimitDimension,
  key: string,
  configuration: unknown,
): AtomicRateLimitCeiling {
  assertRateLimitPlainRecord(configuration, `${dimension} ceiling`);
  const policy = requireOwnDataProperty(configuration, 'policy', `${dimension} policy`);
  const limit = requireOwnDataProperty(configuration, 'limit', `${dimension} limit`);
  const windowSeconds = requireOwnDataProperty(
    configuration,
    'windowSeconds',
    `${dimension} windowSeconds`,
  );
  assertNonEmptyKey(key, `${dimension} key`);
  if (typeof policy !== 'string') {
    throw new TypeError(`${dimension} policy must be a string`);
  }
  if (typeof limit !== 'number') {
    throw new TypeError(`${dimension} limit must be a number`);
  }
  if (typeof windowSeconds !== 'number') {
    throw new TypeError(`${dimension} windowSeconds must be a number`);
  }
  quoteStructuredFieldString(policy);
  assertPositiveStructuredFieldInteger(limit, `${dimension} limit`);
  assertPositiveStructuredFieldInteger(windowSeconds, `${dimension} windowSeconds`);
  return Object.freeze({
    dimension,
    key,
    policy,
    limit,
    windowSeconds,
  });
}

function createCharge(input: AtomicRateLimitRequest): AtomicRateLimitCharge {
  assertRateLimitPlainRecord(input, 'rate limit request');
  const bucket = requireOwnDataProperty(input, 'bucket', 'bucket');
  const cost = requireOwnDataProperty(input, 'cost', 'cost');
  const credentialId = readOptionalOwnDataProperty(input, 'credentialId', 'credentialId');
  const ipAddress = requireOwnDataProperty(input, 'ipAddress', 'ipAddress');
  const instanceId = requireOwnDataProperty(input, 'instanceId', 'instanceId');
  const configuredCeilings = requireOwnDataProperty(input, 'ceilings', 'ceilings');
  assertRateLimitPlainRecord(configuredCeilings, 'ceilings');
  if (!isRateLimitBucketId(bucket)) {
    throw new TypeError('bucket must be a canonical RateLimitBucketId');
  }
  if (typeof cost !== 'number') throw new TypeError('cost must be a number');
  if (credentialId !== undefined && typeof credentialId !== 'string') {
    throw new TypeError('credentialId must be a string');
  }
  if (typeof ipAddress !== 'string') throw new TypeError('ipAddress must be a string');
  if (typeof instanceId !== 'string') throw new TypeError('instanceId must be a string');
  assertPositiveSafeInteger(cost, 'cost');
  assertNonEmptyKey(ipAddress, 'ipAddress');
  assertNonEmptyKey(instanceId, 'instanceId');
  if (credentialId !== undefined) {
    assertNonEmptyKey(credentialId, 'credentialId');
  }

  const credentialKey =
    credentialId === undefined ? PUBLIC_RATE_LIMIT_CREDENTIAL_KEY : `credential:id:${credentialId}`;
  const ceilings = Object.freeze([
    createCeiling(
      'credential',
      credentialKey,
      requireOwnDataProperty(configuredCeilings, 'credential', 'credential ceiling'),
    ),
    createCeiling('ip', `ip:${ipAddress}`, requireOwnDataProperty(configuredCeilings, 'ip', 'ip ceiling')),
    createCeiling(
      'instance',
      `instance:${instanceId}`,
      requireOwnDataProperty(configuredCeilings, 'instance', 'instance ceiling'),
    ),
  ] as const);

  return Object.freeze({ bucket, cost, ceilings });
}

/** isProxy first so revoked proxies never reach Array.isArray or property traps. */
function assertRateLimitPlainRecord(value: unknown, name: string): void {
  if (typeof value === 'object' && value !== null && nodeTypes.isProxy(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  assertPlainRecord(value, name);
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !nodeTypes.isProxy(value) && !Array.isArray(value);
}

function getOwnDataPropertyDescriptor(
  value: unknown,
  key: PropertyKey,
  name: string,
): PropertyDescriptor | undefined {
  if (!isRecord(value)) {
    throw new TypeError(`${name} must be supplied in an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor !== undefined && !('value' in descriptor)) {
    throw new TypeError(`${name} must be an own data property`);
  }
  return descriptor;
}

function requireOwnDataProperty(value: unknown, key: PropertyKey, name: string): unknown {
  const descriptor = getOwnDataPropertyDescriptor(value, key, name);
  if (descriptor === undefined) {
    throw new TypeError(`${name} is required`);
  }
  return descriptor.value;
}

function readOptionalOwnDataProperty(value: unknown, key: PropertyKey, name: string): unknown {
  return getOwnDataPropertyDescriptor(value, key, name)?.value;
}

function readOwnDataProperty(value: unknown, key: PropertyKey): unknown {
  if (!isRecord(value) && !Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function snapshotResultArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || lengthDescriptor.value !== dimensions.length) {
    return undefined;
  }
  const indexes = Reflect.ownKeys(value).filter(
    (key): key is string => typeof key === 'string' && /^(?:0|[1-9]\d*)$/u.test(key),
  );
  if (indexes.length !== dimensions.length) return undefined;
  const snapshot: unknown[] = [];
  for (let index = 0; index < dimensions.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function readResults(
  result: unknown,
  charge: AtomicRateLimitCharge,
): readonly AtomicRateLimitCeilingResult[] | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const rawCeilings = snapshotResultArray(readOwnDataProperty(result, 'ceilings'));
  if (rawCeilings === undefined) return undefined;

  const parsed: AtomicRateLimitCeilingResult[] = [];
  for (let index = 0; index < dimensions.length; index += 1) {
    const candidate: unknown = rawCeilings[index];
    if (!isRecord(candidate)) return undefined;
    const dimension = readOwnDataProperty(candidate, 'dimension');
    const key = readOwnDataProperty(candidate, 'key');
    const allowed = readOwnDataProperty(candidate, 'allowed');
    const remaining = readOwnDataProperty(candidate, 'remaining');
    const resetSeconds = readOwnDataProperty(candidate, 'resetSeconds');
    const ceiling = charge.ceilings[index];
    if (
      ceiling === undefined ||
      dimension !== dimensions[index] ||
      key !== ceiling.key ||
      typeof allowed !== 'boolean' ||
      typeof remaining !== 'number' ||
      typeof resetSeconds !== 'number'
    ) {
      return undefined;
    }
    if (
      remaining > MAX_STRUCTURED_FIELD_INTEGER ||
      !Number.isSafeInteger(remaining) ||
      remaining < 0 ||
      remaining > ceiling.limit ||
      resetSeconds > MAX_STRUCTURED_FIELD_INTEGER ||
      !Number.isSafeInteger(resetSeconds) ||
      resetSeconds < 0
    ) {
      return undefined;
    }
    parsed.push(
      Object.freeze({
        dimension: ceiling.dimension,
        key: ceiling.key,
        allowed,
        remaining,
        resetSeconds,
      }),
    );
  }
  return Object.freeze(parsed);
}

function selectGoverning(
  results: readonly AtomicRateLimitCeilingResult[],
  charge: AtomicRateLimitCharge,
): { readonly result: AtomicRateLimitCeilingResult; readonly ceiling: AtomicRateLimitCeiling } {
  const byDimension = new Map(charge.ceilings.map((ceiling) => [ceiling.dimension, ceiling]));
  const sorted = [...results].sort((left, right) => {
    if (left.allowed !== right.allowed) return left.allowed ? 1 : -1;
    if (!left.allowed && left.resetSeconds !== right.resetSeconds) return right.resetSeconds - left.resetSeconds;
    const leftCeiling = byDimension.get(left.dimension)!;
    const rightCeiling = byDimension.get(right.dimension)!;
    const leftRatio = BigInt(left.remaining) * BigInt(rightCeiling.limit);
    const rightRatio = BigInt(right.remaining) * BigInt(leftCeiling.limit);
    if (leftRatio !== rightRatio) return leftRatio < rightRatio ? -1 : 1;
    if (left.resetSeconds !== right.resetSeconds) return right.resetSeconds - left.resetSeconds;
    return dimensions.indexOf(left.dimension) - dimensions.indexOf(right.dimension);
  });
  const result = sorted[0]!;
  return { result, ceiling: byDimension.get(result.dimension)! };
}

/**
 * Atomically charge credential, IP, and instance ceilings and fail closed on any
 * port exception or incomplete, duplicate, unknown, or malformed result.
 * `input.bucket` must be one of the seven canonical {@link RateLimitBucketId} values.
 */
export async function enforceRateLimit(
  port: AtomicRateLimitPort,
  input: AtomicRateLimitRequest,
): Promise<RateLimitDecision> {
  const charge = createCharge(input);
  let rawResult: unknown;
  try {
    rawResult = await port.charge(charge);
  } catch {
    return Object.freeze({ allowed: false, reason: 'invalid_result', ceilings: Object.freeze([]) });
  }

  let results: readonly AtomicRateLimitCeilingResult[] | undefined;
  try {
    results = readResults(rawResult, charge);
  } catch {
    results = undefined;
  }
  if (results === undefined) {
    return Object.freeze({ allowed: false, reason: 'invalid_result', ceilings: Object.freeze([]) });
  }

  const governing = selectGoverning(results, charge);
  const governingCeiling: GoverningRateLimitCeiling = Object.freeze({
    ...governing.result,
    policy: governing.ceiling.policy,
    limit: governing.ceiling.limit,
    windowSeconds: governing.ceiling.windowSeconds,
  });
  const headers = serializeRateLimitFields({
    policy: governing.ceiling.policy,
    limit: governing.ceiling.limit,
    remaining: governing.result.remaining,
    resetSeconds: governing.result.resetSeconds,
    windowSeconds: governing.ceiling.windowSeconds,
  });
  const allowed = results.every((result) => result.allowed);
  if (!allowed) {
    return Object.freeze({
      allowed: false,
      reason: 'limited',
      governing: governingCeiling,
      ceilings: results,
      headers,
      retryAfterSeconds: governing.result.resetSeconds,
    });
  }
  return Object.freeze({
    allowed: true,
    reason: 'allowed',
    governing: governingCeiling,
    ceilings: results,
    headers,
  });
}

const operationEnforceRequiredKeys = Object.freeze([
  'authentication',
  'operation',
  'cost',
  'ipAddress',
  'instanceId',
  'ceilings',
] as const);

const operationEnforceAllowedKeys = Object.freeze(
  new Set<PropertyKey>([...operationEnforceRequiredKeys, 'credentialId']),
);

/**
 * Classify authentication + operation into a canonical SEC-0012 bucket, then charge.
 * Does not accept a caller-supplied free-form bucket; fail closed when classification rejects.
 * Unexpected own keys (e.g. forged `bucket` / `principal`) fail closed without charging.
 */
export async function enforceRateLimitForOperation(
  port: AtomicRateLimitPort,
  input: EnforceRateLimitForOperationInput,
): Promise<EnforceRateLimitForOperationResult> {
  if (typeof input !== 'object' || input === null || nodeTypes.isProxy(input)) {
    return invalidClassificationResult;
  }

  let keys: PropertyKey[];
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidClassificationResult;
    }
    keys = Reflect.ownKeys(input);
  } catch {
    return invalidClassificationResult;
  }

  for (const key of keys) {
    if (!operationEnforceAllowedKeys.has(key)) {
      return invalidClassificationResult;
    }
  }
  for (const required of operationEnforceRequiredKeys) {
    if (!keys.includes(required)) {
      return invalidClassificationResult;
    }
  }

  let authentication: unknown;
  let operation: unknown;
  let cost: unknown;
  let credentialId: unknown;
  let ipAddress: unknown;
  let instanceId: unknown;
  let ceilings: unknown;
  try {
    authentication = requireOwnDataProperty(input, 'authentication', 'authentication');
    operation = requireOwnDataProperty(input, 'operation', 'operation');
    cost = requireOwnDataProperty(input, 'cost', 'cost');
    credentialId = readOptionalOwnDataProperty(input, 'credentialId', 'credentialId');
    ipAddress = requireOwnDataProperty(input, 'ipAddress', 'ipAddress');
    instanceId = requireOwnDataProperty(input, 'instanceId', 'instanceId');
    ceilings = requireOwnDataProperty(input, 'ceilings', 'ceilings');
  } catch {
    return invalidClassificationResult;
  }

  // Classifier accepts only a plain object with authentication + operation.
  const classification = classifyRateLimitBucket(
    Object.freeze({ authentication, operation }),
  );
  if (!classification.classified) {
    return invalidClassificationResult;
  }

  const chargeRequest: AtomicRateLimitRequest =
    credentialId === undefined
      ? Object.freeze({
          bucket: classification.bucketId,
          cost: cost as number,
          ipAddress: ipAddress as string,
          instanceId: instanceId as string,
          ceilings: ceilings as RateLimitCeilings,
        })
      : Object.freeze({
          bucket: classification.bucketId,
          cost: cost as number,
          credentialId: credentialId as string,
          ipAddress: ipAddress as string,
          instanceId: instanceId as string,
          ceilings: ceilings as RateLimitCeilings,
        });

  return enforceRateLimit(port, chargeRequest);
}
