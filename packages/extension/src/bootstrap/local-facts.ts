import { scanBoundary } from '../bookmark-boundary.js';
import { folderRoleForBrowserRoot, type NormalizedBookmarkNode, type NormalizedBookmarkRoot } from '../chrome-bookmark-tree.js';
import type { BookmarkEventRecord } from '../sync-state/types.js';
import type { LocalNodeFact } from './matcher.js';
import { browserRoleOwners, type ExistingBrowserMount } from '../browser-root-identity.js';

export function localFactsFromRoots(roots: readonly NormalizedBookmarkRoot[],
  selectedNativeIds: readonly string[], excludedNativeIds: readonly string[] = [],
  privateNativeIds: readonly string[] = [], existingMounts: readonly ExistingBrowserMount[] = []): LocalNodeFact[] {
  const scan = scanBoundary({ roots, selectedNativeIds, excludedNativeIds, privateNativeIds, existingMounts });
  const roleOwners = browserRoleOwners(roots, existingMounts);
  const selected = new Set(scan.selectedNativeIds);
  const structural = new Set<string>();
  const findAncestors = (node: NormalizedBookmarkNode, ancestors: readonly string[]) => {
    if (selected.has(node.nativeId) && ['ordinary-folder', 'special-root'].includes(scan.classifications.get(node.nativeId) ?? '')) {
      for (const id of ancestors) structural.add(id);
    }
    for (const child of node.children) findAncestors(child, [...ancestors, node.nativeId]);
  };
  for (const root of roots) findAncestors(root, []);
  const facts: LocalNodeFact[] = [];
  const visit = (node: NormalizedBookmarkNode, ancestors: readonly string[], root: NormalizedBookmarkRoot) => {
    const classification = scan.classifications.get(node.nativeId);
    if (node.managed || classification === 'private-local' || classification === 'unsupported') return;
    const included = classification === 'ordinary-folder' || classification === 'special-root';
    const structureOnly = !included && structural.has(node.nativeId) && node.kind === 'folder';
    const rootRole = node.nativeId === root.nativeId ? folderRoleForBrowserRoot(root.rootKind, root.managed) : undefined;
    if ((included || structureOnly) && (ancestors.length > 0 || structureOnly)) facts.push({ nativeId: node.nativeId,
      mountNativeRootId: [...ancestors, node.nativeId].find(id => selected.has(id)) ?? root.nativeId,
      parentNativeId: ancestors.at(-1) ?? null, kind: node.kind, title: node.title,
      ...(node.url ? { url: node.url } : {}), ...(structureOnly ? { structureOnly: true } : {}),
      ...(rootRole && roleOwners.get(rootRole) === node.nativeId ? { folderRole: rootRole } : {}) });
    for (const child of node.children) visit(child, [...ancestors, node.nativeId], root);
  };
  for (const root of roots) {
    // A second browser root is an independent custom container, even when empty.
    if (selected.has(root.nativeId) && scan.mounts.some(row => row.nativeRootId === root.nativeId
      && row.customSourceKey && !row.materialized)) {
      facts.push({ nativeId: root.nativeId, mountNativeRootId: root.nativeId, parentNativeId: null,
        kind: 'folder', title: root.title });
    }
    visit(root, [], root);
  }
  return facts;
}

export function applyInboxToFacts(facts: readonly LocalNodeFact[],
  events: readonly BookmarkEventRecord[]): LocalNodeFact[] {
  const byId = new Map(facts.map((row) => [row.nativeId, { ...row }]));
  for (const event of [...events].sort((left, right) => left.ordinal - right.ordinal)) {
    if (event.status === 'processed') continue;
    const details = event.details;
    const title = typeof details.title === 'string' ? details.title : undefined;
    const url = typeof details.url === 'string' ? details.url : undefined;
    const parentNativeId = typeof details.parentNativeId === 'string' ? details.parentNativeId : null;
    const mountNativeRootId = typeof details.mountNativeRootId === 'string' ? details.mountNativeRootId : undefined;
    const kind = details.kind === 'folder' || details.kind === 'separator' ? details.kind : 'bookmark';
    if (event.kind === 'remove') { byId.delete(event.nativeId); continue; }
    const prior = byId.get(event.nativeId);
    if (event.kind === 'create' && !prior) {
      const mount = mountNativeRootId ?? parentNativeId ?? event.nativeId;
      byId.set(event.nativeId, {
        nativeId: event.nativeId, mountNativeRootId: mount, parentNativeId, kind, title: title ?? '',
        ...(url ? { url } : {}),
      });
      continue;
    }
    if (!prior) continue;
    if (event.kind === 'change') {
      byId.set(event.nativeId, { ...prior, ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }) });
    }
    if (event.kind === 'move') {
      byId.set(event.nativeId, { ...prior, parentNativeId,
        ...(mountNativeRootId ? { mountNativeRootId } : {}) });
    }
  }
  return [...byId.values()];
}
