import { sql } from 'kysely';
import { bookmarkHidePublicExistsSql } from '../database/collection-control-sql.js';
import { buildPublicationTargetAncestorRestrictionSql } from '../publication/target-access-facts.js';
import { bookmarkPinnedSql } from './bookmark-pin-sql.js';
import type {
  CollectionChildrenNodeRow,
  CollectionChildrenReadPort,
} from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { Metrics } from '../telemetry/index.js';

const childrenPositionKey = sql<string>`COALESCE(position_token, ''::text) COLLATE "C"`;
const childrenNodeIdKey = sql<string>`id COLLATE "C"`;
/**
 * The API serializes created_at at millisecond precision, so ties are defined
 * at millisecond buckets: time sorts order by the UTC millisecond bucket and
 * resolve same-bucket ties by ascending id. Truncation is done in UTC so the
 * order/keyset predicates never depend on the session timezone.
 */
const childrenCreatedMsKey = sql<string>`date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')`;

const NODE_COLUMNS = [
  'id',
  'collection_id',
  'parent_id',
  'kind',
  'title',
  'url',
  'description',
  'position_token',
  'children_revision',
  'created_at',
  'updated_at',
] as const;

function mapRow(row: {
  id: string;
  collection_id: string;
  parent_id: string | null;
  kind: 'folder' | 'bookmark' | 'separator';
  title: string | null;
  url: string | null;
  description: string | null;
  position_token: string | null;
  children_revision: string;
  created_at: Date;
  updated_at: Date;
  moderation_hidden: boolean;
  pinned?: boolean;
}): CollectionChildrenNodeRow {
  if (row.parent_id === null || row.title === null || row.kind === 'separator') {
    throw new Error(`collection children node ${row.id} has an unsupported canonical shape`);
  }
  return {
    id: row.id,
    collectionId: row.collection_id,
    parentId: row.parent_id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    description: row.description,
    positionToken: row.position_token,
    childrenRevision: row.children_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    moderationHidden: row.moderation_hidden === true,
    ...(row.kind === 'bookmark' && row.pinned === true ? { pinned: true } : {}),
  };
}

/** Cursor timestamps are UTC with millis; Postgres parameters drop the Z suffix. */
function timestampParam(value: string): string {
  return value.endsWith('Z') ? value.slice(0, -1) : value;
}

export interface PostgresCollectionChildrenPortsOptions {
  readonly metrics?: Metrics;
}

/**
 * FO-05 live-children read ports bound to one transaction. Reads never write:
 * position tokens, revisions, sync logs and the reading path stay untouched.
 */
export function createPostgresCollectionChildrenPorts(
  transaction: DatabaseTransaction,
  _options: PostgresCollectionChildrenPortsOptions = {},
): CollectionChildrenReadPort {
  const listLiveChildren: CollectionChildrenReadPort['listLiveChildren'] = async (input) => {
    const fetchLimit = input.limit + 1;
    let query = transaction
      .selectFrom('nodes')
      .select([...NODE_COLUMNS, sql<boolean>`kind = 'bookmark' and ${sql.raw(bookmarkHidePublicExistsSql('nodes.id', 'nodes.collection_id'))}`.as('moderation_hidden'),
        sql<boolean>`${sql.raw(bookmarkPinnedSql('nodes'))}`.as('pinned')])
      .where('collection_id', '=', input.collectionId)
      .where('parent_id', '=', input.parentId)
      .where(sql<boolean>`NOT is_root`)
      .where('kind', 'in', ['folder', 'bookmark'])
      .where('deleted_at', 'is', null);

    // A public collection can contain private/protected nodes and folders.
    // Apply the effective publication projection in the database before the
    // keyset limit/order so pagination cannot reveal an otherwise hidden row
    // (or use a hidden folder as a subtree traversal oracle).
    if (input.publicOnly) {
      query = query
        .where('visibility', '=', 'inherit')
        .where(sql<boolean>`not ${sql.raw(buildPublicationTargetAncestorRestrictionSql('nodes'))}`);
    }

    if (input.after) {
      if (input.sort === 'created_asc') {
        query = query.where(sql<boolean>`(
          ${childrenCreatedMsKey},
          ${childrenNodeIdKey}
        ) > (
          ${timestampParam(input.after.createdAt)}::timestamp,
          ${input.after.nodeId}::text COLLATE "C"
        )`);
      } else if (input.sort === 'created_desc') {
        query = query.where(sql<boolean>`(
          ${childrenCreatedMsKey} < ${timestampParam(input.after.createdAt)}::timestamp
          OR (
            ${childrenCreatedMsKey} = ${timestampParam(input.after.createdAt)}::timestamp
            AND ${childrenNodeIdKey} > ${input.after.nodeId}::text COLLATE "C"
          )
        )`);
      } else {
        query = query.where(sql<boolean>`(
          ${childrenPositionKey},
          ${childrenNodeIdKey}
        ) > (
          ${input.after.positionKey}::text COLLATE "C",
          ${input.after.nodeId}::text COLLATE "C"
        )`);
      }
    }

    if (input.sort === 'created_asc') {
      query = query.orderBy(childrenCreatedMsKey, 'asc').orderBy(childrenNodeIdKey, 'asc');
    } else if (input.sort === 'created_desc') {
      query = query.orderBy(childrenCreatedMsKey, 'desc').orderBy(childrenNodeIdKey, 'asc');
    } else {
      query = query.orderBy(childrenPositionKey, 'asc').orderBy(childrenNodeIdKey, 'asc');
    }

    const rows = await query.limit(fetchLimit).execute();
    return rows.map((row) => mapRow(row));
  };

  const getLiveNode: CollectionChildrenReadPort['getLiveNode'] = async (collectionId, nodeId, options) => {
    let query = transaction
      .selectFrom('nodes')
      .select([...NODE_COLUMNS, sql<boolean>`kind = 'bookmark' and ${sql.raw(bookmarkHidePublicExistsSql('nodes.id', 'nodes.collection_id'))}`.as('moderation_hidden'),
        sql<boolean>`${sql.raw(bookmarkPinnedSql('nodes'))}`.as('pinned')])
      .where('collection_id', '=', collectionId)
      .where('id', '=', nodeId)
      .where('deleted_at', 'is', null);
    if (options?.publicOnly) {
      query = query
        .where('visibility', '=', 'inherit')
        .where(sql<boolean>`not ${sql.raw(buildPublicationTargetAncestorRestrictionSql('nodes'))}`);
    }
    const row = await query.executeTakeFirst();
    return row ? mapRow(row) : null;
  };

  return Object.freeze({ listLiveChildren, getLiveNode });
}
