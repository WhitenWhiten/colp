import { ClassificationError, type ClassificationBookmark, type ClassificationRequested, type ClassificationFolderSelectionMode } from './classification-policy.js';
import { assertValidNodeTitle, assertValidNodeDescription } from '../domain/validation.js';
import { normalizeClassificationBookmark } from './classification-text.js';
import { parseClassificationBillingConsent, type ClassificationBillingConsent } from './classification-billing.js';
import { isClassificationOpaqueId } from './classification-content.js';

/** "Suggest another": at most this many folders the user already turned down for this bookmark. */
export const CLASSIFICATION_MAX_REJECTED_FOLDERS = 8;

export type ClassificationPreviewInput = {
  readonly source: 'web' | 'extension' | 'console';
  readonly requested: ClassificationRequested;
  readonly billing?: ClassificationBillingConsent;
  /** Folders (with their subfolders) the user turned down; never offered again by this command. */
  readonly rejectedFolderIds?: readonly string[];
  readonly folderSelectionMode?: ClassificationFolderSelectionMode;
} & ({ readonly nodeId: string } | { readonly bookmark: ClassificationBookmark });

function closed(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ClassificationError('invalid_input');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !Object.hasOwn(record, key))) throw new ClassificationError('invalid_input');
  return record;
}

function rejectedFolderIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > CLASSIFICATION_MAX_REJECTED_FOLDERS
    || value.some(id => !isClassificationOpaqueId(id)) || new Set(value).size !== value.length) throw new ClassificationError('invalid_input');
  return value as string[];
}

/** No client-supplied taxonomy, vocabulary, or copied Node metadata. */
export function parseClassificationPreviewInput(value: unknown): ClassificationPreviewInput {
  const raw = value !== null && typeof value === 'object' && Object.hasOwn(value, 'nodeId')
    ? closed(value, ['source', 'requested', 'nodeId'], ['billing', 'rejectedFolderIds', 'folderSelectionMode']) : closed(value, ['source', 'requested', 'bookmark'], ['billing', 'rejectedFolderIds', 'folderSelectionMode']);
  const mode = raw.folderSelectionMode;
  if (Object.hasOwn(raw, 'folderSelectionMode') && mode !== 'allow_later' && mode !== 'require_candidate') throw new ClassificationError('invalid_input');
  const consent = { ...Object.hasOwn(raw, 'billing') ? { billing: parseClassificationBillingConsent(raw.billing) } : {},
    ...Object.hasOwn(raw, 'rejectedFolderIds') ? { rejectedFolderIds: rejectedFolderIds(raw.rejectedFolderIds) } : {},
    ...(mode ? { folderSelectionMode: mode as ClassificationFolderSelectionMode } : {}) };
  const source = raw.source;
  if (source !== 'web' && source !== 'extension' && source !== 'console') throw new ClassificationError('invalid_input');
  const request = closed(raw.requested, ['folder', 'tags']);
  if (typeof request.folder !== 'boolean' || typeof request.tags !== 'boolean' || (!request.folder && !request.tags)) throw new ClassificationError('invalid_input');
  const requested = { folder: request.folder, tags: request.tags };
  if (mode && !requested.folder) throw new ClassificationError('invalid_input');
  if (Object.hasOwn(raw, 'nodeId')) {
    if (typeof raw.nodeId !== 'string' || !raw.nodeId.trim() || Buffer.byteLength(raw.nodeId, 'utf8') > 128) throw new ClassificationError('invalid_input');
    return { source, requested, nodeId: raw.nodeId, ...consent };
  }
  const bookmark = closed(raw.bookmark, ['title', 'url', 'description']);
  if (typeof bookmark.title !== 'string' || typeof bookmark.url !== 'string' || (bookmark.description !== null && typeof bookmark.description !== 'string')) throw new ClassificationError('invalid_input');
  const input = { title: bookmark.title, url: bookmark.url, description: bookmark.description };
  try { assertValidNodeTitle(input.title); assertValidNodeDescription(input.description); }
  catch { throw new ClassificationError('invalid_input'); }
  normalizeClassificationBookmark(input);
  // Keep original bytes for command fingerprinting; compile only for the provider.
  return { source, requested, bookmark: input, ...consent };
}
