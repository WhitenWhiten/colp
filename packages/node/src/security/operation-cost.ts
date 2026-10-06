import { types as nodeTypes } from 'node:util';

import { inspectExactDenseArray } from './dense-array.js';

export const MAX_EXPANDED_OPERATIONS = 100_000 as const;

export const PUBLISHER_OPERATION_WEIGHTS = Object.freeze({
  read: 1,
  write: 2,
  batch: 2,
  'sync-push': 3,
  'mcp-tool': 4,
} as const);

export type PublisherOperationKind = keyof typeof PUBLISHER_OPERATION_WEIGHTS;

export interface ExpandedPublisherOperation {
  readonly kind: PublisherOperationKind;
  readonly affectedObjects: number;
  readonly writeObjects: number;
}

export type ExpandedOperationCostDecision =
  | {
      readonly calculated: true;
      readonly cost: number;
      readonly affectedObjects: number;
      readonly writeObjects: number;
      readonly operationCount: number;
    }
  | {
      readonly calculated: false;
      readonly reason: 'invalid_input';
    };

interface ExpandedOperationCostSnapshot {
  readonly cost: number;
  readonly affectedObjects: number;
  readonly writeObjects: number;
  readonly operationCount: number;
}

const invalidCostDecision: ExpandedOperationCostDecision = Object.freeze({
  calculated: false,
  reason: 'invalid_input',
});

const publisherOperationKinds = new Set<PublisherOperationKind>([
  'read',
  'write',
  'batch',
  'sync-push',
  'mcp-tool',
]);

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectProxy(value: unknown, name: string): void {
  if (nodeTypes.isProxy(value)) throw new TypeError(`${name} must not be a Proxy`);
}

function assertPlainRecord(value: unknown, name: string): asserts value is Readonly<Record<PropertyKey, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${name} must be supplied in an object`);
  rejectProxy(value, name);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must have a plain prototype`);
  }
}

function requireExactOwnKeys(value: unknown, expected: readonly string[], name: string): void {
  assertPlainRecord(value, name);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw new TypeError(`${name} has missing or unknown fields`);
  }
}

function requiredData(value: unknown, key: string, name: string): unknown {
  assertPlainRecord(value, name);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`${name}.${key} must be an own data property`);
  }
  return descriptor.value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function addSafe(left: number, right: number, name: string): number {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new TypeError(`${name} exceeds the safe integer range`);
  }
  return left + right;
}

function multiplySafe(left: number, right: number, name: string): number {
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new TypeError(`${name} exceeds the safe integer range`);
  }
  return left * right;
}

