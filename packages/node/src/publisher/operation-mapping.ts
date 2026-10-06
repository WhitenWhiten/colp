import type { Operation } from '../types/index.js';
import { createValidatorRegistry } from '../schema/index.js';
import { isRfc3339DateTime } from '../shared/date-time.js';
import { assertSyncTypedUpdateOperationPayload } from '../sync/typed-operations.js';
import type { SyncTypedUpdateOperation } from '../sync/typed-operations.js';
import type {
  AnnotationUpdateOperationPayload,
  AttachmentUpdateOperationPayload,
  CreateAnnotationOperationPayload,
  CreateAttachmentOperationPayload,
  CreateRelationOperationPayload,
  RelationUpdateOperationPayload,
} from '../types/generated.js';

export type PublisherSidecarKind = 'annotation' | 'attachment' | 'relation';
export type PublisherSidecarAction = 'create' | 'update' | 'delete';

export interface PublisherOperationContext {
  readonly operationId: string;
  readonly replicaId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly collectionId: string;
  readonly targetId?: string | undefined;
  readonly baseRevision: string | null;
  readonly dependencies?: readonly string[];
  readonly source?: Operation['source'];
}

export type PublisherSidecarPayload =
  | CreateAnnotationOperationPayload
  | CreateAttachmentOperationPayload
  | CreateRelationOperationPayload
  | AnnotationUpdateOperationPayload
  | AttachmentUpdateOperationPayload
  | RelationUpdateOperationPayload
  | { readonly reason?: string };

export interface PublisherSidecarOperationRequest extends PublisherOperationContext {
  readonly sidecar: PublisherSidecarKind;
  readonly action: PublisherSidecarAction;
  readonly payload: PublisherSidecarPayload;
}

const RESOURCE_FIELDS = new Set(['id', 'collectionId', 'revision', 'createdAt', 'updatedAt']);
const KINDS = new Set<PublisherSidecarKind>(['annotation', 'attachment', 'relation']);
const ACTIONS = new Set<PublisherSidecarAction>(['create', 'update', 'delete']);
const validators = createValidatorRegistry();

function nonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`Publisher ${name} must be a non-empty string.`);
  }
}
function serverId(value: unknown, name: string): asserts value is string {
  nonEmpty(value, name);
  if (value.length > 128 || !/^[A-Za-z0-9._~-]+$/u.test(value)) {
    throw new TypeError(`Publisher ${name} must be a canonical server ID.`);
  }
}
function plain(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`Publisher ${name} must be a plain object.`);
  }
}
function assertNoServerFields(value: Record<string, unknown>, name: string): void {
  for (const key of Object.keys(value)) if (RESOURCE_FIELDS.has(key)) throw new TypeError(`${name} contains server-managed field ${key}.`);
}
function assertPayload(kind: PublisherSidecarKind, action: PublisherSidecarAction, payload: unknown): void {
  plain(payload, 'Operation payload');
  const key = action === 'create' ? kind : action === 'update' ? 'base' : 'reason';
  if (action === 'delete') {
    for (const field of Object.keys(payload)) if (field !== 'reason') throw new TypeError('Delete payload contains unknown fields.');
    if ('reason' in payload && payload.reason !== undefined && typeof payload.reason !== 'string') throw new TypeError('Delete reason must be a string.');
    return;
  }
  if (action === 'create') {
    if (Object.keys(payload).length !== 1 || !(kind in payload)) throw new TypeError('Create payload must contain exactly its resource field.');
    plain(payload[kind], `Create ${kind} payload`);
    assertNoServerFields(payload[kind] as Record<string, unknown>, `Create ${kind} payload`);
    return;
  }
  if (Object.keys(payload).length !== 2 || !('base' in payload) || !('value' in payload)) throw new TypeError('Update payload must contain base and value.');
  plain(payload.base, `${kind} update base`); plain(payload.value, `${kind} update value`);
  assertNoServerFields(payload.base, `${kind} update base`); assertNoServerFields(payload.value, `${kind} update value`);
}

/** Maps Publisher sidecar CRUD intent to the one canonical Operation vocabulary. */
export function mapPublisherSidecarOperation(request: PublisherSidecarOperationRequest): Operation {
  plain(request, 'Operation request');
  if (!KINDS.has(request.sidecar) || !ACTIONS.has(request.action)) throw new TypeError('Unknown sidecar kind or action.');
  serverId(request.operationId, 'operationId'); serverId(request.replicaId, 'replicaId'); serverId(request.collectionId, 'collectionId'); nonEmpty(request.occurredAt, 'occurredAt');
  if (!isRfc3339DateTime(request.occurredAt)) throw new TypeError('Operation occurredAt must be an RFC 3339 date-time.');
  if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) throw new TypeError('Operation sequence must be a positive safe integer.');
  if (request.action === 'create') {
    if (request.baseRevision !== null || request.targetId !== undefined) throw new TypeError('Create operations require null baseRevision and no targetId.');
  } else {
    serverId(request.targetId, 'targetId'); serverId(request.baseRevision, 'baseRevision');
  }
  if (request.dependencies !== undefined) for (const id of request.dependencies) serverId(id, 'dependency');
  assertPayload(request.sidecar, request.action, request.payload);
  const type = `${request.action}_${request.sidecar}` as Operation['type'];
  const operation = {
    opId: request.operationId,
    replicaId: request.replicaId,
    sequence: request.sequence,
    type,
    occurredAt: request.occurredAt,
    collectionId: request.collectionId,
    ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
    baseRevision: request.baseRevision,
    payload: request.payload,
    ...(request.dependencies === undefined ? {} : { dependencies: request.dependencies }),
    ...(request.source === undefined ? {} : { source: request.source }),
  } as Operation;
  if (!validators.validate('operation', operation).valid) {
    throw new TypeError('Publisher sidecar mapping produced an invalid canonical Operation.');
  }
  if (request.action === 'update') {
    assertSyncTypedUpdateOperationPayload(operation as SyncTypedUpdateOperation);
  }
  return Object.freeze(operation);
}

export const toCanonicalOperation = mapPublisherSidecarOperation;
