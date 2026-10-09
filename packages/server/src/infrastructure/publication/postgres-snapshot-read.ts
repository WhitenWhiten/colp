import type { PoolClient } from 'pg';
import {
  readBackendPid,
  rollbackTransaction,
  withPostgresAbort,
  type DatabaseRuntime,
} from '../database/index.js';
import {
  PUBLICATION_PIN_EXTENSION,
  PUBLICATION_SNAPSHOT_COMPARATOR_VERSION,
  PublicationSnapshotAnchorNotFoundError,
  type PublicationCollectionRecord,
  type PublicationNodeRecord,
  type PublicationSnapshotPosition,
  type PublicationSnapshotReadPage,
  type PublicationSnapshotReadPort,
  type PublicationSnapshotReadRequest,
} from '../../modules/publication/index.js';
import {
  bookmarkHidePublicExistsSql,
  buildPublicationTargetAncestorRestrictionSql,
} from '../database/collection-control-sql.js';
import { nodeExtensionFlagSql } from '../database/node-extension-sql.js';

interface CollectionRow {
  id: string;
  owner_subject_id: string;
  kind: PublicationCollectionRecord['kind'];
  title: string;
  summary: string | null;
  visibility: PublicationCollectionRecord['visibility'];
  publication_slug: string | null;
  root_node_id: string;
  content_revision: string;
  policy_revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  bookmark_hide_digest?: string | null;
}

