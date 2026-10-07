import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  decodeTrashDeletionId,
  encodeTrashDeletionId,
  type ProductSyncCenterPorts,
  type ProductSyncTrashDetail,
  type ProductSyncTrashListItem,
  type ProductSyncTrashPage,
} from '../../modules/sync/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { productSyncTrashBatchPorts } from './product-sync-trash-batch-postgres.js';
import { productSyncTrashEmptyPorts } from './product-sync-trash-empty-postgres.js';
import {
  incrementRestoreOutcome, locateDeletion, notFound, ownedCollection, productTrashCommand, purged,
  restoreTrashItemInTransaction, TRASH_OPAQUE,
  type ProductSyncTrashPostgresOptions,
} from './product-sync-trash-shared-postgres.js';

export type { ProductSyncTrashPostgresOptions };

const PURPOSE = 'product-sync-trash';

export function productSyncTrashPorts(
  transaction: DatabaseTransaction,
  options: ProductSyncTrashPostgresOptions,
): Pick<ProductSyncCenterPorts, 'listTrash' | 'getTrashDetail' | 'restoreTrash'
  | 'restoreTrashBatch' | 'restoreTrashSubtree' | 'emptyTrash'> {
  return {
    async listTrash(input) {
      options.metrics?.increment('sync_trash_list_total');
      const collection = await ownedCollection(transaction, input.collectionId, input.subjectId);
      if (!collection) throw notFound();
      const after = input.cursor === undefined
        ? undefined : decodeCursor(input.cursor, input.accountId, options.cursorSecret);
      const pageLimit = after?.limit ?? input.limit;
      const rows = await listRows(transaction, input.collectionId, pageLimit + 1, after);
      const pageRows = rows.slice(0, pageLimit);
      const tail = rows.length > pageLimit ? pageRows.at(-1) : undefined;
      return Object.freeze({
        items: pageRows.map(toListItem),
        page: Object.freeze({
          nextCursor: tail
            ? encodeCursor({
              deletedAt: tail.deleted_at.toISOString(), targetId: tail.target_id, limit: pageLimit,
            }, input.accountId, options.cursorSecret) : null,
        }),
      }) satisfies ProductSyncTrashPage;
    },
    async getTrashDetail(input) {
      return loadDetail(transaction, input.subjectId, input.deletionId);
    },
    restoreTrash: (input) => productTrashCommand(transaction, {
      principalId: input.accountId,
      commandScope: `sync-trash-restore:${input.deletionId}`,
      commandId: input.commandId,
    }, input.fingerprint, async () => {
      try {
        const result = await restoreTrashItemInTransaction(transaction, input, options.reportSourceInvalidation);
        options.metrics?.increment('sync_trash_restore_total.applied');
        return result;
      } catch (error) {
        incrementRestoreOutcome(options.metrics, error);
        throw error;
      }
    }),
    ...productSyncTrashBatchPorts(transaction, options),
    ...productSyncTrashEmptyPorts(transaction, options),
  };
}

async function loadDetail(
  transaction: DatabaseTransaction, subjectId: string, deletionId: string,
): Promise<ProductSyncTrashDetail> {
  const decoded = decodeTrashDeletionId(deletionId);
  if (!decoded) throw notFound();
  const located = await locateDeletion(transaction, decoded.operationId, decoded.targetId);
  if (located.kind === 'missing') throw notFound();
  const collection = await ownedCollection(transaction, located.collectionId, subjectId);
  if (!collection) throw notFound();
  if (located.kind === 'purged') throw purged();
  const row = await rowByIds(transaction, located.collectionId, decoded.operationId, decoded.targetId);
  if (!row) throw notFound();
  const item = toListItem(row);
  return Object.freeze({
    ...item, url: row.url, collectionId: located.collectionId, etag: `"${item.revision}"`,
  });
}

interface TrashRow {
  readonly operation_id: string; readonly target_id: string; readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly title: string | null; readonly url: string | null; readonly parent_id: string | null;
  readonly parent_title: string | null; readonly deleted_at: Date; readonly purge_after: Date;
  readonly delete_revision: string;
}

