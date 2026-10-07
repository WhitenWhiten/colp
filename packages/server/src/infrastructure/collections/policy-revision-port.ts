import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { generateRevisionToken } from '../../modules/collections/index.js';
import type { CollectionPolicyRevisionPort } from '../../modules/access-policy/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { ReportSourceInvalidationOutboxPort } from '../outbox/report-source-invalidation-producer.js';
import {
  PUBLICATION_CACHE_PURGE_EVENT_TYPE,
  PUBLICATION_CACHE_PURGE_EVENT_VERSION,
  PUBLICATION_CACHE_PURGE_HANDLER_NAME,
} from '../outbox/publication-cache-purge.js';

/**
 * Cause recorded on the CDN purge v2 payload for membership/policy bumps.
 * This is not a Worker-claimed domain event and does not write `operations`.
 */
export const POLICY_REVISION_SOURCE_EVENT_TYPE = 'collection.policy_revision.advanced';
export const POLICY_REVISION_SOURCE_EVENT_VERSION = 1 as const;

function generateOutboxId(): string {
  return randomBytes(16).toString('base64url');
}

async function reserve(
  transaction: DatabaseTransaction,
  resourceId: string,
  resourceType: string,
): Promise<void> {
  await transaction.insertInto('resource_id_ledger').values({
    resource_id: resourceId,
    resource_type: resourceType,
  }).execute();
}

/**
 * Copy of the PUBLICATION_CACHE_PURGE outbox envelope from
 * canonical-mutation-postgres-ports.ts (~1548). Do not import that module:
 * it would introduce a second collection lock path. Callers already hold
 * FOR UPDATE on the collection row.
 *
 * Skip honestly when publication_slug is null (private unpublished) or
 * published_at is null — there is no Publication cache to purge.
 */
async function appendPublicationCachePurgeIfPublished(
  transaction: DatabaseTransaction,
  collectionId: string,
  facts: {
    readonly publicationSlug: string | null;
    readonly publishedAt: Date | null;
    readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
    readonly contentRevision: string;
    readonly policyRevision: string;
    readonly commitOrdinal: bigint;
  },
): Promise<void> {
  if (facts.publicationSlug === null || facts.publishedAt === null) return;

  const domainEventId = generateOutboxId();
  const purgeOutboxId = generateOutboxId();
  await reserve(transaction, domainEventId, 'domain-event');
  await reserve(transaction, purgeOutboxId, 'outbox');
  await transaction.insertInto('outbox_events').values({
    outbox_id: purgeOutboxId,
    domain_event_id: domainEventId,
    event_type: PUBLICATION_CACHE_PURGE_EVENT_TYPE,
    event_version: PUBLICATION_CACHE_PURGE_EVENT_VERSION,
    handler_name: PUBLICATION_CACHE_PURGE_HANDLER_NAME,
    handler_mode: 'delivery_each_event',
    aggregate_scope: collectionId,
    aggregate_revision: facts.contentRevision,
    commit_ordinal: facts.commitOrdinal > 0n ? facts.commitOrdinal : null,
    payload_json: {
      collectionId,
      contentRevision: facts.contentRevision,
      policyRevision: facts.policyRevision,
      publicationSlug: facts.publicationSlug,
      sourceEventType: POLICY_REVISION_SOURCE_EVENT_TYPE,
      sourceEventVersion: POLICY_REVISION_SOURCE_EVENT_VERSION,
      visibility: facts.visibility,
    },
    state: 'pending',
    attempt_count: 0,
    available_at: sql<Date>`current_timestamp`,
    locked_until: null,
    lease_generation: 0n,
    completed_at: null,
    last_error: null,
    aggregate_type: 'collection',
    aggregate_id: collectionId,
    occurred_at: sql<Date>`current_timestamp`,
    dead_lettered_at: null,
  }).execute();
}

/**
 * FOR UPDATE lock plus policy_revision bump. Dual-writes payload_json.policyRevision
 * so later Canonical Mutation locks keep collection authority. Advances
 * collections.authz_cache_version in the same statement. Does not change
 * content_revision, commit_ordinal, or write COLP operations. Must run in the
 * same transaction as the membership or invite mutation.
 */
export function createPostgresCollectionPolicyRevisionPort(
  transaction: DatabaseTransaction,
  options: { readonly reportSourceInvalidation?: ReportSourceInvalidationOutboxPort } = {},
): CollectionPolicyRevisionPort {
  return {
    async lockForUpdate(collectionId) {
      const row = await transaction
        .selectFrom('collections')
        .select([
          'id',
          'owner_subject_id',
          'visibility',
          'policy_revision',
          'content_revision',
          'deleted_at',
          'title',
        ])
        .where('id', '=', collectionId)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return null;
      return {
        collectionId: row.id,
        ownerSubjectId: row.owner_subject_id,
        visibility: row.visibility,
        policyRevision: row.policy_revision,
        contentRevision: row.content_revision,
        title: row.title,
        deletedAt: row.deleted_at,
      };
    },

    async bumpPolicyRevision(collectionId) {
      const now = await databaseNow(transaction);
      const token = generateRevisionToken();
      const maxRow = await transaction
        .selectFrom('policy_revisions')
        .select((eb) => eb.fn.max('ordinal').as('max'))
        .where('collection_id', '=', collectionId)
        .executeTakeFirst();
      const nextOrdinal = BigInt(maxRow?.max ?? 0) + 1n;
      await transaction
        .insertInto('policy_revisions')
        .values({
          collection_id: collectionId,
          revision: token,
          ordinal: nextOrdinal,
          created_at: now,
        })
        .execute();
      const updated = await transaction
        .updateTable('collections')
        .set({
          policy_revision: token,
          authz_cache_version: sql<bigint>`authz_cache_version + 1`,
        })
        .where('id', '=', collectionId)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) {
        throw new Error('collection was not found for policy revision bump');
      }
      const row = await transaction
        .selectFrom('collections')
        .select([
          'payload_json',
          'publication_slug',
          'published_at',
          'visibility',
          'content_revision',
          'commit_ordinal',
        ])
        .where('id', '=', collectionId)
        .executeTakeFirst();
      if (row?.payload_json) {
        await transaction
          .updateTable('collections')
          .set({
            payload_json: { ...row.payload_json, policyRevision: token },
          })
          .where('id', '=', collectionId)
          .execute();
      }
      if (row) {
        await appendPublicationCachePurgeIfPublished(transaction, collectionId, {
          publicationSlug: row.publication_slug,
          publishedAt: row.published_at,
          visibility: row.visibility,
          contentRevision: row.content_revision,
          policyRevision: token,
          commitOrdinal: BigInt(row.commit_ordinal),
        });
        if (options.reportSourceInvalidation) await options.reportSourceInvalidation.append(transaction, {
          domainEventId: `policy:${collectionId}:${token}`,
          collectionId,
          sourceEventType: POLICY_REVISION_SOURCE_EVENT_TYPE,
          sourceEventVersion: POLICY_REVISION_SOURCE_EVENT_VERSION,
          contentRevision: row.content_revision,
          policyRevision: token,
          commitOrdinal: BigInt(row.commit_ordinal),
        });
      }
      return token;
    },
  };
}

/** Lock then bump in one call. Callers that skip bump (duplicate accept) must not use this. */
export async function lockCollectionAndBumpPolicyRevision(
  port: CollectionPolicyRevisionPort,
  collectionId: string,
): Promise<{ readonly policyRevision: string } | null> {
  const locked = await port.lockForUpdate(collectionId);
  if (!locked) return null;
  const policyRevision = await port.bumpPolicyRevision(collectionId);
  return { policyRevision };
}
