import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { Conflict, Operation, SyncPushResult } from '@know-n/colp/types';
import type { PostgresSyncSequenceTransaction } from './sync-sequence-postgres.js';
import type { TrustedSyncNodeRevision } from '../../modules/sync/index.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { appendOperationWithPayload } from '../database/operation-payload-store.js';

export type SyncConflictType = 'concurrent_field_update' | 'unprovable_base'
  | 'untrusted_base' | 'delete_update';

export type SyncConflictResolutionName = 'server' | 'incoming' | 'custom' | 'both';

/**
 * FIX-M-015 (SYNC-R10): the external menu only ever advertises executable
 * choices. A `delete_update` Conflict (a client update raced a server delete)
 * advertises exactly `server` — dismiss keeps the tombstone and closes the
 * Conflict; restoring the node would require a dedicated canonical restore
 * mutation that is not deployed, and `both` has no meaning for a deleted
 * current. Other Conflict types keep the historical menu (bookmarks
 * additionally support `both`).
 */
export function allowedSyncConflictResolutions(
  conflictType: SyncConflictType,
  nodeKind: TrustedSyncNodeRevision['kind'],
): readonly SyncConflictResolutionName[] {
  if (conflictType === 'delete_update') return Object.freeze(['server'] as const);
  return nodeKind === 'bookmark'
    ? Object.freeze(['server', 'incoming', 'custom', 'both'] as const)
    : Object.freeze(['server', 'incoming', 'custom'] as const);
}

export type PostgresSyncConflictFaultPhase = 'conflict_ordinal' | 'conflict_operation'
  | 'conflict' | 'conflict_audit' | 'conflict_outbox';

export interface SyncConflictProjectionBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxMembers: number;
}

export interface SyncConflictPayloadEncryption {
  readonly key: Buffer;
  readonly keyVersion: number;
}

/**
 * FIX-M-011 (SYNC-R06): versioned conflict payload keyring. `active` is the
 * only key that encrypts new Conflict payloads; `retained` keys still decrypt
 * historical open Conflicts until they are resolved or drained. Key material
 * never enters logs, errors, or evidence — only versions do.
 */
export interface SyncConflictPayloadKeyring {
  readonly active: SyncConflictPayloadEncryption;
  readonly retained: readonly SyncConflictPayloadEncryption[];
}

const MAX_RETAINED_CONFLICT_KEYS = 8;

/** Selects the key whose version matches the persisted Conflict key version. */
export function selectSyncConflictPayloadKey(
  keyring: SyncConflictPayloadKeyring,
  keyVersion: number,
): SyncConflictPayloadEncryption | undefined {
  if (keyring.active.keyVersion === keyVersion) return keyring.active;
  return keyring.retained.find((key) => key.keyVersion === keyVersion);
}

function isSyncConflictPayloadKey(value: unknown): value is SyncConflictPayloadEncryption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as SyncConflictPayloadEncryption;
  return Buffer.isBuffer(key.key) && key.key.length === 32
    && Number.isSafeInteger(key.keyVersion) && key.keyVersion >= 1
    && key.keyVersion <= 2_147_483_647;
}

/** Fail-closed shape validation; never reveals key material. */
export function isSyncConflictPayloadKeyring(value: unknown): value is SyncConflictPayloadKeyring {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keyring = value as Partial<SyncConflictPayloadKeyring>;
  if (!isSyncConflictPayloadKey(keyring.active) || !Array.isArray(keyring.retained)
      || keyring.retained.length > MAX_RETAINED_CONFLICT_KEYS
      || keyring.retained.some((key) => !isSyncConflictPayloadKey(key))) return false;
  const keys = [keyring.active, ...keyring.retained];
  const versions = keys.map((key) => key.keyVersion);
  if (new Set(versions).size !== versions.length) return false;
  const material = keys.map((key) => key.key.toString('base64'));
  return new Set(material).size === material.length;
}

export interface AppendOpenSyncConflictInput {
  readonly transaction: PostgresSyncSequenceTransaction<SyncPushResult>;
  readonly sessionId: string;
  readonly operation: Operation;
  readonly code: 'sync_base_unavailable' | 'sync_base_untrusted' | 'sync_conflict_pending';
  readonly conflictingFields: readonly string[];
  readonly trustedBase?: TrustedSyncNodeRevision;
  readonly current: TrustedSyncNodeRevision;
  readonly conflictPayloadEncryption?: SyncConflictPayloadEncryption;
  readonly budget?: SyncConflictProjectionBudget;
  readonly faultInjector?: {
    afterPhase?(phase: PostgresSyncConflictFaultPhase): void | Promise<void>;
  };
}

export interface OpenSyncConflictResult {
  readonly conflictId: string;
  readonly revision: 'conflict-r1';
  readonly commitOrdinal: bigint;
  readonly cursor: string;
}

