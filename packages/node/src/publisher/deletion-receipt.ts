import { types as nodeTypes } from 'node:util';

import { isRfc3339DateTime } from '../shared/date-time.js';
import type { DeleteResult, DeletionReceipt } from '../types/generated.js';
import type {
  IdempotencyBinding,
  IdempotentPublisherWriteResult,
  PublisherTransaction,
  PublisherUnitOfWork,
  ResourceStore,
  StoredPublisherResponse,
} from './index.js';
import { executeIdempotentPublisherWrite } from './index.js';

export type PublisherDeletionResourceType = DeletionReceipt['resourceType'];
export type PublisherDeletionScope = DeletionReceipt['scope'];

/** Identity and scope selected by the authenticated Publisher request boundary. */
export interface PublisherDeleteRequest {
  readonly resourceType: PublisherDeletionResourceType;
  readonly targetId: string;
  readonly collectionId: string;
  readonly scope: PublisherDeletionScope;
}

/**
 * Internal durable proof returned by the persistence adapter. It is deliberately
 * separate from the wire receipt and is never serialized as a Sync cursor.
 */
export interface PublisherDeletionWatermark {
  readonly resourceType: PublisherDeletionResourceType;
  readonly targetId: string;
  readonly collectionId: string;
  readonly scope: PublisherDeletionScope;
  readonly deletedAt: string;
  readonly deleteRevision: string;
  readonly operationId: string;
  readonly affectedCount: number;
}

export interface PublisherDeletionAdapterResult {
  readonly receipt: DeletionReceipt;
  readonly watermark: PublisherDeletionWatermark;
}

export interface PublisherDeletionResources extends ResourceStore {
  /** Soft-deletes the authoritative resource and persists its watermark atomically. */
  deleteResource(request: PublisherDeleteRequest): Promise<PublisherDeletionAdapterResult>;
}

export interface PublisherDeletionTransaction
  extends PublisherTransaction<PublisherDeletionResources> {}

export interface PublisherDeletionPort<
  Transaction extends PublisherDeletionTransaction = PublisherDeletionTransaction,
> {
  readonly unitOfWork: PublisherUnitOfWork<Transaction>;
  deleteResource(
    binding: IdempotencyBinding,
    request: PublisherDeleteRequest,
  ): Promise<IdempotentPublisherWriteResult>;
}

const resourceTypes = new Set<unknown>([
  'collection',
  'node',
  'annotation',
  'attachment',
  'relation',
]);
const scopes = new Set<unknown>(['single', 'subtree']);
const opaqueIdPattern = /^[A-Za-z0-9._~-]{1,128}$/u;
const principalIdPattern = /^[\x21-\x7E]{1,512}$/u;
const receiptKeys = new Set([
  'resourceType',
  'targetId',
  'collectionId',
  'scope',
  'deletedAt',
  'deletedBy',
  'deleteRevision',
  'operationId',
  'affectedCount',
  'purgeAfter',
]);
const requiredReceiptKeys = new Set([
  'resourceType',
  'targetId',
  'collectionId',
  'scope',
  'deletedAt',
  'deleteRevision',
  'operationId',
  'affectedCount',
  'purgeAfter',
]);
const watermarkKeys = new Set([
  'resourceType',
  'targetId',
  'collectionId',
  'scope',
  'deletedAt',
  'deleteRevision',
  'operationId',
  'affectedCount',
]);

/**
 * Executes a Publisher soft delete and emits only the canonical DeleteResult.
 * Adapter output, including its internal watermark, is checked before commit;
 * idempotency replays are checked again before they cross the domain boundary.
 */
export async function executePublisherDelete<
  Transaction extends PublisherDeletionTransaction,
>(
  unitOfWork: PublisherUnitOfWork<Transaction>,
  binding: IdempotencyBinding,
  request: PublisherDeleteRequest,
): Promise<IdempotentPublisherWriteResult> {
  const expected = immutableDeleteRequest(request);
  assertDeleteBinding(binding, expected);
  const result = await executeIdempotentPublisherWrite(unitOfWork, binding, async (transaction) => {
    const resources = dataObject(transaction, 'resources', 'Publisher deletion transaction');
    const deleteResource = bindMethod<PublisherDeletionResources['deleteResource']>(
      resources,
      'deleteResource',
      'Publisher deletion resources',
    );
    const adapterResult = exactDataObject(
      await requirePromise(deleteResource(expected), 'Publisher deletion resource adapter'),
      new Set(['receipt', 'watermark']),
      new Set(['receipt', 'watermark']),
      'Publisher deletion adapter result',
    );
    const receipt = immutableReceipt(adapterResult.receipt, expected);
    const watermark = immutableWatermark(adapterResult.watermark);
    assertWatermarkMatchesReceipt(watermark, receipt);

    const body: DeleteResult = Object.freeze({ receipt });
    return Object.freeze({ status: 200, headers: Object.freeze({}), body });
  });

  if (result.state === 'committed' || result.state === 'replayed') {
    validateDeleteResponse(result.response, expected);
  }
  return result;
}