function boundedString(value: unknown, name: string, maximumLength = 1_024): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a bounded non-empty string without control characters`);
  }
  return value;
}

function snapshotDenseArray(value: unknown, name: string): readonly unknown[] {
  const result = inspectExactDenseArray(value, {
    minLength: 1,
    maxLength: MAX_EXPANDED_OPERATIONS,
    allowExtraOwnKeys: false,
    requireStandardPrototype: true,
  });
  if (!result.ok) {
    switch (result.failure) {
      case 'not-array':
        throw new TypeError(`${name} must be an array`);
      case 'proxy':
        throw new TypeError(`${name} must not be a Proxy`);
      case 'custom-prototype':
        throw new TypeError(`${name} must have the standard array prototype`);
      case 'invalid-length':
        throw new TypeError(`${name} has an invalid or excessive length`);
      case 'not-dense':
      case 'extra-keys':
        throw new TypeError(`${name} must be dense and contain no extra properties`);
      case 'non-data-entry':
        throw new TypeError(`${name} entries must be own data properties`);
    }
  }
  return Object.freeze(result.values);
}

function calculateCostSnapshot(value: unknown): ExpandedOperationCostSnapshot {
  const operations = snapshotDenseArray(value, 'expanded operations');
  let cost = 0;
  let affectedObjects = 0;
  let writeObjects = 0;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const name = `expanded operations[${index}]`;
    requireExactOwnKeys(operation, ['kind', 'affectedObjects', 'writeObjects'], name);
    const rawKind = requiredData(operation, 'kind', name);
    if (typeof rawKind !== 'string' || !publisherOperationKinds.has(rawKind as PublisherOperationKind)) {
      throw new TypeError(`${name}.kind is unknown`);
    }
    const kind = rawKind as PublisherOperationKind;
    const affected = positiveSafeInteger(requiredData(operation, 'affectedObjects', name), `${name}.affectedObjects`);
    const writes = nonNegativeSafeInteger(requiredData(operation, 'writeObjects', name), `${name}.writeObjects`);
    if (writes > affected || (kind === 'read' && writes !== 0)) {
      throw new TypeError(`${name}.writeObjects is inconsistent with the semantic operation`);
    }
    if ((kind === 'write' || kind === 'sync-push') && writes !== affected) {
      throw new TypeError(`${name} must debit every affected write object`);
    }
    const weightedCost = multiplySafe(
      PUBLISHER_OPERATION_WEIGHTS[kind],
      affected,
      `${name} weighted cost`,
    );
    cost = addSafe(cost, weightedCost, 'expanded operation cost');
    affectedObjects = addSafe(affectedObjects, affected, 'affected object count');
    writeObjects = addSafe(writeObjects, writes, 'write object count');
  }

  return Object.freeze({ cost, affectedObjects, writeObjects, operationCount: operations.length });
}

/**
 * Calculate cost only from expanded semantic operations. With no per-request
 * term, every partition of the same operation list has the same summed cost.
 */
export function calculateExpandedOperationCost(value: unknown): ExpandedOperationCostDecision {
  try {
    let operations = value;
    if (!Array.isArray(value)) {
      requireExactOwnKeys(value, ['operations'], 'expanded operation input');
      operations = requiredData(value, 'operations', 'expanded operation input');
    }
    return Object.freeze({ calculated: true, ...calculateCostSnapshot(operations) });
  } catch {
    return invalidCostDecision;
  }
}

export type PublisherIdentityKind = 'subject' | 'credential';
export type PublisherAdmissionDimension = 'subject-credential' | 'ip' | 'instance';

export interface PublisherIdentity {
  readonly kind: PublisherIdentityKind;
  readonly id: string;
}

export interface PublisherCeilingConfiguration {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface PublisherAdmissionCeilings {
  readonly subjectCredential: PublisherCeilingConfiguration;
  readonly ip: PublisherCeilingConfiguration;
  readonly instance: PublisherCeilingConfiguration;
}

export interface PublisherWriteGrant {
  readonly id: string;
  readonly maxWrites: number;
}

export interface PublisherAdmissionRequest {
  readonly bucket: string;
  readonly identity: PublisherIdentity;
  readonly ipAddress: string;
  readonly instanceId: string;
  readonly ceilings: PublisherAdmissionCeilings;
  readonly operations: readonly ExpandedPublisherOperation[];
  readonly grant: PublisherWriteGrant | null;
}

export interface AtomicPublisherCeiling {
  readonly dimension: PublisherAdmissionDimension;
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export type AtomicPublisherGrantDebit =
  | { readonly kind: 'none'; readonly writeDebit: 0 }
  | {
      readonly kind: 'grant';
      readonly grantId: string;
      readonly maxWrites: number;
      readonly writeDebit: number;
    };

export interface AtomicPublisherAdmission {
  readonly bucket: string;
  readonly cost: number;
  readonly affectedObjects: number;
  readonly ceilings: readonly [AtomicPublisherCeiling, AtomicPublisherCeiling, AtomicPublisherCeiling];
  readonly grant: AtomicPublisherGrantDebit;
}

export interface AtomicPublisherCeilingResult {
  readonly dimension: PublisherAdmissionDimension;
  readonly key: string;
  readonly allowed: boolean;
  readonly remaining: number;
  readonly debitedCost: number;
}

export type AtomicPublisherGrantResult =
  | { readonly kind: 'none'; readonly allowed: boolean; readonly debitedWrites: number }
  | {
      readonly kind: 'grant';
      readonly grantId: string;
      readonly allowed: boolean;
      readonly remainingWrites: number;
      readonly debitedWrites: number;
    };

export interface AtomicPublisherAdmissionResult {
  readonly committed: boolean;
  readonly ceilings: readonly AtomicPublisherCeilingResult[];
  readonly grant: AtomicPublisherGrantResult;
}

/** Implementations must check and debit every ceiling and the Grant in one transaction. */
export interface AtomicPublisherAdmissionPort {
  checkAndConsume(input: AtomicPublisherAdmission): Promise<AtomicPublisherAdmissionResult>;
}

export type PublisherAdmissionDecision =
  | { readonly allowed: true; readonly reason: 'allowed' }
  | { readonly allowed: false; readonly reason: 'denied' | 'invalid_input' | 'invalid_result' };

const publisherAdmissionDecisions = Object.freeze({
  allowed: Object.freeze({ allowed: true, reason: 'allowed' } as const),
  denied: Object.freeze({ allowed: false, reason: 'denied' } as const),
  invalidInput: Object.freeze({ allowed: false, reason: 'invalid_input' } as const),
  invalidResult: Object.freeze({ allowed: false, reason: 'invalid_result' } as const),
});

const publisherDimensions = ['subject-credential', 'ip', 'instance'] as const;

function snapshotCeiling(
  value: unknown,
  dimension: PublisherAdmissionDimension,
  key: string,
  name: string,
): AtomicPublisherCeiling {
  requireExactOwnKeys(value, ['limit', 'windowSeconds'], name);
  return Object.freeze({
    dimension,
    key,
    limit: positiveSafeInteger(requiredData(value, 'limit', name), `${name}.limit`),
    windowSeconds: positiveSafeInteger(
      requiredData(value, 'windowSeconds', name),
      `${name}.windowSeconds`,
    ),
  });
}

function snapshotPublisherAdmission(value: unknown): AtomicPublisherAdmission {
  requireExactOwnKeys(
    value,
    ['bucket', 'identity', 'ipAddress', 'instanceId', 'ceilings', 'operations', 'grant'],
    'publisher admission request',
  );
  const bucket = boundedString(requiredData(value, 'bucket', 'publisher admission request'), 'bucket', 256);
  const identity = requiredData(value, 'identity', 'publisher admission request');
  requireExactOwnKeys(identity, ['kind', 'id'], 'publisher identity');
  const identityKind = requiredData(identity, 'kind', 'publisher identity');
  if (identityKind !== 'subject' && identityKind !== 'credential') {
    throw new TypeError('publisher identity kind must be subject or credential');
  }
  const identityId = boundedString(requiredData(identity, 'id', 'publisher identity'), 'publisher identity id');
  const ipAddress = boundedString(
    requiredData(value, 'ipAddress', 'publisher admission request'),
    'IP address',
    128,
  );
  const instanceId = boundedString(
    requiredData(value, 'instanceId', 'publisher admission request'),
    'instance id',
  );
  const cost = calculateCostSnapshot(requiredData(value, 'operations', 'publisher admission request'));
  const configuredCeilings = requiredData(value, 'ceilings', 'publisher admission request');
  requireExactOwnKeys(configuredCeilings, ['subjectCredential', 'ip', 'instance'], 'publisher ceilings');
  const ceilings = Object.freeze([
    snapshotCeiling(
      requiredData(configuredCeilings, 'subjectCredential', 'publisher ceilings'),
      'subject-credential',
      `${identityKind}:${identityId}`,
      'subject/credential ceiling',
    ),
    snapshotCeiling(
      requiredData(configuredCeilings, 'ip', 'publisher ceilings'),
      'ip',
      `ip:${ipAddress}`,
      'IP ceiling',
    ),
    snapshotCeiling(
      requiredData(configuredCeilings, 'instance', 'publisher ceilings'),
      'instance',
      `instance:${instanceId}`,
      'instance ceiling',
    ),
  ] as const);

  const rawGrant = requiredData(value, 'grant', 'publisher admission request');
  let grant: AtomicPublisherGrantDebit;
  if (rawGrant === null) {
    if (cost.writeObjects !== 0) throw new TypeError('write operations require a Grant');
    grant = Object.freeze({ kind: 'none', writeDebit: 0 });
  } else {
    requireExactOwnKeys(rawGrant, ['id', 'maxWrites'], 'publisher write Grant');
    grant = Object.freeze({
      kind: 'grant',
      grantId: boundedString(requiredData(rawGrant, 'id', 'publisher write Grant'), 'Grant id'),
      maxWrites: nonNegativeSafeInteger(
        requiredData(rawGrant, 'maxWrites', 'publisher write Grant'),
        'Grant maxWrites',
      ),
      writeDebit: cost.writeObjects,
    });
  }
  return Object.freeze({
    bucket,
    cost: cost.cost,
    affectedObjects: cost.affectedObjects,
    ceilings,
    grant,
  });
}

function snapshotPortMethod(port: unknown, methodName: string, portName: string): (input: unknown) => unknown {
  if (!isRecord(port)) throw new TypeError(`${portName} must be supplied in an object`);
  rejectProxy(port, portName);
  let owner: object | null = port;
  while (owner !== null && owner !== Object.prototype) {
    rejectProxy(owner, `${portName} prototype`);
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new TypeError(`${portName}.${methodName} must be a data method`);
      }
      rejectProxy(descriptor.value, `${portName}.${methodName}`);
      const method = descriptor.value as (input: unknown) => unknown;
      return (input: unknown) => Reflect.apply(method, port, [input]);
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  throw new TypeError(`${portName}.${methodName} is required`);
}

async function invokeNativePromise(method: (input: unknown) => unknown, input: unknown): Promise<unknown> {
  const pending = method(input);
  if (!nodeTypes.isPromise(pending) || nodeTypes.isProxy(pending)) {
    throw new TypeError('security ports must return a native Promise');
  }
  if (Object.getOwnPropertyDescriptor(pending, 'constructor') !== undefined) {
    throw new TypeError('security ports must return an unmodified base Promise');
  }
  const promisePrototype = Object.getPrototypeOf(pending) as object | null;
  if (promisePrototype === null || nodeTypes.isProxy(promisePrototype)) {
    throw new TypeError('security ports must return an unmodified base Promise');
  }
  const objectPrototype = Object.getPrototypeOf(promisePrototype) as object | null;
  if (objectPrototype === null || Object.getPrototypeOf(objectPrototype) !== null) {
    throw new TypeError('security port Promise subclasses are not accepted');
  }
  const thenDescriptor = Object.getOwnPropertyDescriptor(promisePrototype, 'then');
  const constructorDescriptor = Object.getOwnPropertyDescriptor(promisePrototype, 'constructor');
  if (
    thenDescriptor === undefined ||
    !('value' in thenDescriptor) ||
    typeof thenDescriptor.value !== 'function' ||
    constructorDescriptor === undefined ||
    !('value' in constructorDescriptor) ||
    typeof constructorDescriptor.value !== 'function' ||
    nodeTypes.isProxy(thenDescriptor.value) ||
    nodeTypes.isProxy(constructorDescriptor.value) ||
    !Function.prototype.toString.call(thenDescriptor.value).includes('[native code]') ||
    !Function.prototype.toString.call(constructorDescriptor.value).includes('[native code]')
  ) {
    throw new TypeError('security ports must return an unmodified base Promise');
  }
  return new Promise<unknown>((resolve, reject) => {
    Reflect.apply(thenDescriptor.value, pending, [resolve, reject]);
  });
}

function snapshotFixedArray(value: unknown, length: number, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  rejectProxy(value, name);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) {
    throw new TypeError(`${name} must have the standard array prototype`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor) || lengthDescriptor.value !== length) {
    throw new TypeError(`${name} has the wrong length`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) throw new TypeError(`${name} must be dense and exact`);
  const snapshot: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${name} entries must be own data properties`);
    }
    snapshot[index] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function validatePublisherResult(value: unknown, charge: AtomicPublisherAdmission): boolean {
  requireExactOwnKeys(value, ['committed', 'ceilings', 'grant'], 'publisher admission result');
  const committed = requiredData(value, 'committed', 'publisher admission result');
  if (typeof committed !== 'boolean') throw new TypeError('publisher admission committed must be boolean');
  const rawCeilings = snapshotFixedArray(
    requiredData(value, 'ceilings', 'publisher admission result'),
    publisherDimensions.length,
    'publisher ceiling results',
  );
  let allAllowed = true;
  for (let index = 0; index < publisherDimensions.length; index += 1) {
    const result = rawCeilings[index];
    const name = `publisher ceiling results[${index}]`;
    requireExactOwnKeys(result, ['dimension', 'key', 'allowed', 'remaining', 'debitedCost'], name);
    const ceiling = charge.ceilings[index];
    if (
      ceiling === undefined ||
      requiredData(result, 'dimension', name) !== ceiling.dimension ||
      requiredData(result, 'key', name) !== ceiling.key
    ) {
      throw new TypeError(`${name} does not match the charged ceiling`);
    }
    const allowed = requiredData(result, 'allowed', name);
    const remaining = nonNegativeSafeInteger(requiredData(result, 'remaining', name), `${name}.remaining`);
    const debitedCost = nonNegativeSafeInteger(
      requiredData(result, 'debitedCost', name),
      `${name}.debitedCost`,
    );
    if (typeof allowed !== 'boolean' || remaining > ceiling.limit) {
      throw new TypeError(`${name} is malformed`);
    }
    if (debitedCost !== (committed ? charge.cost : 0)) {
      throw new TypeError(`${name} reports a partial or incorrect debit`);
    }
    allAllowed = allAllowed && allowed;
  }

  const grantResult = requiredData(value, 'grant', 'publisher admission result');
  let grantAllowed: boolean;
  if (charge.grant.kind === 'none') {
    requireExactOwnKeys(grantResult, ['kind', 'allowed', 'debitedWrites'], 'publisher Grant result');
    grantAllowed = requiredData(grantResult, 'allowed', 'publisher Grant result') as boolean;
    if (
      requiredData(grantResult, 'kind', 'publisher Grant result') !== 'none' ||
      typeof grantAllowed !== 'boolean' ||
      grantAllowed !== true ||
      requiredData(grantResult, 'debitedWrites', 'publisher Grant result') !== 0
    ) {
      throw new TypeError('publisher no-Grant result is malformed');
    }
  } else {
    requireExactOwnKeys(
      grantResult,
      ['kind', 'grantId', 'allowed', 'remainingWrites', 'debitedWrites'],
      'publisher Grant result',
    );
    grantAllowed = requiredData(grantResult, 'allowed', 'publisher Grant result') as boolean;
    const remainingWrites = nonNegativeSafeInteger(
      requiredData(grantResult, 'remainingWrites', 'publisher Grant result'),
      'publisher Grant remainingWrites',
    );
    if (
      requiredData(grantResult, 'kind', 'publisher Grant result') !== 'grant' ||
      requiredData(grantResult, 'grantId', 'publisher Grant result') !== charge.grant.grantId ||
      typeof grantAllowed !== 'boolean' ||
      remainingWrites > charge.grant.maxWrites ||
      (committed && remainingWrites > charge.grant.maxWrites - charge.grant.writeDebit) ||
      requiredData(grantResult, 'debitedWrites', 'publisher Grant result') !==
        (committed ? charge.grant.writeDebit : 0)
    ) {
      throw new TypeError('publisher Grant result is malformed or partially debited');
    }
  }
  if (committed !== (allAllowed && grantAllowed)) {
    throw new TypeError('publisher admission result has inconsistent atomic commit state');
  }
  return committed;
}

