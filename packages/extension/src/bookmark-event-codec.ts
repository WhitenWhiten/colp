import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createNodeOperationPayload, deleteOperationPayload, moveOperationPayload,
  nodeContentUpdateOperationPayload, operation as validateColpOperation } from './generated/bookmark-operation-validators.js';
import type { JsonObject, JsonValue, MappingInput } from './sync-state-store.js';
import { bookmarkUrl } from './generated/import-preview-validators.js';

export interface BookmarkEventNode {
  readonly id: string; readonly parentId?: string; readonly index?: number; readonly title: string; readonly url?: string;
  readonly type?: 'bookmark' | 'folder' | 'separator'; readonly children?: readonly BookmarkEventNode[];
  readonly unmodifiable?: string; readonly folderType?: string;
}

export const MAX_OPERATION_BYTES = 64 * 1024;
export const INBOX_PARENT_WIRE_PLACEHOLDER = 'inbox-parent';

export type BookmarkRepresentability = 'supported' | 'unsupported_url_scheme' | 'invalid_title' | 'invalid_url';

/** Shared ingress contract: only content the server can represent enters COLP sequence. */
export function bookmarkRepresentability(node: Pick<BookmarkEventNode, 'title' | 'url' | 'type'>): BookmarkRepresentability {
  if (node.type !== 'separator' && node.title.trim().length === 0) return 'invalid_title';
  if (node.title.length > 4096) return 'invalid_title';
  if (node.type === 'bookmark' || typeof node.url === 'string') {
    const url = node.url;
    if (typeof url !== 'string' || !bookmarkUrl(url)) return 'invalid_url';
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(url)?.[0].slice(0, -1).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return 'unsupported_url_scheme';
    try { const parsed = new URL(url); if (parsed.username || parsed.password) return 'invalid_url'; }
    catch { return 'invalid_url'; }
  }
  return 'supported';
}

export function validateOperation(operation: JsonObject) { return validateColpOperation(operation); }
export function durableEventDetails(details: JsonObject): JsonObject {
  const operation = asObject(details.operation, 'operation');
  const payload = asObject(operation.payload, 'payload');
  let draft: JsonObject;
  if (operation.type === 'create_node') draft = { type: operation.type, payload: { node: payload.node! } };
  else if (operation.type === 'update_node_content') draft = { type: operation.type,
    targetId: operation.targetId!, baseRevision: operation.baseRevision!, payload };
  else if (operation.type === 'move_node') draft = { type: operation.type,
    ...(operation.targetId === undefined ? {} : { targetId: operation.targetId }),
    ...(typeof operation.baseRevision === 'string' && (typeof operation.targetId === 'string' && operation.targetId.startsWith('pending-')
      || !/^(?:pending|local)-/u.test(operation.baseRevision))
      ? { baseRevision: operation.baseRevision } : {}), payload: {} };
  else draft = { type: operation.type!, targetId: operation.targetId!, baseRevision: operation.baseRevision!, payload };
  const { operation: _operation, ...localDetails } = details;
  return { ...localDetails, draft: { ...draft, ...(operation.source ? { source: operation.source } : {}) } };
}
export function collectStrings(value: JsonValue): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}
export function resolveCommittedTokens(value: JsonValue, resolved: ReadonlyMap<string, string>): JsonValue {
  if (typeof value === 'string') {
    for (const [eventId, opId] of resolved) {
      if (value === eventId) return opId;
      if (value === `pending-${eventId}`) return `pending-${opId}`;
      if (value === `local-${eventId}`) return `local-${opId}`;
    }
    return value;
  }

  return value;
}
export function assertOperationCandidate(operation: JsonObject) {
  const payload = operation.payload;
  const valid = operation.type === 'create_node' ? createNodeOperationPayload(payload)
    : operation.type === 'update_node_content' ? nodeContentUpdateOperationPayload(payload)
    : operation.type === 'move_node' ? moveOperationPayload(payload)
    : operation.type === 'delete_node' || operation.type === 'delete_subtree'
      ? deleteOperationPayload(payload) : false;
  if (!valid) throw new Error('operation_schema_invalid');
  if (new TextEncoder().encode(JSON.stringify(operation)).byteLength > MAX_OPERATION_BYTES) {
    throw new Error('operation_byte_budget_exceeded');
  }
}
export function nodeCreate(node: BookmarkEventNode): JsonObject {
  const kind = bookmarkKind(node);
  if (kind === 'separator') return { kind };
  return kind === 'bookmark' ? { kind, title: node.title, url: node.url! } : { kind, title: node.title };
}
export function nodeContent(node: BookmarkEventNode): JsonObject {
  const kind = bookmarkKind(node);
  if (kind === 'separator') return {};
  return kind === 'bookmark' ? { title: node.title, url: node.url! } : { title: node.title };
}
export function nativeContent(content: JsonObject): JsonObject {
  return { ...(typeof content.title === 'string' ? { title: content.title } : {}),
    ...(typeof content.url === 'string' ? { url: content.url } : {}) };
}
export function flattenNativeIds(node: BookmarkEventNode): string[] {
  return [node.id, ...(node.children ?? []).flatMap(flattenNativeIds)];
}
export function bookmarkKind(node: BookmarkEventNode): NonNullable<MappingInput['nodeKind']> {
  return node.type === 'separator' ? 'separator' : typeof node.url === 'string' ? 'bookmark' : 'folder';
}
/** Bootstrap local-only create opIds are `b3.{confirmation}.create.{nativeId}`. Never a wire identity. */
export function plannedCreateNativeId(opId: string): string | undefined {
  const match = /\.create\.([A-Za-z0-9_-]+)$/.exec(opId);
  const nativeId = match?.[1];
  return liveCreateNativeId(nativeId);
}
export function liveCreateNativeId(nativeId: string | undefined): string | undefined {
  if (!nativeId || nativeId.startsWith('pending-') || nativeId.startsWith('recovery:')
      || nativeId.startsWith('sidecar:') || nativeId.startsWith('unmounted:')
      || nativeId.startsWith('local-')) return undefined;
  return nativeId;
}
export function isDescendant(candidate: MappingInput, ancestorNativeId: string, all: readonly MappingInput[]) {
  const byNative = new Map(all.map((mapping) => [mapping.nativeId, mapping])); let parent = candidate.parentNativeId;
  const seen = new Set<string>();
  while (parent) { if (parent === ancestorNativeId) return true; if (seen.has(parent)) return false;
    seen.add(parent); parent = byNative.get(parent)?.parentNativeId; }
  return false;
}
export function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}_invalid`); return value;
}
export function asStringArray(value: JsonValue, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label}_invalid`);
  return value as string[];
}
export function digestJson(value: JsonValue | JsonObject): string {
  const encoded = new TextEncoder().encode(stableJson(value)); return `sha256:${bytesToHex(sha256(encoded))}`;
}
function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`;
}
export async function captureStep<T>(code: 'privacy_evaluation_failed' | 'parent_identity_failed' | 'apply_intent_failed'
  | 'relative_placement_failed' | 'children_lookup_failed' | 'sibling_identity_failed'
  | 'bookmark_event_stage_failed', operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof Error
      && (error.message === 'operation_schema_invalid' || error.message === 'operation_byte_budget_exceeded'
        || error.message === 'children_lookup_failed' || error.message === 'sibling_identity_failed')) throw error;
    throw new Error(code);
  }
}
export function isManagedBookmarkNode(node: {
  readonly unmodifiable?: string; readonly folderType?: string;
}): boolean {
  return node.unmodifiable === 'managed' || node.folderType === 'managed';
}
