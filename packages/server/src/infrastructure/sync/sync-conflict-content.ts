import type { HttpUrl, NodeCreate } from '@know-n/colp/types';
import { preserveExtensions } from '@know-n/colp/schema';
import { validateBookmarkUrlHashSemantics } from '@know-n/colp/semantic';
import {
  mergeSyncNodeContentFields, mergeSyncExtensionNamespaces, SyncConflictResolutionError,
  validIncomingBookmarkUrlHash, reconcileSyncBookmarkMetadata, incomingBookmarkMetadataForCurrent,
  hasIncomingBookmarkUrlMetadata,
  type ValidatedSyncConflictResolutionCommand,
} from '../../modules/sync/index.js';
import {
  assertValidHttpUrlNoUserInfo, assertValidNodeDescription, assertValidNodeTags,
  assertValidNodeTitle, assertValidNodeVisibility,
  isEquivalentBookmarkUrlRewrite,
} from '../../modules/collections/index.js';
import { assertPlainCustomObject, isRecord } from './sync-conflict-json.js';
import { conflictBookmarkBaseUrl, type PrivateConflictPayload } from './sync-conflict-private-payload.js';

function invalid(): never { throw new SyncConflictResolutionError('invalid_document'); }
function fieldValue(payload: Readonly<Record<string, unknown>>, field: string): unknown {
  if (field === 'extensions') return payload[field] ?? {};
  if (field === 'canonicalUrl' || field === 'urlHash') return payload[field] ?? null;
  return payload[field];
}

function validatedBookmarkBaseUrl(payload: PrivateConflictPayload): unknown {
  const baseUrl = conflictBookmarkBaseUrl(payload);
  if (payload.nodeKind !== 'bookmark') return baseUrl;
  if (hasIncomingBookmarkUrlMetadata(payload.incoming)
    && typeof payload.incoming.url !== 'string' && typeof baseUrl !== 'string') {
    throw new SyncConflictResolutionError('resource_not_found');
  }
  if (!validIncomingBookmarkUrlHash(payload.base, payload.incoming, baseUrl)) invalid();
  return baseUrl;
}

function currentMergePayload(current: Readonly<Record<string, unknown>>, payload: PrivateConflictPayload,
  baseUrl: unknown): PrivateConflictPayload {
  return payload.nodeKind === 'bookmark' ? { ...payload,
    incoming: incomingBookmarkMetadataForCurrent(current, payload.base, payload.incoming, baseUrl) } : payload;
}

/** Settle only the advertised conflicting fields by the user's choice; all
 * other retained fields still follow the ordinary three-way merge rules. */
export function selectedResolutionFields(
  command: ValidatedSyncConflictResolutionCommand,
  current: Readonly<Record<string, unknown>>,
  privatePayload: PrivateConflictPayload,
  pointers: readonly string[],
): Readonly<{ base: Record<string, unknown>; value: Record<string, unknown> }> {
  const baseUrl = validatedBookmarkBaseUrl(privatePayload);
  const mergePayload = currentMergePayload(current, privatePayload, baseUrl);
  const fields = pointers.map(pointer => pointer.slice(1))
    .filter(field => !['baseRevision', 'deletedAt'].includes(field));
  if (fields.length < 1) {
    if (command.resolution !== 'server') throw new SyncConflictResolutionError('unsupported_operation');
    // An old meta-only conflict may have no retained incoming content. Closing
    // it must publish the current node, without inventing a deletion or copy.
    const value = privatePayload.nodeKind === 'separator'
      ? { description: current.description ?? null } : { title: current.title };
    return { base: { ...value }, value };
  }
  const base: Record<string, unknown> = {};
  const value: Record<string, unknown> = {};
  const custom = command.resolution === 'custom' && fields.length > 1
    ? assertPlainCustomObject(command.value, invalid) : undefined;
  if (custom && (fields.some(field => !Object.hasOwn(custom, field))
    || Object.keys(custom).some(field => !fields.includes(field)))) invalid();
  for (const field of fields) {
    base[field] = fieldValue(current, field);
    const selected = command.resolution === 'server' ? base[field]
      : command.resolution === 'incoming' ? fieldValue(privatePayload.incoming, field)
      : custom ? custom[field] : command.value;
    value[field] = field === 'extensions'
      ? selectedExtensionNamespaces(current, privatePayload, selected) : selected;
  }
  for (const field of Object.keys(privatePayload.incoming)) {
    if (fields.includes(field)) continue;
    const merged = mergeRetainedField(field, current, mergePayload);
    // A later edit may turn an originally independent field into a new
    // conflict. Keep the encrypted intent open instead of overwriting it.
    if (merged.status !== 'merged') {
      throw new SyncConflictResolutionError('precondition_failed', command.conflictRevision);
    }
    base[field] = fieldValue(current, field);
    value[field] = merged.value[field];
  }
  if (privatePayload.nodeKind !== 'bookmark') return { base, value };
  selectBookmarkDecisionMetadata(current, privatePayload, fields, value);
  const normalized = reconcileSyncBookmarkMetadata(current, value, privatePayload.base, privatePayload.incoming, baseUrl);
  return {
    base: Object.fromEntries(Object.keys(normalized).map(field => [field, fieldValue(current, field)])),
    value: { ...normalized },
  };
}