/**
 * Invoke exactly one shared transaction for all three rate ceilings and the
 * optional (or write-required) Grant debit. This function is not route wiring.
 */
export async function enforcePublisherAdmission(
  port: AtomicPublisherAdmissionPort,
  input: PublisherAdmissionRequest,
): Promise<PublisherAdmissionDecision> {
  let charge: AtomicPublisherAdmission;
  let checkAndConsume: (input: unknown) => unknown;
  try {
    charge = snapshotPublisherAdmission(input);
    checkAndConsume = snapshotPortMethod(port, 'checkAndConsume', 'publisher admission port');
  } catch {
    return publisherAdmissionDecisions.invalidInput;
  }
  let rawResult: unknown;
  try {
    rawResult = await invokeNativePromise(checkAndConsume, charge);
  } catch {
    return publisherAdmissionDecisions.invalidResult;
  }
  try {
    return validatePublisherResult(rawResult, charge)
      ? publisherAdmissionDecisions.allowed
      : publisherAdmissionDecisions.denied;
  } catch {
    return publisherAdmissionDecisions.invalidResult;
  }
}

export type SubscriptionLimitDimension =
  | 'connections'
  | 'resources'
  | 'queue-bytes'
  | 'events-per-second'
  | 'idle-timeout-seconds'
  | 'max-lifetime-seconds';