const deleteEndpointKeys = Object.freeze({
  collection: 'collection',
  node: 'node',
  annotation: 'annotation',
  attachment: 'attachment',
  relation: 'relation',
} as const satisfies Readonly<Record<PublisherDeletionResourceType, string>>);

function assertDeleteBinding(binding: IdempotencyBinding, request: PublisherDeleteRequest): void {
  const expectedIdentity = request.resourceType === 'collection'
    ? request.collectionId
    : `${request.collectionId}/${request.targetId}`;
  if (binding === null || typeof binding !== 'object' || nodeTypes.isProxy(binding)
    || binding.method !== 'DELETE'
    || binding.endpointKey !== deleteEndpointKeys[request.resourceType]
    || binding.resourceIdentity !== expectedIdentity) {
    throw new TypeError('Publisher DELETE idempotency binding does not match the request target.');
  }
}

function immutableDeleteRequest(value: unknown): Readonly<PublisherDeleteRequest> {
  const request = exactDataObject(
    value,
    new Set(['resourceType', 'targetId', 'collectionId', 'scope']),
    new Set(['resourceType', 'targetId', 'collectionId', 'scope']),
    'Publisher delete request',
  );
  const normalized = Object.freeze({
    resourceType: resourceType(request.resourceType, 'Publisher delete request resourceType'),
    targetId: opaqueId(request.targetId, 'Publisher delete request targetId'),
    collectionId: opaqueId(request.collectionId, 'Publisher delete request collectionId'),
    scope: scope(request.scope, 'Publisher delete request scope'),
  });
  assertIdentityScope(normalized, undefined, 'Publisher delete request');
  return normalized;
}

function immutableReceipt(value: unknown, expected: PublisherDeleteRequest): Readonly<DeletionReceipt> {
  const receipt = exactDataObject(value, receiptKeys, requiredReceiptKeys, 'Deletion Receipt');
  const normalized = Object.freeze({
    resourceType: resourceType(receipt.resourceType, 'Deletion Receipt resourceType'),
    targetId: opaqueId(receipt.targetId, 'Deletion Receipt targetId'),
    collectionId: opaqueId(receipt.collectionId, 'Deletion Receipt collectionId'),
    scope: scope(receipt.scope, 'Deletion Receipt scope'),
    deletedAt: dateTime(receipt.deletedAt, 'Deletion Receipt deletedAt'),
    ...(Object.hasOwn(receipt, 'deletedBy')
      ? { deletedBy: principalId(receipt.deletedBy, 'Deletion Receipt deletedBy') }
      : {}),
    deleteRevision: opaqueId(receipt.deleteRevision, 'Deletion Receipt deleteRevision'),
    operationId: opaqueId(receipt.operationId, 'Deletion Receipt operationId'),
    affectedCount: positiveSafeInteger(receipt.affectedCount, 'Deletion Receipt affectedCount'),
    purgeAfter: dateTime(receipt.purgeAfter, 'Deletion Receipt purgeAfter'),
  });
  if (
    normalized.resourceType !== expected.resourceType
    || normalized.targetId !== expected.targetId
    || normalized.collectionId !== expected.collectionId
    || normalized.scope !== expected.scope
  ) {
    throw new TypeError('Deletion Receipt identity or scope does not match the delete request.');
  }
  assertIdentityScope(normalized, normalized.affectedCount, 'Deletion Receipt');
  const deletedAt = instant(normalized.deletedAt);
  const purgeAfter = instant(normalized.purgeAfter);
  if (deletedAt !== undefined && purgeAfter !== undefined && purgeAfter < deletedAt) {
    throw new TypeError('Deletion Receipt purgeAfter cannot precede deletedAt.');
  }
  return normalized;
}

function immutableWatermark(value: unknown): Readonly<PublisherDeletionWatermark> {
  const watermark = exactDataObject(value, watermarkKeys, watermarkKeys, 'Publisher deletion watermark');
  return Object.freeze({
    resourceType: resourceType(watermark.resourceType, 'Publisher deletion watermark resourceType'),
    targetId: opaqueId(watermark.targetId, 'Publisher deletion watermark targetId'),
    collectionId: opaqueId(watermark.collectionId, 'Publisher deletion watermark collectionId'),
    scope: scope(watermark.scope, 'Publisher deletion watermark scope'),
    deletedAt: dateTime(watermark.deletedAt, 'Publisher deletion watermark deletedAt'),
    deleteRevision: opaqueId(watermark.deleteRevision, 'Publisher deletion watermark deleteRevision'),
    operationId: opaqueId(watermark.operationId, 'Publisher deletion watermark operationId'),
    affectedCount: positiveSafeInteger(
      watermark.affectedCount,
      'Publisher deletion watermark affectedCount',
    ),
  });
}

