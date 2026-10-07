import { sql, type Kysely } from 'kysely';
import type {
  GetNodeReadableReplicaPorts,
  ReadableReplicaBookmarkLoad,
  ReadableReplicaEnqueuePorts,
  ReadableReplicaEnqueueState,
  ReadableReplicaEnqueueUnitOfWork,
  ReadableReplicaFailureCode,
  ReadableReplicaReadPort,
  ReadableReplicaReadUnitOfWork,
  ReadableReplicaRow,
  ReadableReplicaSection,
  ReadableReplicaStoredStatus,
} from '../../modules/collections/index.js';
import { createPostgresAccessPolicyFactsPort } from '../access-policy/index.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresCollectionsClock } from './repositories.js';

const FAILURE_CODES = new Set<ReadableReplicaFailureCode>([
  'not_html', 'empty', 'timeout', 'denied', 'too_large', 'http', 'dns', 'invalid_url',
]);
const STORED_STATUSES = new Set<ReadableReplicaStoredStatus>([
  'pending', 'ready', 'failed', 'unsupported',
]);

type JoinedReplicaRow = {
  node_id: string;
  collection_id: string;
  bookmark_url: string | null;
  replica_status: string | null;
  source_url: string | null;
  title: string | null;
  byline: string | null;
  word_count: number | null;
  sections: unknown;
  failure_code: string | null;
  etag: string | null;
  extracted_at: Date | null;
  enqueued_at: Date | null;
};

async function loadJoinedRow(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
  input: { readonly collectionId: string; readonly nodeId: string },
): Promise<JoinedReplicaRow | undefined> {
  return transaction.selectFrom('nodes as n')
    .leftJoin('collection_readable_replicas as r', 'r.node_id', 'n.id')
    .innerJoin('collections as c', 'c.id', 'n.collection_id')
    .select([
      'n.id as node_id',
      'n.collection_id',
      'n.url as bookmark_url',
      'r.status as replica_status',
      'r.source_url',
      'r.title',
      'r.byline',
      'r.word_count',
      'r.sections',
      'r.failure_code',
      'r.etag',
      'r.extracted_at',
      'r.enqueued_at',
    ])
    .where('n.id', '=', input.nodeId)
    .where('n.collection_id', '=', input.collectionId)
    .where('c.deleted_at', 'is', null)
    .where('n.deleted_at', 'is', null)
    .where('n.kind', '=', 'bookmark')
    .where('n.url', 'is not', null)
    .where(sql<boolean>`n.url <> ''`)
    .executeTakeFirst();
}

export function createPostgresReadableReplicaReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): ReadableReplicaReadPort {
  return {
    async loadBookmarkReplica({ collectionId, nodeId }) {
      const row = await loadJoinedRow(transaction, { collectionId, nodeId });
      if (!row || row.bookmark_url === null) return null;
      return {
        nodeId: row.node_id,
        collectionId: row.collection_id,
        bookmarkUrl: row.bookmark_url,
        replica: mapReplica(row),
      } satisfies ReadableReplicaBookmarkLoad;
    },
  };
}

export function createPostgresReadableReplicaUnitOfWork(
  db: Kysely<DatabaseSchema>,
): ReadableReplicaReadUnitOfWork {
  return Object.freeze({
    execute<Result>(work: (ports: GetNodeReadableReplicaPorts) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work({
          accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
          replicas: createPostgresReadableReplicaReadPort(transaction),
        }));
    },
  });
}

