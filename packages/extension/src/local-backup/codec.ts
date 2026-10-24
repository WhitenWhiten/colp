import { normalizeBookmarkPreferences, DEFAULT_BOOKMARK_PREFERENCES, type BookmarkPreferences } from '../bookmark-preferences.js';
import { devicePreferencePatch, DEVICE_BOOKMARK_PREFERENCE_KEYS } from '../device-bookmark-preferences.js';
import type { CaptureTask } from '../capture/contracts.js';
import type { LocalHistoryItem } from '../capture/local-history.js';
import { bookmarkUrl } from '../generated/import-preview-validators.js';
import { validateFolderDescription } from '../folder-description-store.js';
import { ANNOTATION_LIMITS, normalizeAnnotationNote, type BookmarkAnnotation } from '../bookmark-annotation-store.js';
import { RETAINED_TAG_LIMITS, validateRetainedTags } from '../bookmark-tag-limits.js';
import { classificationEndpointAllowed, type LocalClassificationPresetId } from '../classification-local-presets.js';
import type { FolderTreeNode } from '../save-folder.js';
import { parsePortableSources, type PortableSources } from '../site-adapters/portable.js';

export const MAX_BACKUP_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100_000;
export interface BackupNode {
  readonly sourceId: string; readonly parentIndex: number | null; readonly title: string;
  readonly url?: string; readonly description?: string | null;
  /** Bookmarks only. Backups made before annotations existed simply lack both. */
  readonly tags?: readonly string[]; readonly note?: string;
  /** Pinned below the folders; restore keeps the order, so only the flag travels. */
  readonly pinned?: true;
}
export interface BackupHistory {
  readonly sourceId: string; readonly title: string; readonly url: string; readonly source: CaptureTask['source'];
  readonly createdAt: number; readonly updatedAt: number; readonly save: CaptureTask['save'];
  readonly classification: CaptureTask['classification']; readonly sync: CaptureTask['sync'];
  readonly disposition: CaptureTask['disposition']; readonly automaticIntent: boolean;
  readonly nativeSourceId: string | null; readonly targetSourceId: string | null; readonly path: readonly string[];
  readonly reason: string | null;
  readonly savedAt?: number; readonly classificationAppliedAt?: number; readonly syncConfirmedAt?: number;
  readonly feedbackKind?: CaptureTask['feedbackKind']; readonly originalApplied: boolean;
}
export interface BackupAiConfig {
  readonly presetId: LocalClassificationPresetId; readonly endpoint: string; readonly model: string;
  readonly accountId?: string; readonly gatewayId?: string;
}
export interface BackupMetadata {
  readonly siteAdapters?: PortableSources;
  readonly history: readonly BackupHistory[];
  readonly preferences: Partial<BookmarkPreferences>; readonly language: 'auto' | 'en' | 'zh_CN';
  readonly defaultFolderSourceId: string | null; readonly aiConfig: BackupAiConfig | null;
}
export interface LocalBackup extends BackupMetadata {
  readonly format: 'known-browser-backup'; readonly version: 1; readonly exportedAt: number;
  readonly nodes: readonly BackupNode[];
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('backup_invalid');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000]/u.test(value)) throw new Error('backup_invalid');
  return value;
}
function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('backup_invalid');
  return Number(value);
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('backup_invalid');
  return value as T;
}
function url(value: unknown): string {
  if (!bookmarkUrl(value)) throw new Error('backup_unsupported_url');
  return value as string;
}
function annotationTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > RETAINED_TAG_LIMITS.count) throw new Error('backup_invalid');
  const tags = value.map(tag => text(tag, RETAINED_TAG_LIMITS.length));
  try { validateRetainedTags(tags); } catch { throw new Error('backup_invalid'); }
  return tags;
}
function annotationNote(value: unknown): string | null {
  return normalizeAnnotationNote(text(value, ANNOTATION_LIMITS.noteBytes));
}
const nullableId = (value: unknown) => value === null ? null : text(value, 256);
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw new Error('backup_invalid'); return value;
};
export function parseBackupAiConfig(value: unknown): BackupAiConfig | null {
  if (value === null) return null;
  const raw = object(value, ['presetId', 'endpoint', 'model', 'accountId', 'gatewayId']);
  const endpoint = text(raw.endpoint);
  if (!classificationEndpointAllowed(endpoint)) throw new Error('backup_invalid');
  return { presetId: choice(raw.presetId, ['custom', 'typesafe', 'vercel', 'cloudflare']), endpoint,
    model: text(raw.model, 256), ...(raw.accountId === undefined ? {} : { accountId: text(raw.accountId, 64) }),
    ...(raw.gatewayId === undefined ? {} : { gatewayId: text(raw.gatewayId, 64) }) };
}
export function parseLocalBackup(value: unknown): LocalBackup {
  const raw = object(value, ['format', 'version', 'exportedAt', 'nodes', 'history', 'preferences', 'language', 'defaultFolderSourceId', 'aiConfig', 'siteAdapters']);
  if (raw.format !== 'known-browser-backup' || raw.version !== 1) throw new Error('backup_version_unsupported');
  const ids = new Set<string>();
  const nodes: BackupNode[] = [];
  const depths: number[] = [];
  for (const entry of array(raw.nodes)) {
    const node = object(entry, ['sourceId', 'parentIndex', 'title', 'url', 'description', 'tags', 'note', 'pinned']);
    const sourceId = text(node.sourceId, 256), parentIndex = node.parentIndex;
    if (!sourceId || ids.has(sourceId) || (parentIndex !== null && (!Number.isSafeInteger(parentIndex)
      || Number(parentIndex) < 0 || Number(parentIndex) >= nodes.length || nodes[Number(parentIndex)]?.url !== undefined))) throw new Error('backup_invalid');
    if (node.description !== undefined) validateFolderDescription(node.description);
    if (node.url !== undefined && node.description !== undefined) throw new Error('backup_invalid');
    if ((node.tags !== undefined || node.note !== undefined || node.pinned !== undefined) && node.url === undefined) throw new Error('backup_invalid');
    if (node.pinned !== undefined && node.pinned !== true) throw new Error('backup_invalid');
    const tags = node.tags === undefined ? [] : annotationTags(node.tags), note = node.note === undefined ? null : annotationNote(node.note);
    ids.add(sourceId);
    const depth = parentIndex === null ? 0 : (depths[Number(parentIndex)] ?? 0) + 1;
    if (depth > 64) throw new Error('depth_limit');
    depths.push(depth);
    nodes.push({ sourceId, parentIndex: parentIndex as number | null, title: text(node.title),
      ...(node.url === undefined ? {} : { url: url(node.url) }),
      ...(node.description === undefined ? {} : { description: node.description as string | null }),
      ...(tags.length ? { tags } : {}), ...(note === null ? {} : { note }), ...(node.pinned === true ? { pinned: true as const } : {}) });
  }
  const historyIds = new Set<string>();
  const history = array(raw.history).map(entry => {
    const item = object(entry, ['sourceId', 'title', 'url', 'source', 'createdAt', 'updatedAt', 'save', 'classification', 'sync', 'disposition', 'automaticIntent', 'nativeSourceId', 'targetSourceId', 'path', 'reason', 'savedAt', 'classificationAppliedAt', 'syncConfirmedAt', 'feedbackKind', 'originalApplied']);
    const sourceId = text(item.sourceId, 256);
    if (!sourceId || historyIds.has(sourceId) || typeof item.automaticIntent !== 'boolean' || typeof item.originalApplied !== 'boolean' || !Array.isArray(item.path) || item.path.length > 128) throw new Error('backup_invalid');
    historyIds.add(sourceId);
    return { sourceId, title: text(item.title), url: url(item.url), source: choice(item.source, ['action-popup', 'manual-popup', 'context-page', 'context-link', 'batch', 'site-favorite', 'site-import', 'site-reconcile']),
      createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), save: choice(item.save, ['unsubmitted', 'local-saved', 'unknown', 'failed']),
      classification: choice(item.classification, ['none', 'waiting', 'running', 'applied', 'manual', 'failed']),
      sync: choice(item.sync, ['local-only', 'pending', 'syncing', 'confirmed', 'attention']), disposition: choice(item.disposition, ['new', 'existing', 'cancelled']),
      automaticIntent: item.automaticIntent, nativeSourceId: nullableId(item.nativeSourceId), targetSourceId: nullableId(item.targetSourceId),
      path: item.path.map(part => text(part)), reason: item.reason === null ? null : text(item.reason, 256), originalApplied: item.originalApplied,
      ...(item.savedAt === undefined ? {} : { savedAt: timestamp(item.savedAt) }),
      ...(item.classificationAppliedAt === undefined ? {} : { classificationAppliedAt: timestamp(item.classificationAppliedAt) }),
      ...(item.syncConfirmedAt === undefined ? {} : { syncConfirmedAt: timestamp(item.syncConfirmedAt) }),
      ...(item.feedbackKind === undefined ? {} : { feedbackKind: choice(item.feedbackKind, ['explicit_positive', 'explicit_negative', 'correction_applied', 'implicit_positive', 'dismissed_unrated', 'not_presented', 'withdrawn']) }) };
  });
  const preferences = object(raw.preferences, DEVICE_BOOKMARK_PREFERENCE_KEYS);
  const normalized = normalizeBookmarkPreferences({ ...DEFAULT_BOOKMARK_PREFERENCES, ...preferences });
  if (!normalized) throw new Error('backup_invalid');
  const defaultFolderSourceId = nullableId(raw.defaultFolderSourceId);
  if (defaultFolderSourceId !== null && !nodes.some(node => node.sourceId === defaultFolderSourceId && node.url === undefined)) throw new Error('backup_invalid');
  return { format: 'known-browser-backup', version: 1, exportedAt: timestamp(raw.exportedAt), nodes, history,
    preferences: devicePreferencePatch(normalized), language: choice(raw.language, ['auto', 'en', 'zh_CN']), defaultFolderSourceId,
    aiConfig: parseBackupAiConfig(raw.aiConfig), ...(raw.siteAdapters === undefined ? {} : { siteAdapters: parsePortableSources(raw.siteAdapters) }) };
}
export function decodeLocalBackup(bytes: Uint8Array): LocalBackup {
  if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('input_too_large');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('backup_invalid'); }
  return parseLocalBackup(value);
}
export function backupNativeNodes(roots: readonly FolderTreeNode[], descriptions: ReadonlyMap<string, string | null>, excluded: ReadonlySet<string> = new Set(),
  annotations: ReadonlyMap<string, BookmarkAnnotation> = new Map()): BackupNode[] {
  const nodes: BackupNode[] = [];
  const visit = (tree: readonly FolderTreeNode[], parentIndex: number | null) => {
    for (const node of tree) {
      if (node.unmodifiable || excluded.has(node.id)) continue;
      const index = nodes.length;
      if (index >= MAX_RECORDS) throw new Error('node_limit');
      const annotation = node.url === undefined ? undefined : annotations.get(node.id);
      nodes.push({ sourceId: node.id, parentIndex, title: node.title, ...(node.url === undefined ? {} : { url: node.url }),
        ...(node.url === undefined && descriptions.has(node.id) ? { description: descriptions.get(node.id) } : {}),
        ...(annotation?.tags.length ? { tags: annotation.tags } : {}), ...(annotation?.note ? { note: annotation.note } : {}),
        ...(annotation?.pinned ? { pinned: true as const } : {}) });
      visit(node.children ?? [], index);
    }
  };
  visit(roots, null); return nodes;
}
export function backupHistory(task: LocalHistoryItem): BackupHistory {
  return { sourceId: task.captureId, title: task.title, url: task.url, source: task.source, createdAt: task.createdAt, updatedAt: task.updatedAt,
    save: task.save, classification: task.classification, sync: task.sync, disposition: task.disposition, automaticIntent: task.automaticIntent,
    nativeSourceId: task.nativeId, targetSourceId: task.targetNativeId || null, path: task.localLocation?.path ?? [], reason: task.reason,
    originalApplied: task.historyAutomaticApplied ?? task.automatic?.decision?.automaticApplied ?? Boolean(task.appliedRevision),
    ...(task.savedAt === undefined ? {} : { savedAt: task.savedAt }),
    ...(task.classificationAppliedAt === undefined ? {} : { classificationAppliedAt: task.classificationAppliedAt }),
    ...(task.syncConfirmedAt === undefined ? {} : { syncConfirmedAt: task.syncConfirmedAt }),
    ...(task.feedbackKind === undefined ? {} : { feedbackKind: task.feedbackKind }) };
}
export function bookmarkHtml(nodes: readonly BackupNode[]): string {
  const escape = (value: string) => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  const children = new Map<number | null, number[]>();
  nodes.forEach((node, index) => { const list = children.get(node.parentIndex) ?? []; list.push(index); children.set(node.parentIndex, list); });
  const visit = (parent: number | null): string => (children.get(parent) ?? []).map(index => {
    const node = nodes[index]!;
    return node.url === undefined ? `<DT><H3>${escape(node.title)}</H3>\n${node.description ? `<DD>${escape(node.description)}\n` : ''}<DL><p>\n${visit(index)}</DL><p>\n`
      : `<DT><A HREF="${escape(node.url)}"${node.tags?.length ? ` TAGS="${escape(node.tags.join(','))}"` : ''}>${escape(node.title)}</A>\n`
        + (node.note ? `<DD>${escape(node.note)}\n` : '');
  }).join('');
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${visit(null)}</DL><p>\n`;
}
