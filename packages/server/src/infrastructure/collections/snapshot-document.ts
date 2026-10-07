import type { Collection, Extensions, SnapshotNode } from '@know-n/colp/types';
import { SNAPSHOT_MATERIALIZATION_EXTENSION, snapshotMaterializationExtensionValue } from '../../modules/collections/index.js';
import type { FolderRole } from '@know-n/colp/types';

export interface SnapshotCollectionRow {
  id: string; kind: Collection['kind']; title: string; summary: string | null;
  visibility: Collection['visibility']; root_node_id: string; content_revision: string;
  created_at: Date; updated_at: Date; payload_json: Record<string, unknown> | null;
}
export interface SnapshotNodeRow {
  id: string; collection_id: string; parent_id: string | null; kind: 'folder' | 'bookmark' | 'separator';
  is_root: boolean; title: string | null; url: string | null; position_token: string | null;
  visibility: 'inherit' | 'protected' | 'private';
  resource_revision: string; children_revision: string | null;
  created_at: Date; updated_at: Date; payload_json: Record<string, unknown> | null;
}
export function mapSnapshotCollection(row: SnapshotCollectionRow): Collection {
  const extensionValue = row.payload_json?.extensions;
  const extensions = mapExtensions(extensionValue);
  return { schemaVersion: '0.1', id: row.id, kind: row.kind, title: row.title, ...(row.summary ? { summary: row.summary } : {}),
    rootNodeId: row.root_node_id, visibility: row.visibility, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), revision: row.content_revision, extensions };
}

export function mapSnapshotNode(row: SnapshotNodeRow): SnapshotNode {
  const payload = row.payload_json ?? {}; const folderRole = mapSnapshotFolderRole(payload, row.kind, row.is_root);
  const common = { id: row.id, collectionId: row.collection_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    revision: row.resource_revision,
    ...(typeof payload.description === 'string' ? { description: payload.description } : {}),
    ...(Array.isArray(payload.tags) ? { tags: payload.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
    ...(payload.extensions === undefined ? {} : { extensions: mapExtensions(payload.extensions) }) };
  if (row.is_root) return { ...common, kind: 'root', parentId: null, position: null, folderRole: 'root', title: row.title! };
  const ordered = { ...common, parentId: row.parent_id!, position: row.position_token!,
    visibility: row.visibility };
  if (row.kind === 'folder') return { ...ordered, kind: 'folder',
    ...(folderRole ? { folderRole } : {}), title: row.title! };
  if (row.kind === 'separator') return { ...ordered, kind: 'separator' };
  return { ...ordered, kind: 'bookmark', title: row.title!, url: row.url! };
}

function mapExtensions(value: unknown): Extensions {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Canonical extension sidecar is not an object');
  }
  return structuredClone(value) as Extensions;
}

export function withSnapshotBinding(collection: Collection, mode: 'whole-profile' | 'mounted-folder', rootNodeId: string): Collection {
  return { ...collection, extensions: {
    ...(collection.extensions ?? {}),
    'https://known.example/extensions/sync-binding': { mode, rootNodeId },
    [SNAPSHOT_MATERIALIZATION_EXTENSION]: snapshotMaterializationExtensionValue(),
  } };
}

export function snapshotParentRevisions(rows: readonly SnapshotNodeRow[]) {
  return rows.filter(node => node.is_root || node.kind === 'folder').map(node => {
    if (!node.children_revision) throw new Error('Canonical parent has no children revision authority');
    return { parentId: node.id, childrenRevision: node.children_revision };
  });
}

export class SnapshotDocumentError extends Error {}

const COLP_FOLDER_ROLES: ReadonlySet<string> = new Set([
  'root', 'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks', 'managed-bookmarks',
  'archive', 'inbox', 'recovered', 'custom',
]);

/** Maps the persisted Folder role without allowing malformed payload data to disappear. */
export function mapSnapshotFolderRole(
  payload: Record<string, unknown>, kind: 'folder' | 'bookmark' | 'separator', isRoot: boolean,
): Exclude<FolderRole, 'root'> | undefined {
  const value = payload.folderRole;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !COLP_FOLDER_ROLES.has(value) || kind !== 'folder'
      || (isRoot ? value !== 'root' : value === 'root')) {
    throw new SnapshotDocumentError('node_folder_role');
  }
  return isRoot ? undefined : value as Exclude<FolderRole, 'root'>;
}