export function createPostgresReadableReplicaEnqueuePort(
  transaction: DatabaseTransaction,
) {
  return {
    async loadEnqueueState(input: {
      readonly collectionId: string;
      readonly nodeId: string;
    }): Promise<ReadableReplicaEnqueueState | null> {
      // Lock the canonical node, even when no sidecar exists. Read the sidecar
      // in a separate READ COMMITTED statement after waiting for its predecessor.
      await transaction.selectFrom('nodes').select('id')
        .where('id', '=', input.nodeId).where('collection_id', '=', input.collectionId)
        .forUpdate().executeTakeFirst();
      const row = await loadJoinedRow(transaction, input);
      if (!row || row.bookmark_url === null) return null;
      return {
        nodeId: row.node_id,
        collectionId: row.collection_id,
        bookmarkUrl: row.bookmark_url,
        replica: mapReplica(row),
        enqueuedAt: row.enqueued_at,
      };
    },
    async savePending(input: {
      readonly nodeId: string;
      readonly collectionId: string;
      readonly sourceUrl: string;
      readonly etag: string;
      readonly commandId: string;
      readonly enqueuedAt: Date;
    }): Promise<ReadableReplicaRow> {
      await sql`
        INSERT INTO collection_readable_replicas (
          node_id, collection_id, status, source_url, title, byline, word_count, sections,
          failure_code, etag, extracted_at, updated_at, enqueued_at, lease_owner, lease_until,
          enqueue_command_id
        ) VALUES (
          ${input.nodeId}, ${input.collectionId}, 'pending', ${input.sourceUrl},
          NULL, NULL, 0, '[]'::jsonb, NULL, ${input.etag}, NULL, ${input.enqueuedAt},
          ${input.enqueuedAt}, NULL, NULL, ${input.commandId}
        )
        ON CONFLICT (node_id) DO UPDATE SET
          collection_id = EXCLUDED.collection_id,
          status = 'pending',
          source_url = EXCLUDED.source_url,
          title = NULL,
          byline = NULL,
          word_count = 0,
          sections = '[]'::jsonb,
          failure_code = NULL,
          etag = EXCLUDED.etag,
          extracted_at = NULL,
          updated_at = EXCLUDED.updated_at,
          enqueued_at = EXCLUDED.enqueued_at,
          lease_owner = NULL,
          lease_until = NULL,
          enqueue_command_id = EXCLUDED.enqueue_command_id
      `.execute(transaction);
      return {
        status: 'pending',
        sourceUrl: input.sourceUrl,
        title: null,
        byline: null,
        wordCount: 0,
        extractedAt: null,
        failureCode: null,
        sections: [],
        etag: input.etag,
      };
    },
  };
}

export function createPostgresReadableReplicaEnqueueUnitOfWork(
  db: Kysely<DatabaseSchema>,
): ReadableReplicaEnqueueUnitOfWork {
  return Object.freeze({
    execute<Result>(work: (ports: ReadableReplicaEnqueuePorts) => Promise<Result>): Promise<Result> {
      return createUnitOfWork(db, { isolationLevel: 'read committed' })
        .execute(({ transaction }) => work({
          accessPolicy: createPostgresAccessPolicyFactsPort(transaction),
          replicas: createPostgresReadableReplicaEnqueuePort(transaction),
          receipts: createPostgresProductCommandReceiptPort(transaction),
          clock: createPostgresCollectionsClock(transaction),
        }));
    },
  });
}

function mapReplica(row: {
  replica_status: string | null;
  source_url: string | null;
  title: string | null;
  byline: string | null;
  word_count: number | null;
  sections: unknown;
  failure_code: string | null;
  etag: string | null;
  extracted_at: Date | null;
}): ReadableReplicaBookmarkLoad['replica'] {
  if (row.replica_status === null || row.source_url === null || row.etag === null) return null;
  if (!STORED_STATUSES.has(row.replica_status as ReadableReplicaStoredStatus)) return null;
  return {
    status: row.replica_status as ReadableReplicaStoredStatus,
    sourceUrl: row.source_url,
    title: row.title,
    byline: row.byline,
    wordCount: row.word_count ?? 0,
    extractedAt: row.extracted_at,
    failureCode: asFailureCode(row.failure_code),
    sections: asSections(row.sections),
    etag: row.etag,
  };
}

function asFailureCode(value: string | null): ReadableReplicaFailureCode | null {
  if (value === null) return null;
  return FAILURE_CODES.has(value as ReadableReplicaFailureCode)
    ? value as ReadableReplicaFailureCode
    : null;
}

function asSections(value: unknown): readonly ReadableReplicaSection[] {
  if (!Array.isArray(value)) return [];
  const sections: ReadableReplicaSection[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.heading !== 'string') continue;
    if (!Array.isArray(record.paragraphs)) continue;
    const paragraphs = [];
    for (const paragraph of record.paragraphs) {
      if (paragraph === null || typeof paragraph !== 'object' || Array.isArray(paragraph)) continue;
      const row = paragraph as Record<string, unknown>;
      if (typeof row.id !== 'string' || typeof row.text !== 'string') continue;
      paragraphs.push({ id: row.id, text: row.text });
    }
    sections.push({ id: record.id, heading: record.heading, paragraphs });
  }
  return sections;
}
