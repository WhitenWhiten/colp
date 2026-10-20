import type { HttpUrl, NodeCreate } from '@know-n/colp/types';
import { preserveExtensions } from '@know-n/colp/schema';
import {
  mergeSyncNodeContentFields, SyncConflictResolutionError,
  type ValidatedSyncConflictResolutionCommand,
} from '../../modules/sync/index.js';
import {
  assertValidHttpUrlNoUserInfo, assertValidNodeDescription, assertValidNodeTags,
  assertValidNodeTitle, assertValidNodeVisibility,
  invalidateOmittedBookmarkUrlMetadata,
} from '../../modules/collections/index.js';
import { assertPlainCustomObject, isRecord } from './sync-conflict-json.js';
import type { PrivateConflictPayload } from './sync-conflict-private-payload.js';

function invalid(): never { throw new SyncConflictResolutionError('invalid_document'); }
function fieldValue(payload: Readonly<Record<string, unknown>>, field: string): unknown {
  if (field === 'extensions') return payload[field] ?? {};
  if (field === 'canonicalUrl' || field === 'urlHash') return payload[field] ?? null;
  return payload[field];
}

/** Settle only the advertised conflicting fields by the user's choice; all
 * other retained fields still follow the ordinary three-way merge rules. */
export function selectedResolutionFields(
  command: ValidatedSyncConflictResolutionCommand,
  current: Readonly<Record<string, unknown>>,
  privatePayload: PrivateConflictPayload,
  pointers: readonly string[],
): Readonly<{ base: Record<string, unknown>; value: Record<string, unknown> }> {
  const fields = pointers.map(pointer => pointer.slice(1))
    .filter(field => !['baseRevision', 'deletedAt'].includes(field));
  if (fields.length < 1) throw new SyncConflictResolutionError('unsupported_operation');
  const base: Record<string, unknown> = {};
  const value: Record<string, unknown> = {};
  const custom = command.resolution === 'custom' && fields.length > 1
    ? assertPlainCustomObject(command.value, invalid) : undefined;
  if (custom && (fields.some(field => !Object.hasOwn(custom, field))
    || Object.keys(custom).some(field => !fields.includes(field)))) invalid();
  for (const field of fields) {
    base[field] = fieldValue(current, field);
    value[field] = command.resolution === 'server' ? base[field]
      : command.resolution === 'incoming' ? fieldValue(privatePayload.incoming, field)
      : custom ? custom[field] : command.value;
  }
  for (const field of Object.keys(privatePayload.incoming)) {
    if (fields.includes(field)) continue;
    const merged = mergeRetainedField(field, current, privatePayload);
    // A later edit may turn an originally independent field into a new
    // conflict. Keep the encrypted intent open instead of overwriting it.
    if (merged.status !== 'merged') {
      throw new SyncConflictResolutionError('precondition_failed', command.conflictRevision);
    }
    base[field] = fieldValue(current, field);
    value[field] = merged.value[field];
  }
  return { base, value };
}

function mergeRetainedField(field: string, current: Readonly<Record<string, unknown>>, payload: PrivateConflictPayload) {
  return mergeSyncNodeContentFields({ [field]: fieldValue(payload.base, field) },
    { [field]: fieldValue(current, field) }, { [field]: fieldValue(payload.incoming, field) });
}

/** A separate node keeps the full incoming edit, including fields that were
 * independent at admission. Existing live nodes and tombstones stay intact. */
export function duplicateNodeDocument(
  current: Readonly<Record<string, unknown>>,
  privatePayload: PrivateConflictPayload,
  pointers: readonly string[],
): NodeCreate {
  const selected: Record<string, unknown> = {};
  for (const field of Object.keys(privatePayload.incoming)) {
    const merged = mergeRetainedField(field, current, privatePayload);
    selected[field] = pointers.includes(`/${field}`) || merged.status === 'conflict'
      ? privatePayload.incoming[field] : merged.value[field];
  }
  const content = { ...current, ...(privatePayload.nodeKind === 'bookmark'
    ? invalidateOmittedBookmarkUrlMetadata(selected, current) : selected) };
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
  return { ...common, kind: 'bookmark', title, url,
    ...(typeof content.canonicalUrl === 'string'
      ? { canonicalUrl: assertValidHttpUrlNoUserInfo(content.canonicalUrl) as HttpUrl } : {}),
    ...(typeof content.urlHash === 'string' ? { urlHash: content.urlHash } : {}),
  };
}