const DEFAULT_BUDGET: SyncConflictProjectionBudget = Object.freeze({
  maxBytes: 131_072,
  maxDepth: 64,
  maxMembers: 20_000,
});

const CONFLICT_REVISION = 'conflict-r1' as const;
const SYNC_CONFLICT_OPENED_EVENT_TYPE = 'sync.conflict.opened';
const SYNC_CONFLICT_OPENED_EVENT_VERSION = 1;
const SYNC_CONFLICT_PULL_HANDLER_NAME = 'sync_conflict_pull';

export class SyncConflictPersistenceError extends Error {
  constructor(public readonly code: 'invalid_document' | 'payload_too_large' | 'integrity_failure') {
    super(`Sync Conflict persistence denied: ${code}`);
    this.name = 'SyncConflictPersistenceError';
  }
}

function persistenceError(code: SyncConflictPersistenceError['code']): never {
  throw new SyncConflictPersistenceError(code);
}

/**
 * Appends one privacy-minimal Conflict and its stream evidence inside the caller's
 * already-authorized Sequence transaction. Raw Base/Current/Incoming values never
 * leave this function and are represented only by type, byte count, and SHA-256.
 */
export async function appendOpenSyncConflict(
  input: AppendOpenSyncConflictInput,
): Promise<Readonly<OpenSyncConflictResult>> {
  const { transaction, operation } = input;
  const tx = transaction.databaseTransaction;
  if (operation.type !== 'update_node_content' || operation.collectionId !== transaction.authority.collectionId
      || operation.replicaId !== transaction.authority.replicaId || typeof operation.targetId !== 'string') {
    persistenceError('integrity_failure');
  }
  const payload = operation.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) persistenceError('invalid_document');
  const update = payload as { readonly base?: unknown; readonly value?: unknown };
  if (!isRecord(update.base) || !isRecord(update.value)) persistenceError('invalid_document');
  if (typeof operation.baseRevision !== 'string' || operation.baseRevision.length < 1) {
    persistenceError('invalid_document');
  }
  const conflictPayloadEncryption = input.conflictPayloadEncryption;
  assertEncryption(conflictPayloadEncryption);

  const conflictType = conflictTypeFor(input);
  const fields = normalizedConflictFields(input.conflictingFields, conflictType, update.base);
  const budget = input.budget ?? DEFAULT_BUDGET;
  assertAggregateBudget([
    update.base, update.value, input.trustedBase?.payload ?? {}, input.current.payload,
  ], budget);
  const baseSource = input.trustedBase?.payload ?? update.base;
  const baseProjection = summarizeProjection(baseSource, fields, operation.baseRevision ?? null);
  const currentProjection = summarizeProjection(input.current.payload, fields, input.current.revision);
  const incomingProjection = summarizeProjection(update.value, fields, operation.baseRevision ?? null);
  const allowedResolutions = allowedSyncConflictResolutions(conflictType, input.current.kind);

  const claim = await tx.selectFrom('sync_sequence_operation_claims').select('operation_id')
    .where('operation_id', '=', operation.opId).executeTakeFirst();
  const ledger = await tx.selectFrom('resource_id_ledger').select('resource_type')
    .where('resource_id', '=', operation.opId).executeTakeFirst();
  if (!claim || ledger?.resource_type !== 'operation') persistenceError('integrity_failure');

  const collection = await tx.updateTable('collections').set({
    commit_ordinal: sql`commit_ordinal + 1`,
    payload_json: sql`jsonb_set(payload_json, '{commitOrdinal}', to_jsonb((commit_ordinal + 1)::text), true)`,
  }).where('id', '=', transaction.authority.collectionId)
    .returning('commit_ordinal').executeTakeFirst();
  if (!collection) persistenceError('integrity_failure');
  const commitOrdinal = BigInt(collection.commit_ordinal);
  await input.faultInjector?.afterPhase?.('conflict_ordinal');

  const conflictId = await reserveGeneratedId(transaction, 'conflict_');
  const outboxId = await reserveGeneratedId(transaction, 'outbox_');
  const privatePayload = stableJson({
    base: projectRawValues(baseSource, fields),
    current: projectRawValues(input.current.payload, fields),
    incoming: projectRawValues(update.value, fields),
    nodeKind: input.current.kind,
  });
  const encrypted = encryptPrivatePayload(privatePayload, conflictPayloadEncryption, {
    collectionId: transaction.authority.collectionId,
    replicaId: transaction.authority.replicaId,
    leaseGeneration: transaction.authority.leaseGeneration,
    sessionId: input.sessionId,
    operationId: operation.opId,
    targetId: operation.targetId,
    conflictId,
    commitOrdinal: commitOrdinal.toString(),
    conflictType,
    conflictingFields: stableJson(fields),
    nodeKind: input.current.kind,
    baseRevision: operation.baseRevision,
    currentRevision: input.current.revision,
    keyVersion: String(conflictPayloadEncryption.keyVersion),
  });
  const operationPayload = Object.freeze({
    action: 'conflict', collectionId: transaction.authority.collectionId,
    commitOrdinal: commitOrdinal.toString(), conflictId, conflictType,
    conflictingFields: fields, resourceType: 'node', targetId: operation.targetId,
  });
  const time = await sql<{ now: Date }>`select current_timestamp as now`.execute(tx);
  const conflictCreatedAt = time.rows[0]?.now;
  if (!(conflictCreatedAt instanceof Date)) persistenceError('integrity_failure');
  const pullWire: Conflict = {
    id: conflictId, collectionId: transaction.authority.collectionId, targetId: operation.targetId,
    type: conflictType, ...(fields.length === 1 ? { field: fields[0]! } : {}),
    incomingOpId: operation.opId, createdAt: conflictCreatedAt.toISOString(), status: 'open',
    allowedResolutions: [...allowedResolutions] as Conflict['allowedResolutions'], revision: CONFLICT_REVISION,
  };
  await appendOperationWithPayload(tx, {
    operationId: operation.opId, collectionId: transaction.authority.collectionId,
    commitOrdinal, operationType: 'sync.node.update.conflicted', payloadJson: operationPayload,
    // The immutable Operation remains the audit/receipt identity, while its
    // un-applied Base/Incoming values stay only in the encrypted Conflict
    // payload. The Conflict stream row is the sole Pull representation.
    syncWireJson: null,
    actorPrincipalId: transaction.authority.accountId,
  });
  await input.faultInjector?.afterPhase?.('conflict_operation');

  await tx.insertInto('sync_conflicts').values({
    conflict_id: conflictId,
    collection_id: transaction.authority.collectionId,
    replica_id: transaction.authority.replicaId,
    session_id: input.sessionId,
    operation_id: operation.opId,
    target_id: operation.targetId,
    base_revision: operation.baseRevision,
    trusted_base_revision: input.trustedBase?.revision ?? null,
    current_revision: input.current.revision,
    conflict_type: conflictType,
    conflicting_fields: sql<readonly string[]>`${JSON.stringify(fields)}::jsonb`,
    base_projection: baseProjection,
    current_projection: currentProjection,
    incoming_projection: incomingProjection,
    private_payload_ciphertext: encrypted.ciphertext,
    private_payload_iv: encrypted.iv,
    private_payload_auth_tag: encrypted.authTag,
    private_payload_key_version: conflictPayloadEncryption.keyVersion,
    private_payload_digest: encrypted.digest,
    allowed_resolutions: sql<readonly ('server' | 'incoming' | 'custom' | 'both')[]>`
      ${JSON.stringify(allowedResolutions)}::jsonb`,
    pull_wire_json: pullWire as unknown as Record<string, unknown>,
    status: 'open',
    revision: CONFLICT_REVISION,
    commit_ordinal: commitOrdinal,
    created_at: conflictCreatedAt,
  }).execute();
  await input.faultInjector?.afterPhase?.('conflict');

  await appendAuditEvent(tx, {
    operationId: operation.opId,
    collectionId: transaction.authority.collectionId,
    principalId: transaction.authority.accountId,
    eventType: SYNC_CONFLICT_OPENED_EVENT_TYPE,
    details: operationPayload,
    createdAt: conflictCreatedAt,
  });
  await input.faultInjector?.afterPhase?.('conflict_audit');

  await tx.insertInto('outbox_events').values({
    outbox_id: outboxId,
    domain_event_id: operation.opId,
    event_type: SYNC_CONFLICT_OPENED_EVENT_TYPE,
    event_version: SYNC_CONFLICT_OPENED_EVENT_VERSION,
    handler_name: SYNC_CONFLICT_PULL_HANDLER_NAME,
    handler_mode: 'projection_latest_only',
    aggregate_scope: transaction.authority.collectionId,
    aggregate_revision: CONFLICT_REVISION,
    commit_ordinal: commitOrdinal,
    payload_json: operationPayload,
    state: 'pending',
    attempt_count: 0,
    available_at: sql<Date>`current_timestamp`,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    aggregate_type: 'conflict',
    aggregate_id: conflictId,
    occurred_at: sql<Date>`current_timestamp`,
    dead_lettered_at: null,
  }).execute();
  await input.faultInjector?.afterPhase?.('conflict_outbox');

  return Object.freeze({
    conflictId,
    revision: CONFLICT_REVISION,
    commitOrdinal,
    cursor: `sync-conflict-${commitOrdinal}`,
  });
}

