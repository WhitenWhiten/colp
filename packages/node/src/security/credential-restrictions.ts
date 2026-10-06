import { BlockList, isIP } from 'node:net';
import { types as nodeTypes } from 'node:util';

import { inspectExactDenseArray } from './dense-array.js';
import { assertEpochMilliseconds } from './time-units.js';

export interface CredentialIpSubnet {
  readonly address: string;
  readonly prefixLength: number;
}

export type CredentialIpAllowlistEntry = string | CredentialIpSubnet;

export interface CredentialNodeSubtree {
  readonly collectionId: string;
  readonly rootNodeId: string;
}

/** One restriction source, for example a token, key, or delegated grant. */
export interface CredentialRestriction {
  readonly collectionAllowlist?: readonly string[];
  readonly nodeSubtrees?: readonly CredentialNodeSubtree[];
  readonly ipAllowlist?: readonly CredentialIpAllowlistEntry[];
  readonly originAllowlist?: readonly string[];
  readonly maxOperations?: number;
  /**
   * Inclusive validity start.
   * Unit: {@link import('./time-units.js').EpochMilliseconds} (ms since Unix epoch).
   */
  readonly notBefore?: number;
  /**
   * Exclusive validity end.
   * Unit: {@link import('./time-units.js').EpochMilliseconds} (ms since Unix epoch).
   */
  readonly expiresAt?: number;
  readonly allowPublicExposure?: boolean;
}

export interface CredentialRestrictionRequest {
  readonly credentialId: string;
  readonly restrictions: readonly CredentialRestriction[];
  readonly collectionId?: string;
  readonly nodeId?: string;
  readonly ipAddress?: string;
  readonly origin?: string;
  readonly operationCost?: number;
  readonly publicExposure?: boolean;
}

export interface CredentialNodeSubtreeCheck {
  readonly collectionId: string;
  readonly nodeId: string;
  /** Each inner array is an allowlist from one restriction source. All must match. */
  readonly allowedRootNodeIdsByRestriction: readonly (readonly string[])[];
}

/** Implementations must evaluate every clause against one authoritative tree snapshot. */
export interface CredentialNodeSubtreePort {
  isAllowed(input: CredentialNodeSubtreeCheck): Promise<boolean>;
}

export interface CredentialOperationCharge {
  readonly credentialId: string;
  readonly cost: number;
  /** The intersection of all configured maxima. */
  readonly maxOperations: number;
}

/** The check and successful consumption must be one atomic storage operation. */
export interface CredentialOperationBudgetPort {
  checkAndConsume(input: CredentialOperationCharge): Promise<boolean>;
}

export interface CredentialClockPort {
  /**
   * Current wall time.
   * Unit: {@link import('./time-units.js').EpochMilliseconds} (ms since Unix epoch).
   */
  now(): number;
}

export interface CredentialRestrictionPorts {
  readonly nodeSubtree?: CredentialNodeSubtreePort;
  readonly operationBudget?: CredentialOperationBudgetPort;
  readonly clock?: CredentialClockPort;
}

export type CredentialRestrictionDenialReason =
  | 'invalid_input'
  | 'collection_denied'
  | 'node_denied'
  | 'ip_denied'
  | 'origin_denied'
  | 'outside_validity'
  | 'public_exposure_denied'
  | 'operation_limit_denied'
  | 'port_failure';

export type CredentialRestrictionDecision =
  | { readonly allowed: true; readonly reason: 'allowed' }
  | { readonly allowed: false; readonly reason: CredentialRestrictionDenialReason };

interface IpMatcher {
  readonly blockList: BlockList;
}

interface RestrictionSnapshot {
  readonly collectionAllowlist: ReadonlySet<string> | undefined;
  readonly nodeSubtrees: readonly CredentialNodeSubtree[] | undefined;
  readonly ipMatcher: IpMatcher | undefined;
  readonly originAllowlist: ReadonlySet<string> | undefined;
  readonly maxOperations: number | undefined;
  readonly notBefore: number | undefined;
  readonly expiresAt: number | undefined;
  readonly allowPublicExposure: boolean;
}

interface RequestSnapshot {
  readonly credentialId: string;
  readonly restrictions: readonly RestrictionSnapshot[];
  readonly collectionId: string | undefined;
  readonly nodeId: string | undefined;
  readonly ipAddress: string | undefined;
  readonly ipFamily: 4 | 6 | undefined;
  readonly origin: string | undefined;
  readonly operationCost: number;
  readonly publicExposure: boolean;
}

const allowed = Object.freeze({ allowed: true, reason: 'allowed' } as const);