export interface SubscriptionLimitValues {
  readonly connections: number;
  readonly resources: number;
  readonly queueBytes: number;
  readonly eventsPerSecond: number;
  readonly idleTimeoutSeconds: number;
  readonly maxLifetimeSeconds: number;
}

export interface SubscriptionLimitRequest {
  readonly subscriberId: string;
  readonly subscriptionId: string;
  readonly requested: SubscriptionLimitValues;
  readonly limits: SubscriptionLimitValues;
}

export interface AtomicSubscriptionLimit {
  readonly dimension: SubscriptionLimitDimension;
  readonly requested: number;
  readonly limit: number;
}

export interface AtomicSubscriptionReservation {
  readonly subscriberId: string;
  readonly subscriptionId: string;
  readonly limits: readonly AtomicSubscriptionLimit[];
}

export interface AtomicSubscriptionLimitResult {
  readonly dimension: SubscriptionLimitDimension;
  readonly allowed: boolean;
  readonly observed: number;
  readonly applied: number;
}

export interface AtomicSubscriptionReservationResult {
  readonly committed: boolean;
  readonly snapshots: readonly AtomicSubscriptionLimitResult[];
}

/** Implementations must authoritatively check and reserve all six limits in one transaction. */
export interface AtomicSubscriptionLimitPort {
  checkAndReserve(input: AtomicSubscriptionReservation): Promise<AtomicSubscriptionReservationResult>;
}