async function listRows(
  transaction: DatabaseTransaction, collectionId: string, limit: number,
  after: { readonly deletedAt: string; readonly targetId: string } | undefined,
): Promise<readonly TrashRow[]> {
  let query = trashQuery(transaction).where('tombstone.collection_id', '=', collectionId);
  if (after) {
    query = query.where((eb) => eb.or([
      eb('tombstone.deleted_at', '<', new Date(after.deletedAt)),
      eb.and([
        eb('tombstone.deleted_at', '=', new Date(after.deletedAt)),
        eb('tombstone.target_id', '<', after.targetId),
      ]),
    ]));
  }
  return query.orderBy('tombstone.deleted_at', 'desc').orderBy('tombstone.target_id', 'desc')
    .limit(limit).execute();
}

async function rowByIds(
  transaction: DatabaseTransaction, collectionId: string, operationId: string, targetId: string,
): Promise<TrashRow | undefined> {
  return trashQuery(transaction)
    .where('tombstone.collection_id', '=', collectionId)
    .where('tombstone.operation_id', '=', operationId)
    .where('tombstone.target_id', '=', targetId)
    .executeTakeFirst();
}

function trashQuery(transaction: DatabaseTransaction) {
  return transaction.selectFrom('sync_node_tombstones as tombstone')
    .innerJoin('nodes as node', (join) => join
      .onRef('node.collection_id', '=', 'tombstone.collection_id')
      .onRef('node.id', '=', 'tombstone.target_id'))
    .leftJoin('nodes as parent', (join) => join
      .onRef('parent.collection_id', '=', 'node.collection_id')
      .onRef('parent.id', '=', 'node.parent_id'))
    .select([
      'tombstone.operation_id', 'tombstone.target_id', 'node.kind', 'node.title', 'node.url',
      'node.parent_id', 'parent.title as parent_title', 'tombstone.deleted_at',
      'tombstone.purge_after', 'tombstone.delete_revision',
    ])
    .where('tombstone.payload_purged_at', 'is', null)
    .where('node.deleted_at', 'is not', null);
}

function toListItem(row: TrashRow): ProductSyncTrashListItem {
  return Object.freeze({
    deletionId: encodeTrashDeletionId(row.operation_id, row.target_id),
    nodeId: row.target_id, kind: row.kind, title: row.title,
    originalParentId: row.parent_id, originalParentTitle: row.parent_title,
    deletedAt: row.deleted_at.toISOString(), purgeAfter: row.purge_after.toISOString(),
    revision: row.delete_revision,
  });
}

function encodeCursor(
  value: { deletedAt: string; targetId: string; limit: number }, accountId: string, secret: string,
): string {
  const payload = Buffer.from(stableCursorJson({ v: 1, p: PURPOSE, exp: Date.now() + 15 * 60_000, ...value }), 'utf8')
    .toString('base64url');
  const signature = createHmac('sha256', secret).update(`${PURPOSE}\0`).update(accountId).update('\0')
    .update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeCursor(
  cursor: string, accountId: string, secret: string,
): { deletedAt: string; targetId: string; limit: number } {
  try {
    const [payload, signature, extra] = cursor.split('.');
    if (!payload || !signature || extra) throw new Error();
    const expected = createHmac('sha256', secret).update(`${PURPOSE}\0`).update(accountId).update('\0')
      .update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.p !== PURPOSE || typeof parsed.exp !== 'number'
        || !Number.isSafeInteger(parsed.exp) || parsed.exp < Date.now()
        || typeof parsed.deletedAt !== 'string' || !Number.isFinite(Date.parse(parsed.deletedAt))
        || typeof parsed.targetId !== 'string' || !TRASH_OPAQUE.test(parsed.targetId)
        || !Number.isSafeInteger(parsed.limit) || (parsed.limit as number) < 1
        || (parsed.limit as number) > 100) throw new Error();
    return { deletedAt: parsed.deletedAt, targetId: parsed.targetId, limit: parsed.limit as number };
  } catch {
    throw Object.assign(new Error('Invalid Product Sync cursor'), { code: 'invalid_cursor' });
  }
}

function stableCursorJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableCursorJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableCursorJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
