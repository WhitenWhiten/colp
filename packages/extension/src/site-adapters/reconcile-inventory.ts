import type { ReconcileNode } from './reconcile-model.js';
import type { Representation, SourceFolderReservation } from './contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import { captureDeviceId } from '../sw/capture-history.js';
import { cursorPage } from '../sync-state/idb.js';
import type { SourceDatabase } from './source-db.js';
import { sourceDigest } from './source-db.js';
export function reconcileTreeDigest(root: chrome.bookmarks.BookmarkTreeNode): string {
  const rows: unknown[] = [];
  const visit = (node: chrome.bookmarks.BookmarkTreeNode, depth = 0) => {
    if (depth > 128 || rows.length >= 100000) throw new Error('capacity');
    rows.push({ id: node.id, dateAdded: node.dateAdded ?? null, title: node.title, url: node.url ?? null, parentId: node.parentId ?? null });
    for (const child of node.children ?? []) visit(child, depth + 1);
  }; visit(root); return sourceDigest(rows.sort((a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id)));
}
export interface ReconcileInventory { folders: SourceFolderReservation[]; representations: Representation[]; nodes: ReconcileNode[];
  movedFolders: { folder: SourceFolderReservation; node: ReconcileNode; withinRoot: boolean }[] }
/** Inventory preserves exact native proof and treats every other copy purpose/connection as protected. */
export async function reconcileInventory(db: SourceDatabase, connectionId: string, selected: readonly string[]): Promise<ReconcileInventory> {
  const all = await db.transaction(['representations', 'folderReservations', 'contentBindings'], 'readonly', async tx => ({
    reps: await cursorPage<Representation>(tx.objectStore('representations'), null, 100001),
    folders: await cursorPage<SourceFolderReservation>(tx.objectStore('folderReservations'), null, 10001),
    content: await cursorPage<ContentBindingRow>(tx.objectStore('contentBindings'), null, 100001),
  }));
  if (all.reps.length > 100000 || all.folders.length > 10000 || all.content.length > 100000) throw new Error('capacity');
  const representations = all.reps.filter(r => r.connectionId === connectionId && r.purpose === 'sourceArchive' && selected.includes(r.sourceCollectionId ?? ''));
  const mounts = new Set(representations.map(r => r.mountId));
  const config = await db.read<{ ruleId: string }>('meta', `archiveConfig:${connectionId}`);
  const mount = config && await db.read<{ id: string }>('mounts', JSON.stringify([connectionId, config.ruleId])); if (mount) mounts.add(mount.id);
  const folders = all.folders.filter(f => mounts.has(f.mountId) && selected.includes(f.collectionId));
  const protectedIds = new Set([...all.reps.filter(r => !representations.includes(r)).map(r => r.native.nativeId),
    ...all.content.filter(b => b.native && !b.supersededBy).map(b => b.native!.nativeId)]);
  const tree = new Map<string, chrome.bookmarks.BookmarkTreeNode>(), roots = new Set(folders.flatMap(f => f.native ? [f.native.nativeId] : []));
  const visit = (node: chrome.bookmarks.BookmarkTreeNode, depth = 0) => {
    if (depth > 128 || tree.size >= 100000) throw new Error('capacity'); tree.set(node.id, node);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  for (const f of folders) if (f.native) {
    const nodes = await chrome.bookmarks.getSubTree(f.native.nativeId).catch(() => []);
    if (nodes[0]?.dateAdded === f.native.dateAdded) visit(nodes[0]);
  }
  for (const r of representations) if (!tree.has(r.native.nativeId)) {
    const node = (await chrome.bookmarks.get(r.native.nativeId).catch(() => []))[0]; if (node) tree.set(node.id, node);
  }
  const annotations = createBookmarkAnnotationStore();
  const pins = await annotations.getMany([...tree.values()]).finally(() => annotations.close()), deviceId = await captureDeviceId();
  const hasProtected = (node: chrome.bookmarks.BookmarkTreeNode): boolean => protectedIds.has(node.id) || !!node.unmodifiable
    || !!node.children?.some(hasProtected) || representations.some(r => r.native.nativeId === node.id);
  const nodes: ReconcileNode[] = [];
  for (const node of tree.values()) {
    if (roots.has(node.id)) continue;
    nodes.push({ native: { nativeId: node.id, bindingId: `inventory:${node.id}`, deviceId, dateAdded: node.dateAdded ?? null,
      kind: node.url === undefined ? 'folder' : 'bookmark', proof: { kind: 'explicitAdoption', id: `inventory:${node.id}` } },
      title: node.title, url: node.url ?? null, parentId: node.parentId ?? '', pinned: pins.get(node.id)?.pinned === true,
      annotationRevision: pins.get(node.id)?.version ?? 0,
      ...(node.url === undefined ? { subtreeDigest: reconcileTreeDigest(node) } : {}),
      protected: protectedIds.has(node.id) || !!node.unmodifiable || !!node.children?.some(hasProtected), children: node.children?.map(child => child.id) ?? [] });
  }
  const movedFolders: ReconcileInventory['movedFolders'] = [];
  for (const folder of folders) {
    const node = folder.native && tree.get(folder.native.nativeId);
    const parent = folder.locationOverride?.nativeId ?? (folder.parent.kind === 'native' ? folder.parent.binding.nativeId : null);
    if (!node || node.parentId === parent || !folder.native) continue;
    const root = folder.parent.kind === 'native' ? folder.parent.binding.nativeId : null;
    let id = node.parentId, withinRoot = false; const seen = new Set<string>();
    while (id && !seen.has(id) && seen.size < 256) { if (id === root) { withinRoot = true; break; } seen.add(id); id = (await chrome.bookmarks.get(id))[0]?.parentId; }
    const foreign = new Set(all.reps.filter(r => r.connectionId !== connectionId || r.sourceCollectionId !== folder.collectionId || r.purpose !== 'sourceArchive').map(r => r.native.nativeId));
    const protectedTree = (n: chrome.bookmarks.BookmarkTreeNode): boolean => !!n.unmodifiable || foreign.has(n.id) || protectedIds.has(n.id) || !!n.children?.some(protectedTree);
    movedFolders.push({ folder, withinRoot, node: { native: folder.native, title: node.title, url: null, parentId: node.parentId ?? '', pinned: pins.get(node.id)?.pinned === true,
      annotationRevision: pins.get(node.id)?.version ?? 0,
      subtreeDigest: reconcileTreeDigest(node),
      protected: protectedTree(node), children: node.children?.map(c => c.id) ?? [] } });
  }
  return { folders, representations, nodes, movedFolders };
}