function denied(reason: CredentialRestrictionDenialReason): CredentialRestrictionDecision {
  return Object.freeze({ allowed: false, reason });
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectProxy(value: unknown, name: string): void {
  if (nodeTypes.isProxy(value)) {
    throw new TypeError(`${name} must not be a Proxy`);
  }
}

function ownData(value: unknown, key: PropertyKey, name: string): unknown | undefined {
  if (!isRecord(value)) throw new TypeError(`${name} must be supplied in an object`);
  rejectProxy(value, name);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new TypeError(`${name} must be an own data property`);
  return descriptor.value;
}

function requiredOwnData(value: unknown, key: PropertyKey, name: string): unknown {
  const result = ownData(value, key, name);
  if (result === undefined) throw new TypeError(`${name} is required`);
  return result;
}

function denseArraySnapshot(value: unknown, name: string): readonly unknown[] {
  // Historical: Proxy rejected, custom prototypes allowed; extra own keys allowed.
  const result = inspectExactDenseArray(value, {
    allowExtraOwnKeys: true,
    requireStandardPrototype: false,
  });
  if (!result.ok) {
    switch (result.failure) {
      case 'not-array':
        throw new TypeError(`${name} must be an array`);
      case 'proxy':
        throw new TypeError(`${name} must not be a Proxy`);
      case 'custom-prototype':
        throw new TypeError(`${name} must not be a Proxy`);
      case 'invalid-length':
        throw new TypeError(`${name} has an invalid length`);
      case 'not-dense':
      case 'extra-keys':
        throw new TypeError(`${name} must be dense`);
      case 'non-data-entry':
        throw new TypeError(`${name} entries must be own data properties`);
    }
  }
  return Object.freeze(result.values);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty string without control characters`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, name);
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function epochMilliseconds(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be non-negative epoch milliseconds`);
  }
  assertEpochMilliseconds(value, name);
  return value;
}

function stringSet(value: unknown, name: string): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  const entries = denseArraySnapshot(value, name).map((entry) => nonEmptyString(entry, `${name} entry`));
  return new Set(entries);
}

function normalizeOrigin(value: unknown, name: string): string {
  const text = nonEmptyString(value, name);
  const url = new URL(text);
  if (
    url.origin === 'null' ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

function originSet(value: unknown, name: string): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  return new Set(denseArraySnapshot(value, name).map((entry) => normalizeOrigin(entry, `${name} entry`)));
}

function ipMatcher(value: unknown, name: string): IpMatcher | undefined {
  if (value === undefined) return undefined;
  const entries = denseArraySnapshot(value, name);
  const blockList = new BlockList();
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const address = nonEmptyString(entry, `${name} address`);
      const family = isIP(address);
      if (family === 0) throw new TypeError(`${name} contains an invalid IP address`);
      blockList.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
      continue;
    }
    const address = nonEmptyString(requiredOwnData(entry, 'address', `${name} subnet address`), `${name} subnet address`);
    const prefixLength = requiredOwnData(entry, 'prefixLength', `${name} subnet prefixLength`);
    const family = isIP(address);
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (
      typeof prefixLength !== 'number' ||
      !Number.isSafeInteger(prefixLength) ||
      prefixLength < 0 ||
      prefixLength > maximumPrefix
    ) {
      throw new TypeError(`${name} contains an invalid IP subnet`);
    }
    blockList.addSubnet(address, prefixLength, family === 4 ? 'ipv4' : 'ipv6');
  }
  return Object.freeze({ blockList });
}

function subtreeSnapshot(value: unknown, name: string): readonly CredentialNodeSubtree[] | undefined {
  if (value === undefined) return undefined;
  return Object.freeze(
    denseArraySnapshot(value, name).map((entry) =>
      Object.freeze({
        collectionId: nonEmptyString(
          requiredOwnData(entry, 'collectionId', `${name} collectionId`),
          `${name} collectionId`,
        ),
        rootNodeId: nonEmptyString(
          requiredOwnData(entry, 'rootNodeId', `${name} rootNodeId`),
          `${name} rootNodeId`,
        ),
      }),
    ),
  );
}

function snapshotRestriction(value: unknown): RestrictionSnapshot {
  const maxOperationsValue = ownData(value, 'maxOperations', 'restriction maxOperations');
  const notBefore = epochMilliseconds(ownData(value, 'notBefore', 'restriction notBefore'), 'notBefore');
  const expiresAt = epochMilliseconds(ownData(value, 'expiresAt', 'restriction expiresAt'), 'expiresAt');
  const allowPublicExposureValue = ownData(
    value,
    'allowPublicExposure',
    'restriction allowPublicExposure',
  );
  if (allowPublicExposureValue !== undefined && typeof allowPublicExposureValue !== 'boolean') {
    throw new TypeError('allowPublicExposure must be boolean');
  }
  if (notBefore !== undefined && expiresAt !== undefined && expiresAt <= notBefore) {
    throw new TypeError('expiresAt must be later than notBefore');
  }
  return Object.freeze({
    collectionAllowlist: stringSet(
      ownData(value, 'collectionAllowlist', 'restriction collectionAllowlist'),
      'collectionAllowlist',
    ),
    nodeSubtrees: subtreeSnapshot(ownData(value, 'nodeSubtrees', 'restriction nodeSubtrees'), 'nodeSubtrees'),
    ipMatcher: ipMatcher(ownData(value, 'ipAllowlist', 'restriction ipAllowlist'), 'ipAllowlist'),
    originAllowlist: originSet(
      ownData(value, 'originAllowlist', 'restriction originAllowlist'),
      'originAllowlist',
    ),
    maxOperations:
      maxOperationsValue === undefined
        ? undefined
        : positiveSafeInteger(maxOperationsValue, 'maxOperations'),
    notBefore,
    expiresAt,
    allowPublicExposure: allowPublicExposureValue === true,
  });
}

