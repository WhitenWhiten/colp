export const PRODUCT_SYNC_TRASH_CONTRACT_VERSION = '1.58.0';
export const PRODUCT_SYNC_TRASH_RESTORE_BATCH_LIMIT = 100;
export const PRODUCT_SYNC_TRASH_EMPTY_LIMIT = 500;
export const PRODUCT_SYNC_TRASH_EMPTY_CONFIRMATION = 'permanently_delete';

export interface ProductSyncTrashListItem {
  readonly deletionId: string;
  readonly nodeId: string;
  readonly kind: 'folder' | 'bookmark' | 'separator';
  readonly title: string | null;
  readonly originalParentId: string | null;
  readonly originalParentTitle: string | null;
  readonly deletedAt: string;
  readonly purgeAfter: string;
  readonly revision: string;
}

export interface ProductSyncTrashPage {
  readonly items: readonly ProductSyncTrashListItem[];
  readonly page: { readonly nextCursor: string | null };
}

export interface ProductSyncTrashDetail extends ProductSyncTrashListItem {
  readonly url: string | null;
  readonly collectionId: string;
  readonly etag: string;
}

export interface ProductSyncTrashRestoreView {
  readonly deletionId: string;
  readonly nodeId: string;
  readonly parentId: string;
  readonly revision: string;
  readonly etag: string;
  readonly restoredAt: string;
}

export interface ProductSyncTrashRestoreBatchItem {
  readonly deletionId: string;
  readonly expectedRevision: string;
}

export type ProductSyncTrashRestoreOutcome =
  | 'applied'
  | 'precondition_failed'
  | 'purged'
  | 'not_found';

export interface ProductSyncTrashRestoreItemResult {
  readonly deletionId: string;
  readonly outcome: ProductSyncTrashRestoreOutcome;
  readonly nodeId?: string;
  readonly parentId?: string;
  readonly revision?: string;
  readonly restoredAt?: string;
}

export interface ProductSyncTrashRestoreBatchSummary {
  readonly applied: number;
  readonly preconditionFailed: number;
  readonly purged: number;
  readonly notFound: number;
}

export interface ProductSyncTrashRestoreBatchView {
  readonly collectionId: string;
  readonly results: readonly ProductSyncTrashRestoreItemResult[];
  readonly summary: ProductSyncTrashRestoreBatchSummary;
}

export type ProductSyncTrashEmptySkipReason =
  | 'retention_window'
  | 'replica_checkpoint'
  | 'watermark';

export interface ProductSyncTrashEmptyItemResult {
  readonly deletionId: string;
  readonly outcome: 'purged' | 'skipped';
  readonly reason?: ProductSyncTrashEmptySkipReason;
}

export interface ProductSyncTrashEmptySummary {
  readonly purged: number;
  readonly skipped: number;
  readonly remaining: number;
}

export interface ProductSyncTrashEmptyView {
  readonly collectionId: string;
  readonly results: readonly ProductSyncTrashEmptyItemResult[];
  readonly summary: ProductSyncTrashEmptySummary;
}

const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/u;

export function encodeTrashDeletionId(operationId: string, targetId: string): string {
  return Buffer.from(`${operationId}\0${targetId}`, 'utf8').toString('base64url');
}

export function decodeTrashDeletionId(deletionId: string): {
  readonly operationId: string; readonly targetId: string;
} | null {
  if (typeof deletionId !== 'string' || deletionId.length < 1 || deletionId.length > 512) return null;
  try {
    const raw = Buffer.from(deletionId, 'base64url').toString('utf8');
    const split = raw.indexOf('\0');
    if (split < 1 || split === raw.length - 1) return null;
    const operationId = raw.slice(0, split);
    const targetId = raw.slice(split + 1);
    if (!OPAQUE.test(operationId) || !OPAQUE.test(targetId) || raw.includes('\0', split + 1)) return null;
    return { operationId, targetId };
  } catch {
    return null;
  }
}
