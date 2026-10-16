import { folderSyncCoverage } from './bookmark-sync-range.js';
import { classifyDeletionScope, type DeletionScopeClass } from './bookmark-node-identity.js';
import type { BookmarkEventNode } from './bookmark-event-codec.js';
import type { JsonObject, MappingInput } from './sync-state-store.js';

const MAX_ANCESTORS = 256;

export type AncestorLookup = { get(id: string): Promise<readonly { readonly parentId?: string }[]> };

/**
 * Classify a removal from the callback parent (still present). Never `get(deletedId)`.
 * A thrown ancestor lookup fails closed; an empty get stops the walk but keeps parentId.
 */
export async function classifyRemovalScope(input: {
  readonly nativeId: string; readonly parentId: string; readonly managed: boolean;
  readonly api: AncestorLookup;
  readonly selectedNative: ReadonlySet<string>; readonly privateNative: ReadonlySet<string>;
  readonly detachedNative: ReadonlySet<string>; readonly mapping: MappingInput | null;
}): Promise<DeletionScopeClass> {
  const hasInScopeMapping = Boolean(input.mapping && (input.selectedNative.has(input.mapping.rootNativeId)
    || input.selectedNative.has(input.mapping.nativeId)));
  if (!input.parentId) {
    return classifyDeletionScope({
      managed: input.managed, ancestorWalkFailed: true, selectedAncestor: false, privateAncestor: false,
      detachedMount: false, hasInScopeMapping,
    });
  }
  const walked = await walkFromParent(input.api, input.parentId, input.nativeId);
  const ancestors = walked.ancestors;
  const coverage = folderSyncCoverage(input.nativeId, ancestors, input.selectedNative, input.privateNative);
  return classifyDeletionScope({
    managed: input.managed, ancestorWalkFailed: walked.failed, selectedAncestor: coverage.selected, privateAncestor: coverage.privateLocal,
    detachedMount: ancestors.some((id) => input.detachedNative.has(id)), hasInScopeMapping,
  });
}

export function removalNodePresent(node: BookmarkEventNode | null | undefined): node is BookmarkEventNode {
  return Boolean(node && typeof node.id === 'string' && node.id.length > 0);
}

export type DeletionNodeKind = 'folder' | 'bookmark' | 'separator';

/**
 * Kind of the node being removed, from the strongest available evidence — never
 * from how many descendants this replica happens to know:
 *
 *  1. the browser callback node (`type`, then `url`);
 *  2. the complete staged snapshot row for that server identity (the server's own
 *     `kind`, frozen together with the confirmation that authorises the delete);
 *  3. the durable mapping identity (`nodeKind`, then a projected `url`, which a
 *     folder projection never carries).
 *
 * `undefined` means the kind is unproven and the operation shape must fail safe.
 */
export function deletionNodeKind(input: {
  readonly eventNode?: Pick<BookmarkEventNode, 'type' | 'url'> | null;
  readonly snapshotKind?: 'Folder' | 'Bookmark' | 'Separator' | null;
  readonly mappedKind?: MappingInput['nodeKind'] | null;
  readonly mappedContent?: JsonObject | null;
}): DeletionNodeKind | undefined {
  const node = input.eventNode;
  if (node) {
    if (node.type === 'folder' || node.type === 'bookmark' || node.type === 'separator') return node.type;
    if (typeof node.url === 'string') return 'bookmark';
  }
  if (input.snapshotKind) return snapshotNodeKind(input.snapshotKind);
  if (input.mappedKind) return input.mappedKind;
  if (typeof input.mappedContent?.url === 'string') return 'bookmark';
  return undefined;
}

function snapshotNodeKind(kind: 'Folder' | 'Bookmark' | 'Separator'): DeletionNodeKind {
  return kind === 'Folder' ? 'folder' : kind === 'Bookmark' ? 'bookmark' : 'separator';
}

/**
 * Authoritative delete shape, matching colp `translateSyncBrowserDelete`:
 * a folder is always `delete_subtree`, because a browser is not required to
 * emit one child event per descendant. Only a proven non-folder (bookmark or
 * separator) may use `delete_node`; an unproven kind fails safe toward
 * `delete_subtree`, since the server permanently refuses (`invalid_document`,
 * 422) a single delete of a folder that still has children — and ingress has
 * already dropped the local mapping by the time that refusal arrives.
 */
export function deletionOperationType(kind: DeletionNodeKind | undefined): 'delete_node' | 'delete_subtree' {
  return kind === 'folder' || kind === undefined ? 'delete_subtree' : 'delete_node';
}

async function walkFromParent(api: AncestorLookup, parentId: string, deletedNativeId: string): Promise<{
  readonly ancestors: readonly string[]; readonly failed: boolean;
}> {
  const ancestors: string[] = [parentId];
  const seen = new Set<string>([parentId, deletedNativeId]);
  let current = parentId;
  for (let depth = 0; depth < MAX_ANCESTORS && current; depth += 1) {
    let values: readonly { readonly parentId?: string }[];
    try { values = await api.get(current); }
    catch { return { ancestors, failed: true }; }
    if (!values[0]) return { ancestors, failed: false };
    const parent = values[0].parentId;
    current = typeof parent === 'string' ? parent : '';
    if (!current || seen.has(current)) return { ancestors, failed: false };
    seen.add(current); ancestors.push(current);
  }
  return { ancestors, failed: false };
}
