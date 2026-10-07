import { generateOpaqueId } from '../../modules/identity/index.js';
import type { CollaborationHttpPorts, CollaborationUnitOfWork } from '../../modules/access-policy/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresCollaborationQueryPort } from '../access-policy/collaboration-query.js';
import {
  createPostgresCollaborationStorePort,
  suppressUnsentInviteDeliveries,
} from '../access-policy/collaboration-store.js';
import { createPostgresCollectionPolicyRevisionPort } from '../collections/policy-revision-port.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { databaseNow } from '../database/time.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresVerifiedAccountEmailPort } from '../identity/index.js';
import { appendCollectionInviteCreatedOutbox } from '../outbox/collection-invite-email.js';
import type { Kysely } from 'kysely';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';

export interface CollaborationCommandPortOptions {
  readonly inviteEmailEnabled?: boolean;
  readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort;
}

export function createPostgresCollaborationCommandPorts(
  transaction: DatabaseTransaction,
  options: CollaborationCommandPortOptions = {},
): CollaborationHttpPorts {
  const inviteEmailEnabled = options.inviteEmailEnabled === true;
  return {
    receipts: createPostgresProductCommandReceiptPort(transaction),
    clock: { now: () => databaseNow(transaction) },
    ids: { nextInviteId: generateOpaqueId },
    identity: createPostgresVerifiedAccountEmailPort(transaction),
    facts: createPostgresAccessPolicyFactsPort(transaction),
    collections: createPostgresCollectionPolicyRevisionPort(transaction, options),
    store: createPostgresCollaborationStorePort(transaction),
    query: createPostgresCollaborationQueryPort(transaction),
    audit: {
      async append(event) {
        await appendAuditEvent(transaction, {
          operationId: null, collectionId: null, principalId: event.principalId,
          eventType: event.eventType, details: { ...event.details }, createdAt: event.createdAt,
        });
      },
    },
    inviteEmail: {
      enabled: inviteEmailEnabled,
      async insertDeliveryIfAbsent(input) {
        const pending = inviteEmailEnabled;
        const inserted = await transaction
          .insertInto('collection_invite_deliveries')
          .values({
            delivery_id: input.deliveryId,
            invite_id: input.inviteId,
            state: pending ? 'pending' : 'suppressed',
            attempt_count: 0,
            state_revision: 1n,
            next_attempt_at: input.now,
            leased_until: null,
            delivered_at: null,
            suppressed_at: pending ? null : input.now,
            dead_lettered_at: null,
            last_error_category: pending ? null : 'not_configured',
            provider_message_id: null,
            created_at: input.now,
            updated_at: input.now,
          })
          .onConflict((oc) => oc.column('invite_id').doNothing())
          .returning('delivery_id')
          .executeTakeFirst();
        return inserted ? 'inserted' : 'exists';
      },
      async suppressIfUnsent(inviteId, now) {
        const updated = await suppressUnsentInviteDeliveries(transaction, [inviteId], now);
        return updated > 0;
      },
    },
    inviteOutbox: {
      async appendInviteCreated(input) {
        await appendCollectionInviteCreatedOutbox(transaction, {
          inviteId: input.inviteId,
          collectionId: input.collectionId,
          now: input.now,
        });
      },
    },
  };
}

export function createPostgresCollaborationUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: CollaborationCommandPortOptions = {},
): CollaborationUnitOfWork {
  return {
    execute(work) {
      return createUnitOfWork(db).execute(async ({ transaction }) => (
        work(createPostgresCollaborationCommandPorts(transaction, options))
      ));
    },
  };
}