function conflictTypeFor(input: AppendOpenSyncConflictInput): SyncConflictType {
  if (input.current.deleted) return 'delete_update';
  if (input.code === 'sync_base_unavailable') return 'unprovable_base';
  if (input.code === 'sync_base_untrusted') return 'untrusted_base';
  return 'concurrent_field_update';
}

function normalizedConflictFields(
  source: readonly string[],
  type: SyncConflictType,
  base: Readonly<Record<string, unknown>>,
): readonly string[] {
  const fields = source.length > 0 ? source : type === 'delete_update'
    ? ['deletedAt', ...Object.keys(base)]
    : type === 'unprovable_base' ? ['baseRevision', ...Object.keys(base)] : Object.keys(base);
  const normalized = [...new Set(fields.map((field) => field.startsWith('/') ? field : `/${field}`))].sort();
  if (normalized.length < 1 || normalized.some((field) => !/^\/[A-Za-z][A-Za-z0-9]*$/u.test(field))) {
    persistenceError('invalid_document');
  }
  return Object.freeze(normalized);
}

function projectRawValues(
  source: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const pointer of fields) {
    const field = pointer.slice(1);
    if (Object.hasOwn(source, field)) projected[field] = source[field];
  }
  return projected;
}

export function encryptPrivatePayload(
  plaintext: string,
  conflictPayloadEncryption: SyncConflictPayloadEncryption,
  aad: Readonly<Record<string, string>>,
): Readonly<{ readonly ciphertext: Buffer; readonly iv: Buffer; readonly authTag: Buffer;
  readonly digest: string }> {
  const key = Buffer.from(hkdfSync(
    'sha256', conflictPayloadEncryption.key, Buffer.alloc(0),
    Buffer.from('known.sync-conflict.private.v1', 'utf8'), 32,
  ));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(stableJson(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    digest: createHmac('sha256', key).update(plaintext, 'utf8').digest('base64url'),
  });
}

