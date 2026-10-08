import type { ProblemCode } from '@know-n/colp/server';
import { validateBookmarkUrlHashSemantics } from '@know-n/colp/semantic';
import {
  deepEqualSyncMergeValue,
  mergeSyncTypedUpdate,
  validateSyncTypedUpdateOperationPayload,
  type SyncTypedUpdateOperation,
} from '@know-n/colp/sync';
import { preserveExtensions } from '@know-n/colp/schema';
import type { Operation } from '@know-n/colp/types';
import {
  assertValidHttpUrlNoUserInfo,
  assertValidNodeDescription,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  isEquivalentBookmarkUrlRewrite,
  type JsonObject,
  type JsonValue,
  type ResourceOwnedFields,
  validBookmarkPinExtension,
} from '../collections/index.js';

export type SyncNodeKind = 'folder' | 'bookmark' | 'separator';

export interface TrustedSyncNodeRevision {
  readonly collectionId: string;
  readonly resourceId: string;
  readonly revision: string;
  readonly kind: SyncNodeKind;
  readonly deleted: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SyncNodeUpdateBudget {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxMembers: number;
}

export type SyncNodeUpdateEvaluation =
  | {
      readonly status: 'merged';
      readonly resultStatus: 'applied' | 'rebased';
      readonly collectionId: string;
      readonly targetId: string;
      readonly expectedCurrentRevision: string;
      readonly fields: ResourceOwnedFields;
      /** Authoritative post-merge field values over the client's Base domain; reflowed as the receipt transform. */
      readonly merged: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: 'conflict';
      readonly code: 'sync_base_unavailable' | 'sync_base_untrusted' | 'sync_conflict_pending';
      readonly fields: readonly string[];
    };

const DEFAULT_BUDGET: SyncNodeUpdateBudget = Object.freeze({
  maxBytes: 131_072,
  maxDepth: 64,
  maxMembers: 20_000,
});

const COMMON_FIELDS = new Set(['description', 'tags', 'visibility', 'extensions']);
const FOLDER_FIELDS = new Set([...COMMON_FIELDS, 'title']);
const BOOKMARK_FIELDS = new Set([...COMMON_FIELDS, 'title', 'url', 'canonicalUrl', 'urlHash']);
const SEPARATOR_FIELDS = COMMON_FIELDS;

export class SyncNodeUpdateError extends Error {
  constructor(public readonly code: ProblemCode) {
    super(`Sync Node update denied: ${code}`);
    this.name = 'SyncNodeUpdateError';
  }
}

function deny(code: ProblemCode): never {
  throw new SyncNodeUpdateError(code);
}

/**
 * Evaluates one schema-validated typed Node update against transaction-loaded,
 * authoritative Base and Current snapshots. Client Base is comparison evidence only.
 */
export function evaluateSyncNodeUpdate(
  operation: Operation,
  trustedBase: TrustedSyncNodeRevision | undefined,
  current: TrustedSyncNodeRevision,
  budget: SyncNodeUpdateBudget = DEFAULT_BUDGET,
): Readonly<SyncNodeUpdateEvaluation> {
  if (operation.type !== 'update_node_content') deny('unsupported_operation');
  if (typeof operation.collectionId !== 'string' || operation.collectionId.length < 1
      || typeof operation.targetId !== 'string' || operation.targetId.length < 1
      || typeof operation.baseRevision !== 'string' || operation.baseRevision.length < 1) {
    deny('invalid_document');
  }
  const semantic = validateSyncTypedUpdateOperationPayload(operation as SyncTypedUpdateOperation);
  if (!semantic.valid) deny('invalid_document');
  if (current.collectionId !== operation.collectionId || current.resourceId !== operation.targetId) {
    deny('resource_not_found');
  }
  if (!isSupportedKind(current.kind) || current.payload.kind !== current.kind) deny('invalid_document');
  if (current.deleted) return conflict('sync_conflict_pending', ['deletedAt']);
  if (!trustedBase) {
    return conflict('sync_base_unavailable', []);
  }
  if (trustedBase.collectionId !== operation.collectionId
      || trustedBase.resourceId !== operation.targetId
      || trustedBase.revision !== operation.baseRevision) {
    return conflict('sync_base_unavailable', []);
  }
  if (!isSupportedKind(trustedBase.kind) || trustedBase.payload.kind !== trustedBase.kind) {
    deny('invalid_document');
  }
  if (trustedBase.deleted || trustedBase.kind !== current.kind) {
    return conflict('sync_base_untrusted', []);
  }

  const payload = operation.payload as { readonly base: Readonly<Record<string, unknown>>;
    readonly value: Readonly<Record<string, unknown>> };
  const fields = Object.keys(payload.base);
  assertAllowedFields(current.kind, fields);
  assertBudget([payload.base, payload.value, trustedBase.payload, current.payload], budget);
  const trustedProjection = projectFields(trustedBase.payload, fields);
  const currentProjection = projectFields(current.payload, fields);
  const untrusted = fields.filter((field) => !deepEqualSyncMergeValue(
    payload.base[field], trustedProjection[field],
  ));
  if (untrusted.length > 0) return conflict('sync_base_untrusted', untrusted.sort());

  const extensions = fields.includes('extensions')
    ? mergeExtensionNamespaces(trustedProjection.extensions, currentProjection.extensions, payload.value.extensions)
    : undefined;
  const merged = mergeSyncTypedUpdate(extensions === undefined
    ? { base: trustedProjection, current: currentProjection, incoming: payload.value }
    : { base: withoutExtensions(trustedProjection), current: withoutExtensions(currentProjection),
        incoming: withoutExtensions(payload.value) });
  if (merged.status === 'conflict') {
    return conflict('sync_conflict_pending', merged.conflicts.map((item) => item.field).sort());
  }
  const pinnedMerged = pinEquivalentBookmarkUrlMerge(current,
    extensions === undefined ? merged.value : Object.freeze({ ...merged.value, extensions }));
  assertBudget([pinnedMerged], budget);
  const canonical = canonicalFields(current.kind, pinnedMerged, current.payload);
  return Object.freeze({
    status: 'merged' as const,
    resultStatus: current.revision === trustedBase.revision ? 'applied' as const : 'rebased' as const,
    collectionId: operation.collectionId,
    targetId: operation.targetId,
    expectedCurrentRevision: current.revision,
    fields: Object.freeze(canonical),
    merged: pinnedMerged,
  });
}

/**
 * Extension namespaces belong to different features (a bookmark pin, an import's
 * attributes), so they merge one namespace at a time: a pin set on one device and
 * another namespace changed elsewhere both land. Undefined means some namespace
 * changed differently on both sides, which stays an `extensions` field conflict.
 */
function mergeExtensionNamespaces(base: unknown, current: unknown, incoming: unknown): JsonObject | undefined {
  const sides = [base ?? {}, current ?? {}, incoming ?? {}];
  if (!sides.every((side) => side !== null && typeof side === 'object' && !Array.isArray(side))) return undefined;
  const [b, c, i] = sides as Record<string, unknown>[];
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b!), ...Object.keys(c!), ...Object.keys(i!)])) {
    const [baseValue, currentValue, incomingValue] = [b!, c!, i!].map((side) => Object.hasOwn(side, key) ? side[key] : undefined);
    let value: unknown;
    if (deepEqualSyncMergeValue(baseValue, incomingValue)) value = currentValue;
    else if (deepEqualSyncMergeValue(baseValue, currentValue) || deepEqualSyncMergeValue(currentValue, incomingValue)) value = incomingValue;
    else return undefined;
    if (value !== undefined) merged[key] = value;
  }
  return merged as JsonObject;
}

