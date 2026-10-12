export const METADATA_RETENTION_MS = 30 * 24 * 60 * 60_000;
export interface RetainedMetadata {
  readonly nativeId: string; readonly dateAdded?: number; readonly title?: string;
  readonly url?: string | null; readonly removedAt?: number;
}
export interface MetadataNativeIdentity { readonly id: string; readonly dateAdded?: number; readonly title?: string; readonly url?: string }

/**
 * Automatic recovery requires the same native identity AND creation date.
 * URL/title similarity is not restoration authority: imports and browser sync
 * can reproduce both in a different account. Unproven candidates remain retained
 * rather than being consumed or silently attached to a newly created resource.
 */
export function retainedMetadataFor<T extends RetainedMetadata>(rows: readonly T[], node: MetadataNativeIdentity, now: number): T | undefined {
  if (!Number.isFinite(node.dateAdded) || !Number.isFinite(now)) return undefined;
  const exact = rows.filter(row => row.removedAt !== undefined && Number.isFinite(row.removedAt)
    && now >= row.removedAt && now - row.removedAt < METADATA_RETENTION_MS
    && row.nativeId === node.id && row.dateAdded === node.dateAdded
    && (node.url === undefined ? row.url == null : row.url === node.url));
  return exact.length === 1 ? exact[0] : undefined;
}