interface NodeRow {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: PublicationNodeRecord['kind'];
  is_root: boolean;
  title: string;
  url: string | null;
  description: string | null;
  tags: unknown;
  visibility: PublicationNodeRecord['visibility'];
  ancestor_restricted?: boolean;
  moderation_hidden?: boolean;
  pinned?: boolean;
  position_token: string | null;
  publication_position: string | null;
  resource_revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface PublicationSnapshotSqlStatement {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface PostgresPublicationSnapshotReadOptions {
  /** Test/evidence observation point after PostgreSQL has established the MVCC snapshot. */
  readonly afterSnapshotEstablished?: () => Promise<void>;
}

export function createPostgresPublicationSnapshotReadPort(
  runtime: Pick<DatabaseRuntime, 'pool' | 'cancelBackend'>,
  options: PostgresPublicationSnapshotReadOptions = {},
): PublicationSnapshotReadPort {
  return Object.freeze({
    async loadPage(request: PublicationSnapshotReadRequest): Promise<PublicationSnapshotReadPage> {
      validateRequest(request);
      const client = await runtime.pool.connect();
      try {
        // Abort-aware statements: the exact backend PID (only when the request
        // is abortable) enables a controlled pg_cancel_backend on cancellation;
        // the read rejects with signal.reason and the catch below then rolls
        // the read-only transaction back.
        const signal = request.signal;
        await withPostgresAbort(
          client.query('begin isolation level repeatable read read only'),
          signal,
          () => Promise.resolve(),
        );
        const pid = await readBackendPid(client, signal);
        const cancel = async (): Promise<void> => {
          if (pid !== undefined) await runtime.cancelBackend(pid);
        };
        const isolation = await withPostgresAbort(
          client.query<{ isolation: string }>(
            "select current_setting('transaction_isolation') as isolation",
          ),
          signal,
          cancel,
        );
        if (isolation.rows[0]?.isolation !== 'repeatable read') {
          throw new Error('Publication Snapshot read transaction is not repeatable read');
        }
        const collectionResult = await withPostgresAbort(
          client.query<CollectionRow>(
            `select id, owner_subject_id, kind, title, summary, visibility, publication_slug,
                    root_node_id, content_revision, policy_revision, created_at, updated_at, deleted_at,
                    (select publication_locator_sha256_128(string_agg(ma.target_id, ',' order by ma.target_id))
                       from moderation_actions ma
                      where ma.target_kind = 'bookmark' and ma.parent_id = collections.id
                        and ma.state = 'active' and ma.action = 'hide_public') as bookmark_hide_digest
               from collections
              where id = $1
                and exists (
                  select 1 from accounts owner_account
                   where owner_account.subject_id = collections.owner_subject_id
                     and owner_account.status = 'active'
                     and owner_account.deleted_at is null
                )`,
            [request.collectionId],
          ),
          signal,
          cancel,
        );
        const collectionRow = collectionResult.rows[0] ?? null;
        if (collectionRow === null) {
          await withPostgresAbort(client.query('commit'), signal, cancel);
          return freezePage(null, null, []);
        }
        await options.afterSnapshotEstablished?.();
        const rootResult = await withPostgresAbort(
          client.query<NodeRow>(
            `select id, collection_id, parent_id, kind, is_root, title, url, description,
                    tags, visibility, position_token, null::text as publication_position,
                    resource_revision, created_at, updated_at,
                      exists (
                      with recursive ancestors as (
                        select parent.id, parent.parent_id, parent.visibility
                          from nodes parent
                         where parent.collection_id = root_node.collection_id
                           and parent.id = root_node.parent_id
                        union all
                        select parent.id, parent.parent_id, parent.visibility
                          from nodes parent join ancestors child on parent.id = child.parent_id
                         where parent.collection_id = root_node.collection_id
                      )
                      select 1 from ancestors where visibility in ('private', 'protected')
                    ) as ancestor_restricted,
                    ${bookmarkHidePublicExistsSql('root_node.id', 'root_node.collection_id')} as moderation_hidden
               from nodes root_node
              where collection_id = $1 and id = $2
                and ($3::boolean or is_root) and deleted_at is null`,
            [collectionRow.id, request.rootId ?? collectionRow.root_node_id, request.rootId !== undefined],
          ),
          signal,
          cancel,
        );
        const candidates = request.metadataOnly
          ? []
          : await withPostgresAbort(
            loadCandidates(client, await withPostgresAbort(resolveCandidateRequest(client, request), signal, cancel)),
            signal,
            cancel,
          );
        await withPostgresAbort(client.query('commit'), signal, cancel);
        return freezePage(
          mapCollection(collectionRow),
          rootResult.rows[0] ? mapNode(rootResult.rows[0]) : null,
          candidates.map(mapNode),
        );
      } catch (error) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Publication snapshot read');
        throw error;
      } finally {
        client.release();
      }
    },
    async isPublicCacheCurrent(collectionId: string, revision: string): Promise<boolean> {
      const result = await runtime.pool.query<{ current: boolean }>(
        `select (
           c.deleted_at is null
           and c.publication_slug is not null
           and c.published_at is not null
           and c.content_revision::text || '.' || c.policy_revision::text = $2
           and owner_account.status = 'active'
           and owner_account.deleted_at is null
         ) as current
           from collections c
           join accounts owner_account on owner_account.subject_id = c.owner_subject_id
          where c.id = $1`,
        [collectionId, revision],
      );
      return result.rows[0]?.current === true;
    },
  });
}

async function resolveCandidateRequest(
  client: PoolClient,
  request: PublicationSnapshotReadRequest,
): Promise<PublicationSnapshotReadRequest> {
  const after = await resolveContinuation(client, request);
  return after === undefined
    ? request
    : (({ afterLocator: _afterLocator, ...rest }) => ({ ...rest, after }))(request);
}

async function resolveContinuation(
  client: PoolClient,
  request: PublicationSnapshotReadRequest,
): Promise<PublicationSnapshotPosition | undefined> {
  if (request.after !== undefined) return request.after;
  if (request.afterLocator === undefined) return undefined;
  const result = await client.query<Pick<NodeRow, 'id' | 'parent_id' | 'position_token'>>(
    `select id, parent_id, position_token
      from nodes
      where collection_id = $1 and not is_root and deleted_at is null
        and publication_locator_sha256_128(id) = $2`,
    [request.collectionId, request.afterLocator],
  );
  const anchor = result.rows.length === 1 ? result.rows[0] : undefined;
  if (!anchor?.parent_id || !anchor.position_token) throw new PublicationSnapshotAnchorNotFoundError();
  return { parentId: anchor.parent_id, position: anchor.position_token, nodeId: anchor.id };
}

async function loadCandidates(
  client: PoolClient,
  request: PublicationSnapshotReadRequest,
): Promise<readonly NodeRow[]> {
  const statement = buildPublicationSnapshotCandidateStatement(request);
  const result = await client.query<NodeRow>(statement.text, [...statement.values]);
  return result.rows;
}

export function buildPublicationSnapshotCandidateStatement(
  request: PublicationSnapshotReadRequest,
): PublicationSnapshotSqlStatement {
  validateRequest(request);
  if (request.afterLocator !== undefined) {
    throw new TypeError('Publication Snapshot candidate statement requires a resolved continuation tuple');
  }
  if (request.rootId !== undefined || request.depth !== undefined) {
    return buildScopedCandidateStatement(request);
  }
  const values: unknown[] = [request.collectionId];
  const continuation = request.after === undefined
    ? ''
    : `and (
         coalesce(parent_id, ''::text) collate "C",
         coalesce(position_token, ''::text) collate "C",
         id collate "C"
       ) > ($2::text collate "C", $3::text collate "C", $4::text collate "C")`;
  if (request.after) values.push(request.after.parentId, request.after.position, request.after.nodeId);
  values.push(request.limit + 1);
  const ordinalOffset = request.after === undefined
    ? '0::bigint'
    : `case when coalesce(parent_id, ''::text) collate "C" = $2::text collate "C" then (
         select count(*) from nodes preceding
          where preceding.collection_id = $1
            and not preceding.is_root and preceding.deleted_at is null
            ${request.projection === 'public' ? `and preceding.visibility = 'inherit'
            and not ${buildPublicationTargetAncestorRestrictionSql('preceding')}
            and not ${bookmarkHidePublicExistsSql('preceding.id', 'preceding.collection_id')}` : ''}
            and coalesce(preceding.parent_id, ''::text) collate "C" = $2::text collate "C"
            and (coalesce(preceding.position_token, ''::text) collate "C", preceding.id collate "C")
              <= ($3::text collate "C", $4::text collate "C")
       ) else 0::bigint end`;
  // Public predicates already establish both flags before pagination. Do not
  // repeat the ancestor walk and moderation probe for every returned row.
  return Object.freeze({
    text: `select id, collection_id, parent_id, kind, is_root, title, url, description,
            tags, visibility, position_token, resource_revision, created_at, updated_at,
            lpad(((row_number() over (
              partition by coalesce(parent_id, ''::text) collate "C"
              order by coalesce(position_token, ''::text) collate "C", id collate "C"
            )) - 1 + ${ordinalOffset})::text, 20, '0') as publication_position,
            ${request.projection === 'public' ? 'false' : `exists (
              with recursive ancestors as (
                select parent.id, parent.parent_id, parent.visibility
                  from nodes parent where parent.collection_id = nodes.collection_id and parent.id = nodes.parent_id
                union all
                select parent.id, parent.parent_id, parent.visibility
                  from nodes parent join ancestors child on parent.id = child.parent_id
                 where parent.collection_id = nodes.collection_id
              )
              select 1 from ancestors where visibility in ('private', 'protected')
            )`} as ancestor_restricted,
            ${request.projection === 'public' ? 'false'
              : bookmarkHidePublicExistsSql('nodes.id', 'nodes.collection_id')} as moderation_hidden,
            ${nodeExtensionFlagSql('nodes', PUBLICATION_PIN_EXTENSION, 'pinned')} as pinned
       from nodes
      where collection_id = $1 and not is_root and deleted_at is null
        ${request.projection === 'public' ? `and visibility = 'inherit'
        and not ${buildPublicationTargetAncestorRestrictionSql('nodes')}
        and not ${bookmarkHidePublicExistsSql('nodes.id', 'nodes.collection_id')}` : ''}
      ${continuation}
      order by coalesce(parent_id, ''::text) collate "C",
               coalesce(position_token, ''::text) collate "C",
               id collate "C"
      limit $${values.length}`,
    values: Object.freeze(values),
  });
}

function buildScopedCandidateStatement(
  request: PublicationSnapshotReadRequest,
): PublicationSnapshotSqlStatement {
  const rootId = request.rootId ?? '';
  const depth = request.depth ?? 1_024;
  const after = request.after;
  const values: unknown[] = [request.collectionId, rootId, depth];
  const continuation = after === undefined
    ? ''
    : `and (
         coalesce(parent_id, ''::text) collate "C",
         coalesce(position_token, ''::text) collate "C",
         id collate "C"
       ) > ($4::text collate "C", $5::text collate "C", $6::text collate "C")`;
  if (after) values.push(after.parentId, after.position, after.nodeId);
  values.push(request.limit + 1);
  const ordinalOffset = after === undefined
    ? '0::bigint'
    : `case when coalesce(n.parent_id, ''::text) collate "C" = $4::text collate "C" then (
         select count(*) from scoped preceding
          where preceding.scope_depth > 0
            ${request.projection === 'public' ? `and preceding.visibility = 'inherit'
            and not preceding.ancestor_restricted and not preceding.moderation_hidden` : ''}
            and coalesce(preceding.parent_id, ''::text) collate "C" = $4::text collate "C"
            and (coalesce(preceding.position_token, ''::text) collate "C", preceding.id collate "C")
              <= ($5::text collate "C", $6::text collate "C")
       ) else 0::bigint end`;
  return Object.freeze({
    text: `with recursive scoped as (
       select n.*, 0::integer as scope_depth,
                exists (
                with recursive scope_ancestors as (
                  select parent.id, parent.parent_id, parent.visibility
                    from nodes parent
                   where parent.collection_id = n.collection_id and parent.id = n.parent_id
                  union all
                  select parent.id, parent.parent_id, parent.visibility
                    from nodes parent join scope_ancestors child on parent.id = child.parent_id
                   where parent.collection_id = n.collection_id
                )
                select 1 from scope_ancestors where visibility in ('private', 'protected')
              ) as ancestor_restricted,
              ${bookmarkHidePublicExistsSql('n.id', 'n.collection_id')} as moderation_hidden
         from nodes n
        where n.collection_id = $1
          and n.id = case when $2 = '' then (select root_node_id from collections where id = $1) else $2 end
          and n.deleted_at is null
       union all
       select child.*, parent.scope_depth + 1,
              parent.ancestor_restricted or parent.visibility in ('private', 'protected'),
              ${bookmarkHidePublicExistsSql('child.id', 'child.collection_id')} as moderation_hidden
         from nodes child join scoped parent on child.parent_id = parent.id
        where child.collection_id = $1 and child.deleted_at is null and parent.scope_depth < $3
     )
     select n.id, n.collection_id, n.parent_id, n.kind, n.is_root, n.title, n.url, n.description,
            n.tags, n.visibility, n.position_token, n.resource_revision,
            n.created_at, n.updated_at, n.ancestor_restricted, n.moderation_hidden,
            ${nodeExtensionFlagSql('n', PUBLICATION_PIN_EXTENSION, 'pinned')} as pinned,
            lpad(((row_number() over (
              partition by coalesce(n.parent_id, ''::text) collate "C"
              order by coalesce(n.position_token, ''::text) collate "C", n.id collate "C"
            )) - 1 + ${ordinalOffset})::text, 20, '0') as publication_position
       from scoped n
      where n.scope_depth > 0
        ${request.projection === 'public' ? `and n.visibility = 'inherit'
        and not n.ancestor_restricted
        and not n.moderation_hidden` : ''}
        ${continuation}
      order by coalesce(n.parent_id, ''::text) collate "C",
               coalesce(n.position_token, ''::text) collate "C",
               n.id collate "C"
      limit $${values.length}`,
    values: Object.freeze(values),
  });
}

function validateRequest(request: PublicationSnapshotReadRequest): void {
  if (!request || typeof request.collectionId !== 'string' || request.collectionId.length === 0) {
    throw new TypeError('Publication Snapshot collectionId is required');
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 500) {
    throw new RangeError('Publication Snapshot read limit must be between 1 and 500');
  }
  if (request.after && Object.values(request.after).some((value) => typeof value !== 'string')) {
    throw new TypeError('Publication Snapshot continuation tuple is invalid');
  }
  if (request.after !== undefined && request.afterLocator !== undefined) {
    throw new TypeError('Publication Snapshot read accepts only one continuation form');
  }
  if (request.afterLocator !== undefined && !/^[0-9a-f]{32}$/u.test(request.afterLocator)) {
    throw new TypeError('Publication Snapshot continuation locator is invalid');
  }
  if (request.depth !== undefined && (!Number.isSafeInteger(request.depth) || request.depth < 0 || request.depth > 1_024)) {
    throw new RangeError('Publication Snapshot depth must be between 0 and 1024');
  }
  if (request.metadataOnly !== undefined && typeof request.metadataOnly !== 'boolean') {
    throw new TypeError('Publication Snapshot metadataOnly flag is invalid');
  }
  if (request.projection !== undefined && request.projection !== 'public' && request.projection !== 'member') {
    throw new TypeError('Publication Snapshot projection is invalid');
  }
}

function mapCollection(row: CollectionRow): PublicationCollectionRecord {
  return Object.freeze({
    id: row.id,
    ownerSubjectId: row.owner_subject_id,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    visibility: row.visibility,
    publicationSlug: row.publication_slug,
    rootNodeId: row.root_node_id,
    contentRevision: row.content_revision,
    policyRevision: row.policy_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
    ...(row.bookmark_hide_digest ? { bookmarkHideDigest: row.bookmark_hide_digest } : {}),
  });
}

function mapNode(row: NodeRow): PublicationNodeRecord {
  return Object.freeze({
    id: row.id,
    collectionId: row.collection_id,
    parentId: row.parent_id,
    kind: row.kind,
    isRoot: row.is_root,
    title: row.title,
    url: row.url,
    description: row.description,
    tags: Object.freeze(Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : []),
    visibility: row.visibility,
    ancestorRestricted: row.ancestor_restricted === true,
    moderationHidden: row.moderation_hidden === true,
    ...(row.pinned === true && row.kind === 'bookmark' ? { pinned: true } : {}),
    position: row.position_token,
    publicationPosition: row.publication_position,
    resourceRevision: row.resource_revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function freezePage(
  collection: PublicationCollectionRecord | null,
  root: PublicationNodeRecord | null,
  candidates: readonly PublicationNodeRecord[],
): PublicationSnapshotReadPage {
  return Object.freeze({
    isolation: 'repeatable read',
    comparatorVersion: PUBLICATION_SNAPSHOT_COMPARATOR_VERSION,
    collection,
    root,
    candidates: Object.freeze([...candidates]),
  });
}
