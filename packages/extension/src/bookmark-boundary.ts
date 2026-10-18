import { folderIsInMount, folderSyncCoverage } from './bookmark-sync-range.js';
import { bookmarkRepresentability } from './bookmark-event-codec.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  customSourceKeyForFolder, folderRoleForBrowserRoot, type BrowserRootKind, type ColpFolderRole,
  type NormalizedBookmarkNode, type NormalizedBookmarkRoot, type SpecialFolderRole,
} from './chrome-bookmark-tree.js';
import { canonicalJson } from './sync-state/codec.js';
import { normalizeBoundaries } from './sync-state/scope-key.js';

export type BoundaryNodeClass = 'collection-root' | 'special-root' | 'ordinary-folder'
  | 'managed' | 'private-local' | 'out-of-boundary' | 'unsupported';

export interface PlannedMount {
  readonly nativeRootId: string; readonly writable: boolean; readonly materialized: boolean;
  readonly rootRole?: SpecialFolderRole; readonly customSourceKey?: string;
}

export interface BoundaryScan {
  readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds: readonly string[];
  readonly nestedNormalized: boolean;
  readonly bookmarkCount: number; readonly folderCount: number; readonly skippedCount: number;
  readonly treeDigest: string;
  readonly warnings: readonly { readonly code: string }[];
  readonly mounts: readonly PlannedMount[];
  readonly collectionRootDirectBookmarks: 0;
  readonly classifications: ReadonlyMap<string, BoundaryNodeClass>;
}

export interface ScanBoundaryInput {
  readonly roots: readonly NormalizedBookmarkRoot[];
  readonly selectedNativeIds: readonly string[];
  readonly excludedNativeIds?: readonly string[];
  readonly privateNativeIds?: readonly string[];
  readonly unsupportedRoles?: readonly ColpFolderRole[];
}

interface IndexedNode {
  readonly node: NormalizedBookmarkNode; readonly rootKind: BrowserRootKind; readonly depth: number;
  readonly ancestorNativeIds: readonly string[]; readonly isSpecialRoot: boolean;
}

export function scanBoundary(input: ScanBoundaryInput): BoundaryScan {
  const indexed = indexTree(input.roots);
  const discovered = new Map(indexed.map((item) => [item.node.nativeId, item.ancestorNativeIds]));
  const selectedInput = uniqueIds(input.selectedNativeIds).filter((id) => discovered.has(id));
  const excluded = new Set(uniqueIds(input.excludedNativeIds ?? []).filter((id) => discovered.has(id)));
  const privateLocal = new Set(uniqueIds(input.privateNativeIds ?? []));
  const nestedNormalized = selectedInput.length !== new Set(input.selectedNativeIds).size
    || selectedInput.some((id) => discovered.get(id)!.some((ancestor) => selectedInput.includes(ancestor)));
  const selectedNativeIds = selectedInput.length ? normalizeBoundaries(selectedInput, discovered) : [];
  const selected = new Set(selectedNativeIds);
  const unsupported = new Map(indexed.flatMap(({ node, isSpecialRoot, ancestorNativeIds }) => {
    const included = folderIsInMount(node.nativeId, ancestorNativeIds, selected);
    const reason = isSpecialRoot || !included ? 'supported' : bookmarkRepresentability({ type: node.kind, title: node.title, url: node.url });
    return reason === 'supported' ? [] : [[node.nativeId, reason] as const];
  }));
  const warnings: Array<{ readonly code: string }> = [];
  if (nestedNormalized) warnings.push({ code: 'nested_normalized' });
  const classifications = new Map<string, BoundaryNodeClass>();
  const digestNodes: Array<Record<string, unknown>> = [];
  let bookmarkCount = 0; let folderCount = 0; let skippedCount = 0;
  for (const item of indexed) {
    const nativeId = item.node.nativeId;
    const managed = item.node.managed;
    const excludedHere = folderIsInMount(nativeId, item.ancestorNativeIds, excluded);
    const { selected: inSelected, privateLocal: privateHere } = folderSyncCoverage(nativeId, item.ancestorNativeIds, selected, privateLocal);
    let classification: BoundaryNodeClass;
    if (managed) classification = 'managed';
    else if (privateHere) classification = 'private-local';
    else if (excludedHere || !inSelected) classification = 'out-of-boundary';
    else if (unsupported.has(nativeId) || item.ancestorNativeIds.some(id => unsupported.has(id))) {
      classification = 'unsupported';
      const code = unsupported.get(nativeId);
      if (code && !warnings.some(warning => warning.code === code)) warnings.push({ code });
    }
    else if (item.isSpecialRoot) classification = 'special-root';
    else classification = 'ordinary-folder';
    classifications.set(nativeId, classification);
    const inBoundary = classification === 'special-root' || classification === 'ordinary-folder';
    if (inBoundary && item.node.kind === 'bookmark') bookmarkCount += 1;
    else if (inBoundary && item.node.kind === 'folder') folderCount += 1;
    else skippedCount += 1;
    if (inBoundary) {
      digestNodes.push({ nativeId, kind: item.node.kind, title: item.node.title, parentNativeId: item.ancestorNativeIds.at(-1) ?? null,
        url: item.node.url ?? null, children: item.node.children.map((child) => child.nativeId) });
    }
  }
  const ancestry = new Set(indexed.filter(item => selected.has(item.node.nativeId)
    && ['special-root', 'ordinary-folder'].includes(classifications.get(item.node.nativeId) ?? ''))
    .flatMap(item => item.ancestorNativeIds));
  for (const item of indexed) if (ancestry.has(item.node.nativeId) && classifications.get(item.node.nativeId) === 'out-of-boundary') {
    digestNodes.push({ nativeId: item.node.nativeId, kind: 'folder', title: item.node.title,
      parentNativeId: item.ancestorNativeIds.at(-1) ?? null, children: [] });
  }
  const mounts = planMounts(indexed, selected, classifications, warnings, input.unsupportedRoles ?? []);
  const treeDigest = `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonicalJson({
    selected: selectedNativeIds, excluded: [...excluded].sort(), nodes: digestNodes,
  }))))}`;
  return { selectedNativeIds, excludedNativeIds: [...excluded], nestedNormalized, bookmarkCount, folderCount,
    skippedCount, treeDigest, warnings, mounts, collectionRootDirectBookmarks: 0, classifications };
}

