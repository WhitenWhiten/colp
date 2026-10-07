import type { Generated } from 'kysely';

export interface CollectionTable {
  id: string;
  owner_subject_id: string;
  title: string;
  summary: string | null;
  kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  visibility: 'private' | 'protected' | 'public' | 'unlisted';
  allow_search_indexing: Generated<boolean>;
  search_text: Generated<string>;
  /** R10 Directory q filter text: plain lower() over the NFC title/summary contract. */
  directory_search_text: Generated<string>;
  search_vector: Generated<unknown>;
  publication_slug: Generated<string | null>;
  published_at: Generated<Date | null>;
  root_node_id: string;
  root_node_is_root: boolean;
  resource_revision: string;
  content_revision: string;
  policy_revision: string;
  /**
   * ADR-0021 / 02 §4.2: coarse authorization-cache generation.
   * Invalidates caches; mutation still re-checks policy_revision under the
   * collection row lock. Not Wire/payload authority.
   */
  authz_cache_version: Generated<bigint>;
  commit_ordinal: bigint;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  /** P-04: live nodes (`deleted_at IS NULL`); maintained by the nodes trigger. */
  live_node_count: Generated<number>;
  /** ADR-0007 expand: canonical resource payload (nullable until dual-write contract). */
  payload_json: Record<string, unknown> | null;
  payload_schema_version: number | null;
  payload_authority_status: 'pending' | 'backfilled' | 'malformed' | null;
}

export interface NodeTable {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: 'folder' | 'bookmark' | 'separator';
  is_root: boolean;
  title: string | null;
  url: string | null;
  search_url_host: Generated<string | null>;
  search_text: Generated<string>;
  search_vector: Generated<unknown>;
  description: string | null;
  tags: unknown | null;
  visibility: 'inherit' | 'protected' | 'private';
  position_token: string | null;
  resource_revision: string;
  children_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_commit_ordinal: bigint | null;
  /** ADR-0007 expand: canonical resource payload (nullable until dual-write contract). */
  payload_json: Record<string, unknown> | null;
  payload_schema_version: number | null;
  payload_authority_status: 'pending' | 'backfilled' | 'malformed' | null;
}