/** Independent metadata from an unchosen URL cannot follow a server/custom
 * URL decision. Explicitly conflicting metadata follows the same user choice;
 * null clears remain independent of the URL. Validate original incoming bytes
 * before this selection, then rebase the selected pair onto Current. */
function selectBookmarkDecisionMetadata(current: Readonly<Record<string, unknown>>,
  payload: PrivateConflictPayload, conflictingFields: readonly string[], value: Record<string, unknown>) {
  const selectedUrl = value.url, incomingUrl = payload.incoming.url;
  if (typeof selectedUrl !== 'string' || typeof incomingUrl !== 'string' || selectedUrl === incomingUrl) return;
  const equivalent = isEquivalentBookmarkUrlRewrite(selectedUrl, incomingUrl);
  for (const field of ['urlHash', 'canonicalUrl']) {
    if (conflictingFields.includes(field) || value[field] === null || value[field] === undefined) continue;
    if (field === 'canonicalUrl' && equivalent) continue;
    value[field] = selectedUrl === current.url ? fieldValue(current, field) : null;
  }
}

function mergeRetainedField(field: string, current: Readonly<Record<string, unknown>>, payload: PrivateConflictPayload) {
  return mergeSyncNodeContentFields({ [field]: fieldValue(payload.base, field) },
    { [field]: fieldValue(current, field) }, { [field]: fieldValue(payload.incoming, field) });
}

/** A field-level decision settles only competing namespaces. Independent
 * additions and removals still merge; absence removes a namespace, while a
 * JSON null value is retained as that namespace's explicit value. */
function selectedExtensionNamespaces(current: Readonly<Record<string, unknown>>,
  payload: PrivateConflictPayload, selected: unknown) {
  const choice = selected ?? {};
  if (!isRecord(choice)) invalid();
  const merged = mergeSyncExtensionNamespaces(payload.base.extensions, current.extensions,
    payload.incoming.extensions, namespace => choice[namespace]);
  if (merged === undefined) invalid();
  return merged;
}

/** A separate node keeps the full incoming edit, including fields that were
 * independent at admission. Existing live nodes and tombstones stay intact. */
export function duplicateNodeDocument(
  current: Readonly<Record<string, unknown>>,
  privatePayload: PrivateConflictPayload,
  pointers: readonly string[],
): NodeCreate {
  const baseUrl = validatedBookmarkBaseUrl(privatePayload);
  const mergePayload = currentMergePayload(current, privatePayload, baseUrl);
  const selected: Record<string, unknown> = {};
  for (const field of Object.keys(privatePayload.incoming)) {
    const merged = mergeRetainedField(field, current, mergePayload);
    selected[field] = field === 'extensions'
      ? selectedExtensionNamespaces(current, privatePayload, privatePayload.incoming.extensions)
      : pointers.includes(`/${field}`) || merged.status === 'conflict'
      ? privatePayload.incoming[field] : merged.value[field];
  }
  const content = { ...current, ...(privatePayload.nodeKind === 'bookmark'
    ? reconcileSyncBookmarkMetadata(current, selected, privatePayload.base, privatePayload.incoming, baseUrl) : selected) };
  const description = assertValidNodeDescription(content.description as string | null | undefined ?? null);
  const tags = assertValidNodeTags(content.tags as readonly string[] | undefined ?? []);
  const visibility = assertValidNodeVisibility(content.visibility as string | undefined ?? 'inherit');
  if (!isRecord(content.extensions ?? {})) invalid();
  const preserved = preserveExtensions((content.extensions ?? {}) as Parameters<typeof preserveExtensions>[0],
    { surface: 'sync-server', path: '/payload/node' });
  if (preserved.removals.length !== 0) invalid();
  const common = { tags: [...tags], visibility, extensions: preserved.extensions,
    ...(description === null ? {} : { description }) };
  if (privatePayload.nodeKind === 'separator') return { ...common, kind: 'separator' };
  const title = assertValidNodeTitle(content.title as string, privatePayload.nodeKind);
  if (privatePayload.nodeKind === 'folder') return { ...common, kind: 'folder', title };
  const url = assertValidHttpUrlNoUserInfo(content.url as string);
  if (!validateBookmarkUrlHashSemantics({ url,
    ...(content.urlHash === null || content.urlHash === undefined ? {} : { urlHash: content.urlHash }) }).valid) invalid();
  return { ...common, kind: 'bookmark', title, url,
    ...(typeof content.canonicalUrl === 'string'
      ? { canonicalUrl: assertValidHttpUrlNoUserInfo(content.canonicalUrl) as HttpUrl } : {}),
    ...(typeof content.urlHash === 'string' ? { urlHash: content.urlHash } : {}),
  };
}
