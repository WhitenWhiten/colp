import { PublicationPublicProjectionError } from './publication-public-projection.js';

const nodeKinds = new Set(['root', 'folder', 'bookmark', 'separator', 'alias']);
const collectionKinds = new Set(['bookmarks', 'reading_path', 'knowledge_collection', 'mixed']);
const MAX_VISIBILITY_ANCESTRY = 100_000;
const MAX_VISIBILITY_GRAPH_NODES = 1_000_000;

/** Reject restricted primary graph members before an anonymous response is cached. */
export function assertAnonymousPublicationPrimaryVisibility(input: unknown): void {
  const snapshotInput = isSnapshotLike(input);
  if (snapshotInput) assertSnapshotGraphVisibility(input);
  // A standalone Node Detail can omit visibility and inherit it from an
  // authoritative Collection/parent chain.  This boundary has no resolver
  // context with which to prove that inheritance is public, so fail closed.
  if (!isSnapshotLike(input) && isInheritedNodeDetail(input)) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  const pending: unknown[] = [input];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (visited > MAX_VISIBILITY_GRAPH_NODES) {
      throw new PublicationPublicProjectionError('projection_limit_exceeded');
    }
    // Redaction is a safe publication placeholder only for a Bookmark. It
    // may appear in an otherwise public Collection without its target URL,
    // while a restricted Collection remains ineligible for anonymous output.
    // Other node kinds are authoritative graph members and cannot use the
    // redacted placeholder to bypass their own visibility policy.
    if (isRestrictedPrimary(value)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    // A standalone Node Detail often wraps the node under `node`.  Without a
    // snapshot resolver, an omitted/inherited visibility value cannot be
    // proven public.  Apply the same fail-closed rule at every nested object,
    // while allowing Snapshot nodes because the graph resolver above has
    // already resolved their inherited policy.
    if (!isSnapshotLike(input) && isInheritedNodeDetail(value)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    // Source-reference carriers are permitted inside an explicitly audited
    // public extension after projection.  They remain forbidden on primary
    // Node/Collection/Relation resources, where replica and hierarchy metadata
    // can disclose private topology.
    if (isPrimaryResource(value) && Object.hasOwn(value, 'sourceRefs')) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
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

  const nodeById = new Map<string, JsonRecord>();
  for (const value of nodes) {
    const node = asRecord(value);
    if (node === undefined || typeof node.id !== 'string' || nodeById.has(node.id)) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
    nodeById.set(node.id, node);
  }
  const collectionRank = visibilityRank(collection.visibility);
  // The anonymous boundary cannot distinguish a fully redacted private
  // snapshot from a private collection whose metadata remains visible.  The
  // collection itself is therefore always required to be public; redaction
  // can only relax checks for already-public collections.
  if (collectionRank > 0) {
    throw new PublicationPublicProjectionError('malformed_input');
  }
  const effectiveCollectionRank = collectionRank;

  const memo = new Map<string, number>();
  const resolveNodeRank = (node: JsonRecord | undefined, missingId?: string): number => {
    const trail: string[] = [];
    const trailSet = new Set<string>();
    let current = node;
    let absentId = missingId;
    let rank = effectiveCollectionRank;
    for (let step = 0; step <= MAX_VISIBILITY_ANCESTRY; step += 1) {
      if (current === undefined || typeof current.id !== 'string') {
        // The root has no independent visibility in the wire model and may be
        // omitted from a continuation page. Every other missing ancestor is
        // unknown and therefore fails closed even on a continuation page.
        rank = Math.max(rank, continuationPage && absentId !== undefined && absentId === rootNodeId
          ? effectiveCollectionRank : 2);
        break;
      }
      const cached = memo.get(current.id);
      if (cached !== undefined) {
        rank = Math.max(rank, cached);
        break;
      }
      if (trailSet.has(current.id)) {
        rank = 2;
        break;
      }
      trail.push(current.id);
      trailSet.add(current.id);
      // A redacted Bookmark is a safe publication placeholder: its target
      // content is intentionally omitted and its own restricted visibility
      // does not make an otherwise public Collection disappear. Ancestors
      // and every other node kind still retain their effective policy.
      rank = Math.max(rank, current.redacted === true && current.kind === 'bookmark'
        ? 0
        : visibilityRank(current.visibility));
      if (current.kind === 'root') break;
      absentId = typeof current.parentId === 'string' ? current.parentId : undefined;
      current = absentId === undefined ? undefined : nodeById.get(absentId);
    }
    if (trail.length > MAX_VISIBILITY_ANCESTRY) rank = 2;
    for (const id of trail) memo.set(id, rank);
    return rank;
  };

  for (const node of nodeById.values()) {
    if (resolveNodeRank(node) > 0) throw new PublicationPublicProjectionError('malformed_input');
    if (typeof node.targetNodeId === 'string'
      && resolveNodeRank(nodeById.get(node.targetNodeId), node.targetNodeId) > 0) {
      throw new PublicationPublicProjectionError('malformed_input');
    }
  }

  const subjectRank = (value: JsonRecord): number => {
    const subject = asRecord(value.subject);
    if (subject === undefined || typeof subject.type !== 'string' || typeof subject.id !== 'string') return 2;
    const ownerRank = subject.type === 'collection'
      // A foreign Collection's policy is unknown. Never authorize its
      // sidecars using the current Snapshot Collection's public visibility.
      ? subject.id === collection.id ? effectiveCollectionRank : 2
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
      const provenance = asRecord(record.provenance);
      const sourceNodeIds = provenance?.sourceNodeIds;
      if (Array.isArray(sourceNodeIds)) {
        for (const nodeId of sourceNodeIds) {
          if (typeof nodeId !== 'string'
            || resolveNodeRank(nodeById.get(nodeId), nodeId) > 0) {
            throw new PublicationPublicProjectionError('malformed_input');
          }
        }
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
  if (visibility !== 'protected' && visibility !== 'private' && visibility !== 'unlisted') return false;
  const kind = ownString(value, 'kind');
  const redactedBookmark = kind === 'bookmark' && ownBoolean(value, 'redacted') === true;
  const node = kind !== undefined && nodeKinds.has(kind) && has(value, 'id') && has(value, 'collectionId')
    && !redactedBookmark;
  const collection = kind !== undefined && collectionKinds.has(kind) && has(value, 'id') && has(value, 'rootNodeId');
  const directoryCollection = kind !== undefined && collectionKinds.has(kind)
    && has(value, 'id') && has(value, 'canonicalUrl') && has(value, 'links') && has(value, 'nodeCount');
  const relation = has(value, 'fromNodeId') && has(value, 'toNodeId') && has(value, 'collectionId') && has(value, 'type');
  return node || collection || directoryCollection || relation;
}

function ownBoolean(value: object, key: string): boolean | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) throw new PublicationPublicProjectionError('malformed_input');
  return typeof descriptor.value === 'boolean' ? descriptor.value : undefined;
}

function isPrimaryResource(value: object): boolean {
  const kind = ownString(value, 'kind');
  const node = kind !== undefined && nodeKinds.has(kind) && has(value, 'id') && has(value, 'collectionId');
  const collection = kind !== undefined && collectionKinds.has(kind) && has(value, 'id') && has(value, 'rootNodeId');
  const relation = has(value, 'fromNodeId') && has(value, 'toNodeId') && has(value, 'collectionId') && has(value, 'type');
  return node || collection || relation;
}

function isInheritedNodeDetail(value: unknown): boolean {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const kind = ownString(value, 'kind');
  if (kind === undefined || !nodeKinds.has(kind)) return false;
  const id = Object.getOwnPropertyDescriptor(value, 'id');
  const collectionId = Object.getOwnPropertyDescriptor(value, 'collectionId');
  if (id === undefined || collectionId === undefined) return false;
  const visibility = Object.getOwnPropertyDescriptor(value, 'visibility');
  return visibility === undefined
    || !visibility.enumerable
    || !('value' in visibility)
    || visibility.value === 'inherit';
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