function snapshotRequest(input: CredentialRestrictionRequest): RequestSnapshot {
  rejectProxy(input, 'credential restriction request');
  const restrictions = denseArraySnapshot(
    requiredOwnData(input, 'restrictions', 'restrictions'),
    'restrictions',
  ).map(snapshotRestriction);
  const operationCostValue = ownData(input, 'operationCost', 'operationCost');
  const publicExposureValue = ownData(input, 'publicExposure', 'publicExposure');
  if (publicExposureValue !== undefined && typeof publicExposureValue !== 'boolean') {
    throw new TypeError('publicExposure must be boolean');
  }
  const rawIpAddress = optionalString(ownData(input, 'ipAddress', 'ipAddress'), 'ipAddress');
  const ipFamily = rawIpAddress === undefined ? undefined : isIP(rawIpAddress);
  if (ipFamily === 0) throw new TypeError('ipAddress must be an IP address');
  const rawOrigin = ownData(input, 'origin', 'origin');
  return Object.freeze({
    credentialId: nonEmptyString(requiredOwnData(input, 'credentialId', 'credentialId'), 'credentialId'),
    restrictions: Object.freeze(restrictions),
    collectionId: optionalString(ownData(input, 'collectionId', 'collectionId'), 'collectionId'),
    nodeId: optionalString(ownData(input, 'nodeId', 'nodeId'), 'nodeId'),
    ipAddress: rawIpAddress,
    ipFamily: ipFamily === 4 || ipFamily === 6 ? ipFamily : undefined,
    origin: rawOrigin === undefined ? undefined : normalizeOrigin(rawOrigin, 'origin'),
    operationCost:
      operationCostValue === undefined ? 1 : positiveSafeInteger(operationCostValue, 'operationCost'),
    publicExposure: publicExposureValue === true,
  });
}

function checkStatic(snapshot: RequestSnapshot): CredentialRestrictionDecision | undefined {
  for (const restriction of snapshot.restrictions) {
    if (
      restriction.collectionAllowlist !== undefined &&
      (snapshot.collectionId === undefined || !restriction.collectionAllowlist.has(snapshot.collectionId))
    ) {
      return denied('collection_denied');
    }
    if (restriction.ipMatcher !== undefined) {
      if (
        snapshot.ipAddress === undefined ||
        snapshot.ipFamily === undefined ||
        !restriction.ipMatcher.blockList.check(
          snapshot.ipAddress,
          snapshot.ipFamily === 4 ? 'ipv4' : 'ipv6',
        )
      ) {
        return denied('ip_denied');
      }
    }
    if (
      restriction.originAllowlist !== undefined &&
      (snapshot.origin === undefined || !restriction.originAllowlist.has(snapshot.origin))
    ) {
      return denied('origin_denied');
    }
  }
  if (
    snapshot.publicExposure &&
    (snapshot.restrictions.length === 0 ||
      snapshot.restrictions.some((restriction) => !restriction.allowPublicExposure))
  ) {
    return denied('public_exposure_denied');
  }
  return undefined;
}

function validityBounds(snapshot: RequestSnapshot):
  | { readonly notBefore?: number; readonly expiresAt?: number }
  | undefined {
  let notBefore: number | undefined;
  let expiresAt: number | undefined;
  for (const restriction of snapshot.restrictions) {
    if (restriction.notBefore !== undefined) {
      notBefore = notBefore === undefined
        ? restriction.notBefore
        : Math.max(notBefore, restriction.notBefore);
    }
    if (restriction.expiresAt !== undefined) {
      expiresAt = expiresAt === undefined
        ? restriction.expiresAt
        : Math.min(expiresAt, restriction.expiresAt);
    }
  }
  if (notBefore === undefined && expiresAt === undefined) return undefined;
  return {
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function snapshotPortMethod(
  ports: unknown,
  portName: keyof CredentialRestrictionPorts,
  methodName: string,
): ((input?: unknown) => unknown) | undefined {
  const port = ownData(ports, portName, `credential restriction ports.${portName}`);
  if (port === undefined) return undefined;
  if (!isRecord(port)) {
    throw new TypeError(`credential restriction ports.${portName} must be supplied in an object`);
  }
  rejectProxy(port, `credential restriction ports.${portName}`);

  let owner: object | null = port;
  while (owner !== null && owner !== Object.prototype) {
    rejectProxy(owner, `credential restriction ports.${portName} prototype`);
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new TypeError(`credential restriction ports.${portName}.${methodName} must be a data method`);
      }
      const method = descriptor.value as (input?: unknown) => unknown;
      return (input?: unknown) => Reflect.apply(method, port, input === undefined ? [] : [input]);
    }
    owner = Object.getPrototypeOf(owner);
  }
  throw new TypeError(`credential restriction ports.${portName}.${methodName} is required`);
}

