import type { JsonObject, MappingInput } from './sync-state-store.js';
import type { PullNode } from './pull-applier-types.js';
import { digest, plainJson } from './pull-codec.js';

export function nodeContent(node: PullNode): JsonObject {
  if (node.kind === 'root' || node.kind === 'alias') throw new Error('pull_node_kind_invalid');
  return node.kind === 'separator' ? {} : node.kind === 'bookmark'
    ? { title: node.title, url: node.url ?? '' } : { title: node.title };
}

export function projectionContent(node: PullNode): JsonObject {
  const extensions = node.extensions ?? {};
  const folderRole = node.kind === 'folder' && 'folderRole' in node
    && typeof (node as { readonly folderRole?: unknown }).folderRole === 'string'
    ? (node as { readonly folderRole: string }).folderRole : undefined;
  return { ...nodeContent(node),
    ...(folderRole ? { folderRole } : {}),
    ...(node.visibility && node.visibility !== 'private' ? { visibility: node.visibility } : {}),
    ...(Object.keys(extensions).length ? { extensions: plainJson(extensions) } : {}),
    ...(node.kind === 'folder' || node.description ? { description: node.description ?? null } : {}),
    ...(node.kind === 'bookmark' || node.tags?.length ? { tags: [...node.tags ?? []] } : {}) };
}

export function nativeContent(content: JsonObject): JsonObject {
  return { ...(typeof content.title === 'string' ? { title: content.title } : {}),
    ...(typeof content.url === 'string' ? { url: content.url } : {}) };
}

export function nodeCreate(node: PullNode): JsonObject {
  if (node.kind === 'root' || node.kind === 'alias') throw new Error('pull_node_kind_invalid');
  return { kind: node.kind, ...nodeContent(node) };
}

export function chromeCreate(node: PullNode) {
  if (node.kind === 'root' || node.kind === 'alias' || node.kind === 'separator') {
    throw new Error('pull_node_kind_invalid');
  }
  return node.kind === 'bookmark' ? { title: node.title, url: node.url ?? '' } : { title: node.title };
}

export function mappingFor(node: PullNode, nativeId: string, parentNativeId: string | null,
  parentColpId: string | null, childrenRevision: string | null, rootNativeId: string): MappingInput {
  if (node.kind === 'root' || node.kind === 'alias') throw new Error('pull_node_kind_invalid');
  return { nativeId, colpId: node.id, rootNativeId,
    nodeKind: node.kind, ...(parentNativeId ? { parentNativeId } : {}), ...(parentColpId ? { parentColpId } : {}),
    projection: { revision: node.revision, resourceRevision: node.revision, childrenRevision,
      digest: digest(nodeContent(node)), contentDigest: digest(projectionContent(node)),
      content: projectionContent(node) } };
}