export type SubscriptionLimitDecision =
  | { readonly allowed: true; readonly reason: 'allowed' }
  | { readonly allowed: false; readonly reason: 'denied' | 'invalid_input' | 'invalid_result' };

const subscriptionDecisions = Object.freeze({
  allowed: Object.freeze({ allowed: true, reason: 'allowed' } as const),
  denied: Object.freeze({ allowed: false, reason: 'denied' } as const),
  invalidInput: Object.freeze({ allowed: false, reason: 'invalid_input' } as const),
  invalidResult: Object.freeze({ allowed: false, reason: 'invalid_result' } as const),
});

const subscriptionDimensions = Object.freeze([
  Object.freeze({ dimension: 'connections', field: 'connections', positive: true }),
  Object.freeze({ dimension: 'resources', field: 'resources', positive: true }),
  Object.freeze({ dimension: 'queue-bytes', field: 'queueBytes', positive: false }),
  Object.freeze({ dimension: 'events-per-second', field: 'eventsPerSecond', positive: false }),
  Object.freeze({ dimension: 'idle-timeout-seconds', field: 'idleTimeoutSeconds', positive: true }),
  Object.freeze({ dimension: 'max-lifetime-seconds', field: 'maxLifetimeSeconds', positive: true }),
] as const);

const subscriptionValueFields = [
  'connections',
  'resources',
  'queueBytes',
  'eventsPerSecond',
  'idleTimeoutSeconds',
  'maxLifetimeSeconds',
] as const;