function withoutExtensions(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const { extensions: _extensions, ...rest } = fields;
  return rest;
}

function isSupportedKind(value: unknown): value is SyncNodeKind {
  return value === 'folder' || value === 'bookmark' || value === 'separator';
}

/**
 * CS-01 generation fence: a bookmark `url` whose submitted spelling is
 * normalization-equivalent to the stored one is not a content change.
 * Pinning `url` — and its `urlHash` digest, which binds the preserved raw
 * bytes — to the stored value keeps the receipt/base projection, the
 * canonical write, and the generation fence all on the original URL.
 * Without the pin the stored value and the reflowed merge would diverge
 * and the client's next base would fail `sync_base_untrusted`.
 */
function pinEquivalentBookmarkUrlMerge(
  current: TrustedSyncNodeRevision,
  merged: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (current.kind !== 'bookmark') return merged;
  const storedUrl = current.payload.url;
  const submitted = merged.url;
  if (typeof storedUrl !== 'string' || typeof submitted !== 'string') return merged;
  if (!isEquivalentBookmarkUrlRewrite(storedUrl, submitted)) return merged;
  const pinned: Record<string, unknown> = { ...merged, url: storedUrl };
  if (Object.hasOwn(pinned, 'urlHash')) {
    const storedHash = current.payload.urlHash;
    if (typeof storedHash === 'string') pinned.urlHash = storedHash;
    else delete pinned.urlHash;
  }
  return Object.freeze(pinned);
}

function conflict(
  code: Extract<SyncNodeUpdateEvaluation, { status: 'conflict' }>['code'],
  fields: readonly string[],
): Extract<SyncNodeUpdateEvaluation, { status: 'conflict' }> {
  return Object.freeze({ status: 'conflict' as const, code, fields: Object.freeze([...fields]) });
}