/**
 * Apply every configured restriction as an intersection. Static denials happen
 * before the single atomic operation-budget call and therefore consume nothing.
 */
export async function enforceCredentialRestrictions(
  ports: CredentialRestrictionPorts,
  input: CredentialRestrictionRequest,
): Promise<CredentialRestrictionDecision> {
  let snapshot: RequestSnapshot;
  try {
    snapshot = snapshotRequest(input);
    const staticDecision = checkStatic(snapshot);
    if (staticDecision !== undefined) return staticDecision;
  } catch {
    return denied('invalid_input');
  }

  const bounds = validityBounds(snapshot);
  if (bounds !== undefined) {
    let now: unknown;
    try {
      const clockNow = snapshotPortMethod(ports, 'clock', 'now');
      now = clockNow?.();
    } catch {
      return denied('port_failure');
    }
    if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) {
      return denied('port_failure');
    }
    if (
      (bounds.notBefore !== undefined && now < bounds.notBefore) ||
      (bounds.expiresAt !== undefined && now >= bounds.expiresAt)
    ) {
      return denied('outside_validity');
    }
  }

  const subtreeClauses = snapshot.restrictions.flatMap((restriction) => {
    if (restriction.nodeSubtrees === undefined) return [];
    if (snapshot.collectionId === undefined || snapshot.nodeId === undefined) return [Object.freeze([] as string[])];
    return [
      Object.freeze(
        restriction.nodeSubtrees
          .filter((subtree) => subtree.collectionId === snapshot.collectionId)
          .map((subtree) => subtree.rootNodeId),
      ),
    ];
  });
  let maxOperations: number | undefined;
  for (const restriction of snapshot.restrictions) {
    if (restriction.maxOperations !== undefined) {
      maxOperations = maxOperations === undefined
        ? restriction.maxOperations
        : Math.min(maxOperations, restriction.maxOperations);
    }
  }
  let checkAndConsumeSnapshot: ((input?: unknown) => unknown) | undefined;
  let budgetMethodSnapshotted = false;
  if (subtreeClauses.length > 0) {
    if (
      snapshot.collectionId === undefined ||
      snapshot.nodeId === undefined ||
      subtreeClauses.some((roots) => roots.length === 0)
    ) {
      return denied('node_denied');
    }
    let isAllowed: ((input?: unknown) => unknown) | undefined;
    try {
      isAllowed = snapshotPortMethod(ports, 'nodeSubtree', 'isAllowed');
      if (maxOperations !== undefined) {
        checkAndConsumeSnapshot = snapshotPortMethod(ports, 'operationBudget', 'checkAndConsume');
        budgetMethodSnapshotted = true;
      }
    } catch {
      return denied('port_failure');
    }
    let nodeAllowed: unknown;
    try {
      nodeAllowed = await isAllowed?.(
        Object.freeze({
          collectionId: snapshot.collectionId,
          nodeId: snapshot.nodeId,
          allowedRootNodeIdsByRestriction: Object.freeze(subtreeClauses),
        }),
      );
    } catch {
      return denied('port_failure');
    }
    if (typeof nodeAllowed !== 'boolean') return denied('port_failure');
    if (!nodeAllowed) return denied('node_denied');
  }

  if (maxOperations !== undefined) {
    if (snapshot.operationCost > maxOperations) return denied('operation_limit_denied');
    let operationAllowed: unknown;
    try {
      const checkAndConsume = budgetMethodSnapshotted
        ? checkAndConsumeSnapshot
        : snapshotPortMethod(ports, 'operationBudget', 'checkAndConsume');
      operationAllowed = await checkAndConsume?.(
        Object.freeze({
          credentialId: snapshot.credentialId,
          cost: snapshot.operationCost,
          maxOperations,
        }),
      );
    } catch {
      return denied('port_failure');
    }
    if (typeof operationAllowed !== 'boolean') return denied('port_failure');
    if (!operationAllowed) return denied('operation_limit_denied');
  }

  return allowed;
}
