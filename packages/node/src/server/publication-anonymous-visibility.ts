import { PublicationPublicProjectionError } from './publication-public-projection.js';

const nodeKinds = new Set(['root', 'folder', 'bookmark', 'separator', 'alias']);
const collectionKinds = new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']);

/** Reject restricted primary graph members before an anonymous response is cached. */
export function assertAnonymousPublicationPrimaryVisibility(input: unknown): void {
  if (isSnapshotLike(input)) assertSnapshotGraphVisibility(input);
  const pending: unknown[] = [input];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (isRestrictedPrimary(value)) throw new PublicationPublicProjectionError('malformed_input');
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        pending.push(value[index]);
      }
    } else {
      for (const child of Object.values(value)) pending.push(child);
    }
  }
}

type JsonRecord = Record<string, unknown>;

/**
 * Resolve Snapshot inheritance before the generic primary-resource walk.
 * Snapshot Nodes may omit `visibility` and inherit from their parent or the
 * Collection, so checking only an object's own field would miss a private
 * descendant nested below an otherwise public root.
 */
function assertSnapshotGraphVisibility(snapshot: JsonRecord): void {
  const collection = asRecord(snapshot.collection);
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : undefined;
  if (collection === undefined || nodes === undefined) return;
  const page = asRecord(snapshot.page);
  // A continuation page may omit the root emitted on an earlier page. The
  // first page is still checked fail-closed; every other missing ancestor or
  // relation endpoint remains unknown and is rejected below.
  const continuationPage = typeof page?.sequence === 'number' && page.sequence > 1;
  const rootNodeId = typeof collection.rootNodeId === 'string' ? collection.rootNodeId : undefined;

  const collectionRank = visibilityRank(collection.visibility);
  if (collectionRank === 2) throw new PublicationPublicProjectionError('malformed_input');

  const nodeById = new Map<string, JsonRecord>();
  for (const value of nodes) {
    const node = asRecord(value);
    if (node === undefined || typeof node.id !== 'string' || nodeById.has(node.id)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    nodeById.set(node.id, node);
  }

  const memo = new Map<string, number>();
  const resolving = new Set<string>();
  const resolveNodeRank = (node: JsonRecord | undefined, missingId?: string): number => {
    if (node === undefined || typeof node.id !== 'string') {
      // The root has no independent visibility in the wire model and may be
      // omitted from a continuation page. Every other missing ancestor is
      // unknown and therefore fails closed even on a continuation page.
      return continuationPage && missingId !== undefined && missingId === rootNodeId ? collectionRank : 2;
    }
    const cached = memo.get(node.id);
    if (cached !== undefined) return cached;
    if (resolving.has(node.id)) return 2;
    resolving.add(node.id);
    const ownRank = visibilityRank(node.visibility);
    let inheritedRank = collectionRank;
    if (node.kind !== 'root') {
      inheritedRank = typeof node.parentId === 'string'
      ? resolveNodeRank(nodeById.get(node.parentId), node.parentId)
        : 2;
    }
    const rank = Math.max(collectionRank, ownRank, inheritedRank);
    resolving.delete(node.id);
    memo.set(node.id, rank);
    return rank;
  };

  for (const node of nodeById.values()) {
    if (resolveNodeRank(node) > 0) throw new PublicationPublicProjectionError('malformed_input');
  }

  const subjectRank = (value: JsonRecord): number => {
    const subject = asRecord(value.subject);
    if (subject === undefined || typeof subject.type !== 'string' || typeof subject.id !== 'string') return 2;
    const ownerRank = subject.type === 'collection'
      // A foreign Collection's policy is unknown. Never authorize its
      // sidecars using the current Snapshot Collection's public visibility.
      ? subject.id === collection.id ? collectionRank : 2
      : subject.type === 'node'
        ? resolveNodeRank(nodeById.get(subject.id))
        : 2;
    return Math.max(ownerRank, visibilityRank(value.visibility));
  };
  for (const key of ['annotations', 'attachments'] as const) {
    const resources = Array.isArray(snapshot[key]) ? snapshot[key] : [];
    for (const resource of resources) {
      const record = asRecord(resource);
      if (record === undefined || subjectRank(record) > 0) {
        throw new PublicationPublicProjectionError('malformed_input');
      }
    }
  }
  const relations = Array.isArray(snapshot.relations) ? snapshot.relations : [];
  for (const resource of relations) {
    const relation = asRecord(resource);
    if (relation === undefined || visibilityRank(relation.visibility) > 0) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    if (resolveNodeRank(nodeById.get(String(relation.fromNodeId)), String(relation.fromNodeId)) > 0
      || resolveNodeRank(nodeById.get(String(relation.toNodeId)), String(relation.toNodeId)) > 0) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
  }
}

function isSnapshotLike(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  return isRecord(value.collection)
    && Array.isArray(value.nodes)
    && Array.isArray(value.annotations)
    && Array.isArray(value.attachments)
    && Array.isArray(value.relations)
    && isRecord(value.page);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function visibilityRank(value: unknown): number {
  return value === 'private' ? 2 : value === 'protected' ? 1 : 0;
}

function isRestrictedPrimary(value: object): boolean {
  const visibility = ownString(value, 'visibility');
  if (visibility !== 'protected' && visibility !== 'private') return false;
  const kind = ownString(value, 'kind');
  const node = kind !== undefined && nodeKinds.has(kind) && has(value, 'id') && has(value, 'collectionId');
  const collection = kind !== undefined && collectionKinds.has(kind) && has(value, 'id') && has(value, 'rootNodeId');
  const directoryCollection = kind !== undefined && collectionKinds.has(kind)
    && has(value, 'id') && has(value, 'canonicalUrl') && has(value, 'links') && has(value, 'nodeCount');
  const relation = has(value, 'fromNodeId') && has(value, 'toNodeId') && has(value, 'collectionId') && has(value, 'type');
  return node || collection || directoryCollection || relation;
}

function ownString(value: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new PublicationPublicProjectionError('malformed_input');
  return typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

function has(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return false;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new PublicationPublicProjectionError('malformed_input');
  return true;
}