function assertWatermarkMatchesReceipt(
  watermark: Readonly<PublisherDeletionWatermark>,
  receipt: Readonly<DeletionReceipt>,
): void {
  for (const key of watermarkKeys) {
    if (watermark[key as keyof PublisherDeletionWatermark] !== receipt[key as keyof DeletionReceipt]) {
      throw new TypeError(`Publisher deletion watermark ${key} does not match the Deletion Receipt.`);
    }
  }
}

function validateDeleteResponse(response: StoredPublisherResponse, expected: PublisherDeleteRequest): void {
  if (response.status !== 200) {
    throw new TypeError('Publisher DELETE response must use status 200.');
  }
  const body = exactDataObject(response.body, new Set(['receipt']), new Set(['receipt']), 'DeleteResult');
  immutableReceipt(body.receipt, expected);
}

function assertIdentityScope(
  value: Pick<PublisherDeleteRequest, 'resourceType' | 'targetId' | 'collectionId' | 'scope'>,
  affectedCount: number | undefined,
  label: string,
): void {
  if (value.resourceType === 'collection') {
    if (value.targetId !== value.collectionId || value.scope !== 'single') {
      throw new TypeError(`${label} Collection deletion must target its own collection with single scope.`);
    }
    if (affectedCount !== undefined && affectedCount !== 1) {
      throw new TypeError(`${label} Collection deletion affectedCount must be 1.`);
    }
  } else if (value.resourceType !== 'node' && value.scope !== 'single') {
    throw new TypeError(`${label} subtree scope is valid only for Node deletion.`);
  }
  if (affectedCount !== undefined && value.scope === 'single' && affectedCount !== 1) {
    throw new TypeError(`${label} single deletion affectedCount must be 1.`);
  }
}

function exactDataObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain or null prototype.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unknown member.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} members must be enumerable data properties.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing required member ${key}.`);
  }
  return value as Record<string, unknown>;
}

function dataObject(owner: unknown, name: string, label: string): object {
  if (owner === null || typeof owner !== 'object' || nodeTypes.isProxy(owner)) {
    throw new TypeError(`${label} must be a non-Proxy object.`);
  }
  const descriptor = findDataProperty(owner, name, label);
  if (descriptor === undefined || !('value' in descriptor)
    || descriptor.value === null || typeof descriptor.value !== 'object'
    || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data object.`);
  }
  return descriptor.value;
}

function bindMethod<Method extends (...args: any[]) => unknown>(
  owner: object,
  name: string,
  label: string,
): Method {
  const descriptor = findDataProperty(owner, name, label);
  if (descriptor === undefined || !('value' in descriptor)
    || typeof descriptor.value !== 'function' || nodeTypes.isProxy(descriptor.value)) {
    throw new TypeError(`${label} ${name} must be a non-Proxy data method.`);
  }
  const method = descriptor.value as Method;
  return ((...args: Parameters<Method>) => Reflect.apply(method, owner, args)) as Method;
}

function findDataProperty(owner: object, name: string, label: string): PropertyDescriptor | undefined {
  let current: object | null = owner;
  while (current !== null) {
    if (nodeTypes.isProxy(current)) throw new TypeError(`${label} prototype cannot be a Proxy.`);
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw new TypeError(`${label} ${name} must be a data property.`);
      return descriptor;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function requirePromise<Result>(candidate: Promise<Result>, label: string): Promise<Result> {
  if (!(candidate instanceof Promise)) throw new TypeError(`${label} must return a native Promise.`);
  return candidate;
}

function resourceType(value: unknown, label: string): PublisherDeletionResourceType {
  if (!resourceTypes.has(value)) throw new TypeError(`${label} is invalid.`);
  return value as PublisherDeletionResourceType;
}

function scope(value: unknown, label: string): PublisherDeletionScope {
  if (!scopes.has(value)) throw new TypeError(`${label} is invalid.`);
  return value as PublisherDeletionScope;
}

function opaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !opaqueIdPattern.test(value)) {
    throw new TypeError(`${label} must be a canonical opaque ID.`);
  }
  return value;
}

function principalId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !principalIdPattern.test(value)) {
    throw new TypeError(`${label} must be a canonical principal ID.`);
  }
  return value;
}

function dateTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isRfc3339DateTime(value)) {
    throw new TypeError(`${label} must be a valid RFC 3339 date-time.`);
  }
  return value;
}

function instant(value: string): number | undefined {
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : undefined;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value as number;
}
