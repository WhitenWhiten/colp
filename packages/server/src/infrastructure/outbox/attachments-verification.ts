import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { databaseNow } from '../database/time.js';
import type { VerificationOutboxPayload } from '../../modules/attachments/index.js';
import {
  defineClosedPayloadValidator,
  InvalidEventEnvelopeError,
  type EventPayloadRegistration,
  type VersionedEventEnvelope,
} from './envelope.js';

export const ATTACHMENTS_VERIFICATION_EVENT_TYPE = 'attachments.upload-verified' as const;
export const ATTACHMENTS_VERIFICATION_EVENT_VERSION = 1 as const;
export const ATTACHMENTS_VERIFICATION_HANDLER_NAME = 'attachments_verify_generation' as const;
export const ATTACHMENTS_VERIFICATION_HANDLER_MODE = 'delivery_each_event' as const;

const MAX_IDENTITY = 256;
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTITY && value.trim() === value;

const validateAttachmentsVerificationPayload = defineClosedPayloadValidator({
  blobId: identity,
  generationId: identity,
  intentId: identity,
});

export const attachmentsVerificationEnvelopeRegistration: EventPayloadRegistration = Object.freeze({
  eventType: ATTACHMENTS_VERIFICATION_EVENT_TYPE,
  eventVersion: ATTACHMENTS_VERIFICATION_EVENT_VERSION,
  validatePayload: validateAttachmentsVerificationPayload,
});

/** Validates the envelope and its aggregate binding; returns the payload. */
export function parseAttachmentsVerificationPayload(envelope: VersionedEventEnvelope): VerificationOutboxPayload {
  if (envelope.event_type !== ATTACHMENTS_VERIFICATION_EVENT_TYPE
    || envelope.event_version !== ATTACHMENTS_VERIFICATION_EVENT_VERSION) {
    throw new InvalidEventEnvelopeError('attachments verification event type/version is invalid');
  }
  const payload = envelope.payload as unknown;
  if (!validateAttachmentsVerificationPayload(payload)) {
    throw new InvalidEventEnvelopeError('attachments verification payload is invalid');
  }
  const record = payload as unknown as VerificationOutboxPayload;
  if (envelope.aggregate_identity.aggregate_type !== 'blob'
    || envelope.aggregate_identity.aggregate_id !== record.blobId
    || envelope.aggregate_identity.aggregate_scope !== record.generationId) {
    throw new InvalidEventEnvelopeError('attachments verification aggregate binding is invalid');
  }
  return Object.freeze({
    blobId: record.blobId,
    generationId: record.generationId,
    intentId: record.intentId,
  });
}

export interface AppendAttachmentsVerificationOutboxOptions {
  readonly outboxIdGenerator?: () => string;
  readonly occurredAt?: Date;
}

/**
 * Appends the verification outbox row INSIDE the caller's transaction (the
 * complete use case calls this through its injected enqueue dep, so the CAS
 * `issued -> uploaded` and the outbox row commit atomically — plan §6 I09
 * "Outbox与uploaded同commit").
 */
export async function appendAttachmentsVerificationOutbox(
  transaction: DatabaseTransaction,
  payload: VerificationOutboxPayload,
  options: AppendAttachmentsVerificationOutboxOptions = {},
): Promise<string> {
  if (!validateAttachmentsVerificationPayload(payload)) {
    throw new InvalidEventEnvelopeError('attachments verification payload is invalid');
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
    event_type: ATTACHMENTS_VERIFICATION_EVENT_TYPE,
    event_version: ATTACHMENTS_VERIFICATION_EVENT_VERSION,
    handler_name: ATTACHMENTS_VERIFICATION_HANDLER_NAME,
    handler_mode: ATTACHMENTS_VERIFICATION_HANDLER_MODE,
    aggregate_type: 'blob',
    aggregate_id: payload.blobId,
    aggregate_scope: payload.generationId,
    aggregate_revision: null,
    commit_ordinal: null,
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
  return outboxId;
}
