import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { databaseNow } from '../database/time.js';
import type { AttachmentRetiredOutboxPayload } from '../../modules/attachments/index.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type VersionedEventEnvelope,
} from './envelope.js';

export const ATTACHMENT_RETIRED_EVENT_TYPE = 'attachments.retired' as const;
export const ATTACHMENT_RETIRED_EVENT_VERSION = 1 as const;
export const ATTACHMENT_RETIRED_HANDLER_NAME = 'attachments_retire_attachment' as const;
export const ATTACHMENT_RETIRED_HANDLER_MODE = 'delivery_each_event' as const;

const MAX_IDENTITY = 256;
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY && value.trim() === value;

const decimalOrdinal = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]+$/u.test(value);

/**
 * Closed payload validator for `attachments.retired@1`. Identity facts ONLY:
 * no filename, no digest, no physical key, no URL, no credential. The
 * consumer re-validates the envelope before any side effect.
 */
const validateAttachmentRetiredPayload = defineClosedPayloadValidator({
  attachmentId: identity,
  blobId: identity,
  collectionId: identity,
  operationId: identity,
  commitOrdinal: decimalOrdinal,
});

export const attachmentRetiredEnvelopeRegistration: EventPayloadRegistration = Object.freeze({
  eventType: ATTACHMENT_RETIRED_EVENT_TYPE,
  eventVersion: ATTACHMENT_RETIRED_EVENT_VERSION,
  validatePayload: validateAttachmentRetiredPayload,
});

/** Validates the envelope and its aggregate binding; returns the payload. */
export function parseAttachmentRetiredPayload(envelope: VersionedEventEnvelope): AttachmentRetiredOutboxPayload {
  if (envelope.event_type !== ATTACHMENT_RETIRED_EVENT_TYPE
    || envelope.event_version !== ATTACHMENT_RETIRED_EVENT_VERSION) {
    throw new InvalidEventEnvelopeError('attachment retired event type/version is invalid');
  }
  const payload = envelope.payload as unknown;
  if (!validateAttachmentRetiredPayload(payload)) {
    throw new InvalidEventEnvelopeError('attachment retired payload is invalid');
  }
  const record = payload as unknown as AttachmentRetiredOutboxPayload;
  if (envelope.aggregate_identity.aggregate_type !== 'blob'
    || envelope.aggregate_identity.aggregate_id !== record.blobId
    || envelope.aggregate_identity.aggregate_scope !== record.attachmentId) {
    throw new InvalidEventEnvelopeError('attachment retired aggregate binding is invalid');
  }
  return Object.freeze({
    attachmentId: record.attachmentId,
    blobId: record.blobId,
    collectionId: record.collectionId,
    operationId: record.operationId,
    commitOrdinal: record.commitOrdinal,
  });
}

export interface AppendAttachmentRetiredOutboxOptions {
  readonly outboxIdGenerator?: () => string;
  readonly occurredAt?: Date;
}

/**
 * Appends the `attachments.retired` outbox row INSIDE the caller's
 * transaction: the Canonical retirement assembly (P4A-P07) calls this through
 * the injected generator, so the metadata retirement, the generation retire,
 * the pointer clear, the Operation/Audit rows and the outbox row commit
 * atomically. The domain event and outbox ids are both reserved in the
 * immutable resource_id_ledger.
 */
export async function appendAttachmentRetiredOutbox(
  transaction: DatabaseTransaction,
  payload: AttachmentRetiredOutboxPayload,
  options: AppendAttachmentRetiredOutboxOptions = {},
): Promise<{ readonly outboxId: string; readonly domainEventId: string }> {
  if (!validateAttachmentRetiredPayload(payload)) {
    throw new InvalidEventEnvelopeError('attachment retired payload is invalid');
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
    event_type: ATTACHMENT_RETIRED_EVENT_TYPE,
    event_version: ATTACHMENT_RETIRED_EVENT_VERSION,
    handler_name: ATTACHMENT_RETIRED_HANDLER_NAME,
    handler_mode: ATTACHMENT_RETIRED_HANDLER_MODE,
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
