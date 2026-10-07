import type { DatabaseRuntime } from '../database/index.js';
import { readBackendPid, withPostgresAbort } from '../database/index.js';
import { COLLECTION_CATALOG_LANGUAGE_SQL, COLLECTION_CATALOG_TAGS_SQL } from './postgres-directory-read.js';
import type {
  PublicationMetadataReadPort,
  PublicationMetadataRecord,
} from '../../modules/publication/index.js';

interface MetadataRow {
  id: string;
  owner_subject_id: string;
  kind: PublicationMetadataRecord['kind'];
  title: string;
  summary: string | null;
  visibility: PublicationMetadataRecord['visibility'];
  publication_slug: string | null;
  root_node_id: string;
  root_available: boolean;
  content_revision: string;
  policy_revision: string;
  tags: unknown;
  language: unknown;
  membership_role: PublicationMetadataRecord['membershipRole'];
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export function createPostgresPublicationMetadataReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
): PublicationMetadataReadPort {
  return Object.freeze({
    async load(input: Parameters<PublicationMetadataReadPort['load']>[0]) {
      const actor = input.actorSubjectId ?? '';
      const text = `select c.id, c.owner_subject_id, c.kind, c.title, c.summary, c.visibility,
                c.publication_slug, c.root_node_id, c.content_revision, c.policy_revision,
                (root.id is not null) as root_available,
                ${COLLECTION_CATALOG_TAGS_SQL} as tags,
                ${COLLECTION_CATALOG_LANGUAGE_SQL} as language,
                case when c.owner_subject_id = $2 then 'owner' else member.role end as membership_role,
                c.created_at, c.updated_at, c.deleted_at
           from collections c
           left join nodes root
             on root.collection_id = c.id and root.id = c.root_node_id
            and root.is_root and root.deleted_at is null
           left join collection_members member
             on member.collection_id = c.id and member.subject_id = $2
          where ${input.collectionId !== undefined ? 'c.id' : 'c.publication_slug'} = $1`;
      const values: unknown[] = [input.collectionId ?? input.publicationSlug, actor];
      if (input.signal === undefined) {
        // Fast path (zero extra round trips): the pooled query hides the client.
        const result = await runtime.pool.query<MetadataRow>(text, values);
        const row = result.rows[0];
        if (!row) return null;
        return mapRecord(row);
      }
      // Abort-aware path: check out a client so the exact backend PID is
      // known; on abort a controlled pg_cancel_backend stops the query and
      // the caller rejects with signal.reason (never a query_canceled error).
      const client = await runtime.pool.connect();
      try {
        const pid = await readBackendPid(client, input.signal);
        const cancel = async (): Promise<void> => {
          if (pid !== undefined) await runtime.cancelBackend(pid);
        };
        const result = await withPostgresAbort(
          client.query<MetadataRow>(text, values),
          input.signal,
          cancel,
        );
        const row = result.rows[0];
        if (!row) return null;
        return mapRecord(row);
      } finally {
        client.release();
      }
    },
  });
}

function mapRecord(row: MetadataRow): PublicationMetadataRecord {
  return Object.freeze({
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    publicationSlug: row.publication_slug,
    rootNodeId: row.root_node_id,
    rootAvailable: row.root_available,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    tags: Object.freeze(Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : []),
    language: typeof row.language === 'string' && row.language !== '' ? row.language : null,
    membershipRole: row.membership_role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
  });
}
