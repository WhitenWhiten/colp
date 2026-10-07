import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { databaseNow } from '../database/time.js';
import type { AttachmentFinalizedOutboxPayload } from '../../modules/attachments/index.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type VersionedEventEnvelope,
} from './envelope.js';

export const ATTACHMENT_FINALIZED_EVENT_TYPE = 'attachments.finalized' as const;
export const ATTACHMENT_FINALIZED_EVENT_VERSION = 1 as const;
export const ATTACHMENT_FINALIZED_HANDLER_NAME = 'attachments_finalize_attachment' as const;
export const ATTACHMENT_FINALIZED_HANDLER_MODE = 'delivery_each_event' as const;

const MAX_IDENTITY = 256;
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY && value.trim() === value;

const decimalOrdinal = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]+$/u.test(value);

/**
 * Closed payload validator for `attachments.finalized@1`. Identity facts ONLY:
 * no filename, no digest, no physical key, no URL, no credential. The
 * consumer (P4A-P05/P06) re-validates the envelope before any side effect.
 */
const validateAttachmentFinalizedPayload = defineClosedPayloadValidator({
  attachmentId: identity,
  blobId: identity,
  collectionId: identity,
  operationId: identity,
  commitOrdinal: decimalOrdinal,
});

export const attachmentFinalizedEnvelopeRegistration: EventPayloadRegistration = Object.freeze({
  eventType: ATTACHMENT_FINALIZED_EVENT_TYPE,
  eventVersion: ATTACHMENT_FINALIZED_EVENT_VERSION,
  validatePayload: validateAttachmentFinalizedPayload,
});

/** Validates the envelope and its aggregate binding; returns the payload. */
export function parseAttachmentFinalizedPayload(envelope: VersionedEventEnvelope): AttachmentFinalizedOutboxPayload {
  if (envelope.event_type !== ATTACHMENT_FINALIZED_EVENT_TYPE
    || envelope.event_version !== ATTACHMENT_FINALIZED_EVENT_VERSION) {
    throw new InvalidEventEnvelopeError('attachment finalized event type/version is invalid');
  }
  const payload = envelope.payload as unknown;
  if (!validateAttachmentFinalizedPayload(payload)) {
    throw new InvalidEventEnvelopeError('attachment finalized payload is invalid');
  }
  const record = payload as unknown as AttachmentFinalizedOutboxPayload;
  if (envelope.aggregate_identity.aggregate_type !== 'blob'
    || envelope.aggregate_identity.aggregate_id !== record.blobId
    || envelope.aggregate_identity.aggregate_scope !== record.attachmentId) {
    throw new InvalidEventEnvelopeError('attachment finalized aggregate binding is invalid');
  }
  return Object.freeze({
    attachmentId: record.attachmentId,
    blobId: record.blobId,
    collectionId: record.collectionId,
    operationId: record.operationId,
    commitOrdinal: record.commitOrdinal,
  });
}

export interface AppendAttachmentFinalizedOutboxOptions {
  readonly outboxIdGenerator?: () => string;
  readonly occurredAt?: Date;
}

/**
 * Appends the `attachments.finalized` outbox row INSIDE the caller's
 * transaction: the Canonical finalize assembly (P4A-P02) calls this through
 * the injected generator, so the metadata row, the ledger reservations, the
 * Operation/Audit rows and the outbox row commit atomically (plan §6 P02 —
 * rollback leaves the outbox surface byte-identical). The domain event and
 * outbox ids are both reserved in the immutable resource_id_ledger.
 */
export async function appendAttachmentFinalizedOutbox(
  transaction: DatabaseTransaction,
  payload: AttachmentFinalizedOutboxPayload,
  options: AppendAttachmentFinalizedOutboxOptions = {},
): Promise<{ readonly outboxId: string; readonly domainEventId: string }> {
  if (!validateAttachmentFinalizedPayload(payload)) {
    throw new InvalidEventEnvelopeError('attachment finalized payload is invalid');
  }
  const outboxId = (options.outboxIdGenerator ?? randomUUID)();
  const domainEventId = randomUUID();
  const occurredAt = options.occurredAt ?? await databaseNow(transaction);
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: outboxId,
    resource_type: 'outbox',
  }).execute();
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: domainEventId,
    resource_type: 'outbox',
  }).execute();
  await transaction.insertInto('outbox_events').values({
    outbox_id: outboxId,
    domain_event_id: domainEventId,
    event_type: ATTACHMENT_FINALIZED_EVENT_TYPE,
    event_version: ATTACHMENT_FINALIZED_EVENT_VERSION,
    handler_name: ATTACHMENT_FINALIZED_HANDLER_NAME,
    handler_mode: ATTACHMENT_FINALIZED_HANDLER_MODE,
    aggregate_type: 'blob',
    aggregate_id: payload.blobId,
    aggregate_scope: payload.attachmentId,
    aggregate_revision: null,
    commit_ordinal: BigInt(payload.commitOrdinal),
    occurred_at: occurredAt,
    payload_json: { ...payload } as unknown as Record<string, unknown>,
    state: 'pending',
    attempt_count: 0,
    available_at: occurredAt,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    dead_lettered_at: null,
  }).execute();
  return { outboxId, domainEventId };
}