function assertAllowedFields(kind: SyncNodeKind, fields: readonly string[]): void {
  const allowed = kind === 'bookmark' ? BOOKMARK_FIELDS
    : kind === 'folder' ? FOLDER_FIELDS : SEPARATOR_FIELDS;
  for (const field of fields) {
    if (field === 'targetNodeId') deny('unsupported_operation');
    if (field === 'constraints') deny('unsupported_operation');
    if (!allowed.has(field)) deny('invalid_document');
  }
}

function projectFields(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): Readonly<Record<string, unknown>> {
  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    if (field === 'extensions') projected[field] = payload.extensions ?? {};
    else if (field === 'canonicalUrl' || field === 'urlHash') projected[field] = payload[field] ?? null;
    else projected[field] = payload[field];
  }
  return Object.freeze(projected);
}

function canonicalFields(
  kind: SyncNodeKind,
  merged: Readonly<Record<string, unknown>>,
  currentPayload: Readonly<Record<string, unknown>>,
): ResourceOwnedFields {
  const kindFields: Record<string, JsonValue> = {};
  let extensions = (currentPayload.extensions ?? {}) as JsonObject;
  try {
    for (const [field, value] of Object.entries(merged)) {
      switch (field) {
        case 'title':
          if (kind === 'separator' || value === null) deny('invalid_document');
          kindFields.title = assertValidNodeTitle(value as string);
          break;
        case 'url':
          if (kind !== 'bookmark' || value === null) deny('invalid_document');
          kindFields.url = assertValidHttpUrlNoUserInfo(value as string);
          break;
        case 'canonicalUrl':
          if (kind !== 'bookmark') deny('invalid_document');
          kindFields.canonicalUrl = value === null ? null : assertValidHttpUrlNoUserInfo(value as string);
          break;
        case 'urlHash':
          if (kind !== 'bookmark' || (value !== null && (typeof value !== 'string'
              || !/^sha-256=:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=:$/u.test(value)))) {
            deny('invalid_document');
          }
          kindFields.urlHash = value as string | null;
          break;
        case 'description':
          kindFields.description = assertValidNodeDescription(value as string | null);
          break;
        case 'tags':
          kindFields.tags = [...assertValidNodeTags(value === null ? [] : value as readonly string[])];
          break;
        case 'visibility':
          if (value === null) deny('invalid_document');
          kindFields.visibility = assertValidNodeVisibility(value as string);
          break;
        case 'extensions': {
          const preserved = preserveExtensions((value ?? {}) as Record<string, unknown>, {
            surface: 'sync-server', path: '/payload/value/extensions',
          });
          if (preserved.removals.length !== 0) deny('invalid_document');
          if (!validBookmarkPinExtension(kind, preserved.extensions)) deny('invalid_document');
          extensions = preserved.extensions as JsonObject;
          break;
        }
        default: deny('invalid_document');
      }
    }
  } catch (error) {
    if (error instanceof SyncNodeUpdateError) throw error;
    deny('invalid_document');
  }
  if (kind === 'bookmark') {
    const resultingUrl = Object.hasOwn(merged, 'url') ? merged.url : currentPayload.url;
    const mergedUrlHash = Object.hasOwn(merged, 'urlHash') ? merged.urlHash : currentPayload.urlHash;
    const semantic = validateBookmarkUrlHashSemantics({
      url: resultingUrl,
      ...(mergedUrlHash === null || mergedUrlHash === undefined ? {} : { urlHash: mergedUrlHash }),
    });
    if (!semantic.valid) deny('invalid_document');
  }
  return { kindFields, extensions };
}

function assertBudget(values: readonly unknown[], budget: SyncNodeUpdateBudget): void {
  for (const value of Object.values(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) deny('payload_too_large');
  }
  let bytes = 0;
  let members = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > budget.maxDepth) deny('payload_too_large');
    if (Array.isArray(value)) {
      members += value.length;
      for (const item of value) visit(item, depth + 1);
    } else if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      members += entries.length;
      for (const [, item] of entries) visit(item, depth + 1);
    }
    if (members > budget.maxMembers) deny('payload_too_large');
  };
  for (const value of values) {
    let encoded: string;
    try {
      const candidate = JSON.stringify(value);
      if (candidate === undefined) deny('invalid_document');
      encoded = candidate;
    } catch {
      deny('invalid_document');
    }
    bytes += Buffer.byteLength(encoded, 'utf8');
    if (bytes > budget.maxBytes) deny('payload_too_large');
    visit(value, 1);
  }
}