function snapshotSubscriptionRequest(value: unknown): AtomicSubscriptionReservation {
  requireExactOwnKeys(
    value,
    ['subscriberId', 'subscriptionId', 'requested', 'limits'],
    'subscription limit request',
  );
  const subscriberId = boundedString(
    requiredData(value, 'subscriberId', 'subscription limit request'),
    'subscriber id',
  );
  const subscriptionId = boundedString(
    requiredData(value, 'subscriptionId', 'subscription limit request'),
    'subscription id',
  );
  const requested = requiredData(value, 'requested', 'subscription limit request');
  const configured = requiredData(value, 'limits', 'subscription limit request');
  requireExactOwnKeys(requested, subscriptionValueFields, 'subscription requested values');
  requireExactOwnKeys(configured, subscriptionValueFields, 'subscription configured limits');

  const limits = subscriptionDimensions.map(({ dimension, field, positive }) => {
    const requestedValue = positive
      ? positiveSafeInteger(requiredData(requested, field, 'subscription requested values'), `requested ${field}`)
      : nonNegativeSafeInteger(requiredData(requested, field, 'subscription requested values'), `requested ${field}`);
    const limit = positiveSafeInteger(
      requiredData(configured, field, 'subscription configured limits'),
      `subscription ${field} limit`,
    );
    return Object.freeze({ dimension, requested: requestedValue, limit });
  });
  return Object.freeze({ subscriberId, subscriptionId, limits: Object.freeze(limits) });
}