function assertEncryption(value: SyncConflictPayloadEncryption | undefined):
  asserts value is SyncConflictPayloadEncryption {
  if (!value || !Buffer.isBuffer(value.key) || value.key.length !== 32
      || !Number.isSafeInteger(value.keyVersion) || value.keyVersion < 1
      || value.keyVersion > 2_147_483_647) {
    persistenceError('integrity_failure');
  }
}

function summarizeProjection(
  source: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  sourceRevision: string | null,
): Record<string, unknown> {
  const summaries: Record<string, unknown> = {};
  for (const pointer of fields) {
    const field = pointer.slice(1);
    const present = Object.hasOwn(source, field);
    const value = present ? source[field] : undefined;
    const encoded = stableJson(value);
    summaries[pointer] = Object.freeze({
      bytes: Buffer.byteLength(encoded, 'utf8'),
      kind: jsonKind(value),
      present,
      sha256: createHash('sha256').update(encoded, 'utf8').digest('base64url'),
    });
  }
  const encodedRevision = stableJson(sourceRevision);
  return {
    fields: summaries,
    sourceRevisionBytes: Buffer.byteLength(encodedRevision, 'utf8'),
    sourceRevisionSha256: createHash('sha256').update(encodedRevision, 'utf8').digest('base64url'),
  };
}

function jsonKind(value: unknown): 'missing' | 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  persistenceError('invalid_document');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'missing';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([key, item]) =>
    `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) persistenceError('invalid_document');
  return encoded;
}

function assertAggregateBudget(values: readonly unknown[], budget: SyncConflictProjectionBudget): void {
  if (Object.values(budget).some((value) => !Number.isSafeInteger(value) || value < 1)) {
    persistenceError('payload_too_large');
  }
  let bytes = 0;
  let members = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > budget.maxDepth) persistenceError('payload_too_large');
    if (Array.isArray(value)) {
      members += value.length;
      for (const item of value) visit(item, depth + 1);
    } else if (isRecord(value)) {
      const entries = Object.entries(value);
      members += entries.length;
      for (const [, item] of entries) visit(item, depth + 1);
    }
    if (members > budget.maxMembers) persistenceError('payload_too_large');
  };
  for (const value of values) {
    bytes += Buffer.byteLength(stableJson(value), 'utf8');
    if (bytes > budget.maxBytes) persistenceError('payload_too_large');
    visit(value, 1);
  }
}

async function reserveGeneratedId(
  transaction: PostgresSyncSequenceTransaction<SyncPushResult>,
  prefix: string,
): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = `${prefix}${randomBytes(18).toString('base64url')}`;
    const reserved = await transaction.idReservations.reserveAll([{ id, resourceType: 'event' }]);
    if (reserved.state === 'reserved') return id;
  }
  persistenceError('integrity_failure');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
