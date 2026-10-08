import { randomBytes } from 'node:crypto';
import { defineClosedPayloadValidator, type EventPayloadRegistration } from './envelope.js';
import { OutboxDeliveryError, type OutboxHandlerContext, type OutboxRoute } from './router.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { databaseNow } from '../database/time.js';

export const COLLECTION_INVITE_CREATED_EVENT_TYPE = 'collection.invite-created' as const;
export const COLLECTION_INVITE_CREATED_EVENT_VERSION = 1 as const;
export const COLLECTION_INVITE_EMAIL_HANDLER_NAME = 'collection_invite_email' as const;
export const COLLECTION_INVITE_EMAIL_HANDLER_MODE = 'delivery_each_event' as const;

const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value;

const validateCollectionInviteCreatedPayload = defineClosedPayloadValidator({
  inviteId: identity,
});

export const collectionInviteCreatedEnvelopeRegistration: EventPayloadRegistration = Object.freeze({
  eventType: COLLECTION_INVITE_CREATED_EVENT_TYPE,
  eventVersion: COLLECTION_INVITE_CREATED_EVENT_VERSION,
  validatePayload: validateCollectionInviteCreatedPayload,
});

export interface AppendCollectionInviteCreatedOutboxInput {
  readonly inviteId: string;
  readonly collectionId: string;
  readonly now?: Date;
}

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

export async function appendCollectionInviteCreatedOutbox(
  transaction: DatabaseTransaction,
  input: AppendCollectionInviteCreatedOutboxInput,
): Promise<void> {
  const occurredAt = input.now ?? await databaseNow(transaction);
  const outboxId = generateOutboxId();
  const domainEventId = generateOutboxId();
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
    event_type: COLLECTION_INVITE_CREATED_EVENT_TYPE,
    event_version: COLLECTION_INVITE_CREATED_EVENT_VERSION,
    handler_name: COLLECTION_INVITE_EMAIL_HANDLER_NAME,
    handler_mode: COLLECTION_INVITE_EMAIL_HANDLER_MODE,
    aggregate_type: 'collection-invite',
    aggregate_id: input.inviteId,
    aggregate_scope: input.collectionId,
    aggregate_revision: null,
    commit_ordinal: null,
    occurred_at: occurredAt,
    payload_json: { inviteId: input.inviteId },
    state: 'pending',
    attempt_count: 0,
    available_at: occurredAt,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    dead_lettered_at: null,
  }).execute();
}

export function createCollectionInviteEmailOutboxRoute(options: {
  processOne: (input: {
    readonly inviteId: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly disposition: string }>;
}): OutboxRoute {
  return Object.freeze({
    handlerName: COLLECTION_INVITE_EMAIL_HANDLER_NAME,
    handlerMode: COLLECTION_INVITE_EMAIL_HANDLER_MODE,
    eventType: COLLECTION_INVITE_CREATED_EVENT_TYPE,
    eventVersion: COLLECTION_INVITE_CREATED_EVENT_VERSION,
    sideEffectDurability: 'durable' as const,
    routeClass: 'projection' as const,
    async handle(context: OutboxHandlerContext): Promise<void> {
      context.signal.throwIfAborted();
      if (!validateCollectionInviteCreatedPayload(context.envelope.payload)) {
        throw new OutboxDeliveryError('permanent', 'collection invite email payload is invalid');
      }
      const payload = context.envelope.payload as { readonly inviteId: string };
      const result = await options.processOne({
        inviteId: payload.inviteId,
        signal: context.signal,
      });
      if (result.disposition === 'retryable' || result.disposition === 'lease_lost') {
        throw new OutboxDeliveryError('retryable', `collection invite email ${result.disposition}`);
      }
    },
  });
}