function validateSubscriptionResult(
  value: unknown,
  reservation: AtomicSubscriptionReservation,
): boolean {
  requireExactOwnKeys(value, ['committed', 'snapshots'], 'subscription reservation result');
  const committed = requiredData(value, 'committed', 'subscription reservation result');
  if (typeof committed !== 'boolean') throw new TypeError('subscription committed must be boolean');
  const snapshots = snapshotFixedArray(
    requiredData(value, 'snapshots', 'subscription reservation result'),
    subscriptionDimensions.length,
    'subscription result snapshots',
  );
  let allAllowed = true;
  for (let index = 0; index < subscriptionDimensions.length; index += 1) {
    const snapshot = snapshots[index];
    const request = reservation.limits[index];
    const name = `subscription result snapshots[${index}]`;
    requireExactOwnKeys(snapshot, ['dimension', 'allowed', 'observed', 'applied'], name);
    if (request === undefined || requiredData(snapshot, 'dimension', name) !== request.dimension) {
      throw new TypeError(`${name} does not match its requested dimension`);
    }
    const allowed = requiredData(snapshot, 'allowed', name);
    const observed = nonNegativeSafeInteger(requiredData(snapshot, 'observed', name), `${name}.observed`);
    const applied = nonNegativeSafeInteger(requiredData(snapshot, 'applied', name), `${name}.applied`);
    if (typeof allowed !== 'boolean' || (committed && observed > request.limit)) {
      throw new TypeError(`${name} is malformed`);
    }
    if (applied !== (committed ? request.requested : 0)) {
      throw new TypeError(`${name} reports a partial reservation`);
    }
    allAllowed = allAllowed && allowed;
  }
  if (committed !== allAllowed) {
    throw new TypeError('subscription result has inconsistent atomic commit state');
  }
  return committed;
}

/**
 * Reserve/check all subscription limits against one authoritative snapshot.
 * Adapters remain responsible for ongoing event/idle/lifetime enforcement and
 * releasing reservations when a connection closes.
 */
export async function enforceSubscriptionLimits(
  port: AtomicSubscriptionLimitPort,
  input: SubscriptionLimitRequest,
): Promise<SubscriptionLimitDecision> {
  let reservation: AtomicSubscriptionReservation;
  let checkAndReserve: (input: unknown) => unknown;
  try {
    reservation = snapshotSubscriptionRequest(input);
    checkAndReserve = snapshotPortMethod(port, 'checkAndReserve', 'subscription limit port');
  } catch {
    return subscriptionDecisions.invalidInput;
  }
  let rawResult: unknown;
  try {
    rawResult = await invokeNativePromise(checkAndReserve, reservation);
  } catch {
    return subscriptionDecisions.invalidResult;
  }
  try {
    return validateSubscriptionResult(rawResult, reservation)
      ? subscriptionDecisions.allowed
      : subscriptionDecisions.denied;
  } catch {
    return subscriptionDecisions.invalidResult;
  }
}