export function planMountsFromScan(scan: BoundaryScan): readonly PlannedMount[] { return scan.mounts; }

function planMounts(indexed: readonly IndexedNode[], selected: ReadonlySet<string>,
  classifications: ReadonlyMap<string, BoundaryNodeClass>, warnings: Array<{ readonly code: string }>,
  unsupportedRoles: readonly ColpFolderRole[]): PlannedMount[] {
  const mounts: PlannedMount[] = [];
  const other = indexed.find((item) => item.isSpecialRoot && item.rootKind === 'other' && !item.node.managed);
  for (const item of indexed) {
    if (!selected.has(item.node.nativeId)) continue;
    const classification = classifications.get(item.node.nativeId);
    if (classification !== 'special-root' && classification !== 'ordinary-folder') continue;
    const role = folderRoleForBrowserRoot(item.rootKind, item.node.managed);
    if (role === 'managed-bookmarks') continue;
    if (item.isSpecialRoot && role !== 'custom') {
      mounts.push({ nativeRootId: item.node.nativeId, writable: true, materialized: false,
        rootRole: role as SpecialFolderRole });
      continue;
    }
    if (item.isSpecialRoot && role === 'custom') {
      warnings.push({ code: 'root_role_materialized' });
      mounts.push({ nativeRootId: other?.node.nativeId ?? item.node.nativeId, writable: true, materialized: true,
        customSourceKey: customSourceKeyForFolder(item.node.nativeId) });
      continue;
    }
    // A custom coverage root retains its browser ancestors; this is not Collection-root placement.
    mounts.push({ nativeRootId: item.node.nativeId, writable: true, materialized: false,
      customSourceKey: customSourceKeyForFolder(item.node.nativeId) });
  }
  for (const role of unsupportedRoles) {
    if (role === 'managed-bookmarks' || role === 'custom') continue;
    const already = mounts.some((mount) => mount.rootRole === role);
    if (already) continue;
    warnings.push({ code: 'root_role_materialized' });
    if (other) {
      mounts.push({ nativeRootId: other.node.nativeId, writable: true, materialized: true,
        customSourceKey: `materialized:${role}` });
    }
  }
  return mounts;
}

function indexTree(roots: readonly NormalizedBookmarkRoot[]): IndexedNode[] {
  const out: IndexedNode[] = [];
  const visit = (node: NormalizedBookmarkNode, rootKind: BrowserRootKind, depth: number,
    ancestors: readonly string[], isSpecialRoot: boolean) => {
    out.push({ node, rootKind, depth, ancestorNativeIds: ancestors, isSpecialRoot });
    for (const child of node.children) {
      visit(child, rootKind, depth + 1, [...ancestors, node.nativeId], false);
    }
  };
  for (const root of roots) {
    const special = root.rootKind === 'bookmarks_bar' || root.rootKind === 'other' || root.rootKind === 'mobile';
    visit(root, root.rootKind, 0, [], special);
  }
  return out;
}

export function countFolderContents(node: {
  readonly kind: string;
  readonly children: readonly { readonly kind: string; readonly children: readonly unknown[] }[];
}): { bookmarkCount: number; folderCount: number } {
  let bookmarkCount = 0;
  let folderCount = 0;
  for (const child of node.children) {
    if (child.kind === 'bookmark') bookmarkCount += 1;
    else if (child.kind === 'folder') {
      folderCount += 1;
      const nested = countFolderContents(child as typeof node);
      bookmarkCount += nested.bookmarkCount;
      folderCount += nested.folderCount;
    }
  }
  return { bookmarkCount, folderCount };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}
