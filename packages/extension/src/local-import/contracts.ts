import type { ImportConversionResult, NormalizedImportNode } from '../import-preview.js';
import type { BackupMetadata, LocalBackup } from '../local-backup/codec.js';
import type { CaptureScope } from '../capture/contracts.js';
import type { BookmarkAnnotationInput } from '../bookmark-annotation-store.js';

export interface LocalImportPlan {
  readonly commandId: string;
  readonly digest: string;
  readonly targetNativeId: string;
  readonly folderTitle: string;
  readonly total: number;
  readonly next: number;
  readonly state: 'running' | 'attention' | 'completed' | 'cancelled';
  readonly reason: string | null;
  readonly rootNativeId?: string;
  readonly backup?: BackupMetadata;
  readonly restoreSettings?: boolean;
  readonly restoreOwner?: CaptureScope;
  readonly source?: 'backup';
  readonly historyCount?: number;
  /** A plain HTML import whose bookmarks carry tags or notes finishes with a metadata step, like a backup. */
  readonly annotated?: boolean;
}
export interface LocalImportItem {
  readonly commandId: string;
  readonly index: number;
  readonly parentIndex: number | null;
  readonly title: string;
  readonly url?: string;
  readonly state: 'waiting' | 'submitted' | 'completed';
  readonly nativeId?: string;
  readonly sourceId?: string;
  readonly description?: string | null;
  readonly annotation?: BookmarkAnnotationInput;
}
export interface LocalImportStatus extends LocalImportPlan {
  readonly pending?: { readonly parentNativeId: string; readonly title: string; readonly url?: string };
}
export interface LocalImportPreview {
  readonly digest: string;
  readonly creates: number;
  readonly roots: readonly string[];
  readonly warnings: readonly string[];
  readonly format?: 'backup';
  readonly historyCount?: number;
}
export type LocalImportRequest =
  | { readonly kind: 'known.localImport.preview'; readonly base64: string; readonly format?: 'backup' }
  | { readonly kind: 'known.localImport.status' }
  | { readonly kind: 'known.localImport.commit'; readonly commandId: string; readonly digest: string;
    readonly targetNativeId: string; readonly folderTitle: string; readonly userGesture: true; readonly restoreSettings?: boolean }
  | { readonly kind: 'known.localImport.resume' | 'known.localImport.cancel'; readonly commandId: string; readonly userGesture: true }
  | { readonly kind: 'known.localImport.resolve'; readonly commandId: string; readonly nativeId: string; readonly userGesture: true };
export type LocalImportResponse = { readonly ok: true; readonly preview?: LocalImportPreview; readonly status?: LocalImportStatus | null }
  | { readonly ok: false; readonly error: string };

export function validLocalImportRequest(value: unknown): value is LocalImportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9._~-]{1,128}$/u.test(v);
  if (raw.kind === 'known.localImport.status') return Object.keys(raw).length === 1;
  if (raw.kind === 'known.localImport.preview') return Object.keys(raw).every(key => ['kind', 'base64', 'format'].includes(key))
    && (raw.format === undefined || raw.format === 'backup') && typeof raw.base64 === 'string'
    && raw.base64.length <= Math.ceil((raw.format === 'backup' ? 32 : 4) * 1024 * 1024 / 3) * 4;
  if (raw.userGesture !== true || typeof raw.commandId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(raw.commandId)) return false;
  if (raw.kind === 'known.localImport.resume' || raw.kind === 'known.localImport.cancel') return Object.keys(raw).length === 3;
  if (raw.kind === 'known.localImport.resolve') return Object.keys(raw).length === 4 && id(raw.nativeId);
  return raw.kind === 'known.localImport.commit' && Object.keys(raw).every(key => ['kind', 'commandId', 'digest', 'targetNativeId', 'folderTitle', 'userGesture', 'restoreSettings'].includes(key))
    && (raw.restoreSettings === undefined || typeof raw.restoreSettings === 'boolean') && id(raw.targetNativeId)
    && typeof raw.digest === 'string' && raw.digest.length <= 128
    && typeof raw.folderTitle === 'string' && Boolean(raw.folderTitle.trim()) && raw.folderTitle.length <= 4096;
}

export function backupImportItems(backup: LocalBackup, commandId: string, folderTitle: string): LocalImportItem[] {
  return [{ commandId, index: 0, parentIndex: null, title: folderTitle, state: 'waiting' },
    ...backup.nodes.map((node, at): LocalImportItem => ({ commandId, index: at + 1,
      parentIndex: node.parentIndex === null ? 0 : node.parentIndex + 1, title: node.title, state: 'waiting',
      sourceId: node.sourceId, ...(node.url === undefined ? {} : { url: node.url }),
      ...(node.description === undefined ? {} : { description: node.description }),
      ...(node.url !== undefined && (node.tags?.length || node.note || node.pinned) ? { annotation: { tags: node.tags ?? [], note: node.note ?? null,
        ...(node.pinned ? { pinned: true as const } : {}) } } : {}) }))];
}

/** Preorder keeps native folder dependencies and every duplicate occurrence in source order. */
export function localImportItems(conversion: ImportConversionResult, commandId: string, folderTitle: string): LocalImportItem[] {
  const items: LocalImportItem[] = [{ commandId, index: 0, parentIndex: null, title: folderTitle, state: 'waiting' }];
  const visit = (nodes: readonly NormalizedImportNode[], parentIndex: number) => {
    for (const node of nodes) {
      if (node.kind === 'Separator') continue;
      const index = items.length;
      items.push({ commandId, index, parentIndex, title: node.title ?? '',
        ...(node.kind === 'Bookmark' ? { url: node.url } : {}), state: 'waiting',
        ...(node.kind === 'Folder' && node.description !== undefined ? { description: node.description } : {}),
        ...(node.kind === 'Bookmark' && (node.tags?.length || node.note) ? { annotation: { tags: node.tags ?? [], note: node.note ?? null } } : {}) });
      visit(node.children, index);
    }
  };
  visit(conversion.tree, 0);
  return items;
}
