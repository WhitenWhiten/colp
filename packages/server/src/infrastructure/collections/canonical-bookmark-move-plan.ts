import {
  allocatePosition, CanonicalMutationInvariantError, createCanonicalMutationApplication,
  generateRevisionToken, materializeCollectionPayload, materializeNodePayload,
  type CanonicalMutationInput, type CanonicalMutationResult, type CanonicalDomainEvent,
  type CanonicalOperationRecord, type CanonicalMutationPorts,
} from '../../modules/collections/index.js';
import {
  assertExistingNodeAuthority, assertExistingCollectionAuthority, assertMaterialized,
  collectionProjection, nodeProjection, type CollectionRow, type NodeRow,
} from './canonical-mutation-postgres-ports.js';
import { existingExtensions, existingNodePayloadFields } from './canonical-mutation-payload-fields.js';

export class BookmarkMoveBatchFallback extends Error {}

interface MoveFacts { before: NodeRow; sourceAncestors: readonly NodeRow[]; targetAncestors: readonly NodeRow[] }
export interface PlannedBookmarkMove {
  input: CanonicalMutationInput;
  result: CanonicalMutationResult;
  event: CanonicalDomainEvent<MoveFacts>;
  operation: CanonicalOperationRecord<MoveFacts>;
  after: NodeRow;
}
export interface BookmarkMovePlan {
  collection: CollectionRow;
  changed: NodeRow[];
  moves: PlannedBookmarkMove[];
}
function invalid(message: string): never { throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message); }
const payloadFor = (row: NodeRow) => assertMaterialized('node', row.id, materializeNodePayload(nodeProjection(row)),
  existingExtensions(row.payload_json), existingNodePayloadFields(row.payload_json));

/** A bounded, transaction-local plan for distinct bookmark moves. No database writes.
 * Every member still passes through the canonical application's validation and
 * ordinal allocation contract. Folder moves and rebalances use the regular adapter.
 */
export async function planBookmarkMoves(original: CollectionRow, rows: readonly NodeRow[],
  inputs: readonly CanonicalMutationInput[], now: Date): Promise<BookmarkMovePlan> {
  let collection = { ...original };
  assertExistingCollectionAuthority(collection);
  const nodes = new Map(rows.map(row => [row.id, row]));
  const changed = new Map<string, NodeRow>();
  const paths = new Map<string, NodeRow[]>();
  const path = (id: string) => {
    let result = paths.get(id);
    if (result) return result;
    result = [];
    let next: string | null = id;
    const seen = new Set<string>();
    while (next !== null) {
      const row = nodes.get(next);
      if (!row || row.deleted_at || row.kind !== 'folder' || seen.has(next) || result.length === 256)
        throw new BookmarkMoveBatchFallback('bookmark batch requires complete live folder ancestry');
      seen.add(next); result.push(row); next = row.parent_id;
    }
    paths.set(id, result);
    return result;
  };
  const siblings = new Map<string, NodeRow[]>();
  for (const row of rows) if (row.parent_id && !row.deleted_at) {
    const list = siblings.get(row.parent_id) ?? []; list.push(row); siblings.set(row.parent_id, list);
  }
  for (const list of siblings.values()) list.sort((a, b) => (a.position_token! < b.position_token! ? -1 : 1));
  let operation: CanonicalOperationRecord<MoveFacts> | undefined;
  let event: CanonicalDomainEvent<MoveFacts> | undefined;
  const ports: CanonicalMutationPorts<void, MoveFacts> = {
    collectionLock: { async lockForCanonicalMutation() { return { collectionId: collection.id,
      currentCommitOrdinal: BigInt(collection.commit_ordinal), resourceRevision: collection.resource_revision,
      contentRevision: collection.content_revision, policyRevision: collection.policy_revision }; } },
    planner: { async planCanonicalMutation(_, input) {
      const m = input.mutation, node = nodes.get(m.target.resourceId);
      if (input.collectionId !== collection.id || m.action !== 'move' || m.target.resourceKind !== 'node'
        || !node || node.kind !== 'bookmark' || node.deleted_at || node.is_root || !m.parentId
        || node.parent_id === m.parentId || node.resource_revision !== m.expectedResourceRevision || m.relativePosition)
        invalid('bookmark batch member changed or is not a distinct cross-folder move');
      const extensions = assertExistingNodeAuthority(node);
      const childrenOf = [node.parent_id!, m.parentId];
      for (const id of childrenOf) assertExistingNodeAuthority(path(id)[0]!);
      return { operationId: input.operationId, collectionId: collection.id,
        facts: { before: node, sourceAncestors: path(node.parent_id!), targetAncestors: path(m.parentId) },
        mutation: { ...m, fields: { extensions, kindFields: { kind: node.kind, title: node.title, url: node.url,
          description: node.description, tags: (node.tags ?? []) as readonly string[], visibility: node.visibility } },
          revisionEffects: { resource: true, content: true, policy: false, childrenOf } } };
    } },
    allocator: { async allocate(_, request) {
      const list = siblings.get(request.mutation.parentId!) ?? [];
      const last = list.at(-1)?.position_token ?? null;
      return { commitOrdinal: request.collection.currentCommitOrdinal + 1n,
        resourceRevision: generateRevisionToken(), contentRevision: generateRevisionToken(),
        childrenRevisions: Object.fromEntries(request.mutation.revisionEffects.childrenOf.map(id => [id, generateRevisionToken()])),
        positionToken: allocatePosition(last, null, last ? [last] : []) };
    } },
    resources: { async applyCanonicalMutation(_, write) {
      const before = nodes.get(write.mutation.target.resourceId)!, a = write.allocation;
      const after: NodeRow = { ...before, parent_id: write.mutation.parentId, position_token: a.positionToken!,
        resource_revision: a.resourceRevision!, updated_at: now };
      after.payload_json = payloadFor(after);
      nodes.set(after.id, after); changed.set(after.id, after);
      siblings.set(before.parent_id!, (siblings.get(before.parent_id!) ?? []).filter(row => row.id !== before.id));
      const target = siblings.get(after.parent_id!) ?? []; target.push(after); siblings.set(after.parent_id!, target);
      for (const [id, revision] of Object.entries(a.childrenRevisions)) {
        const parent = { ...nodes.get(id)!, children_revision: revision, updated_at: now };
        parent.payload_json = payloadFor(parent); nodes.set(id, parent); changed.set(id, parent);
      }
      collection = { ...collection, commit_ordinal: a.commitOrdinal, content_revision: a.contentRevision!, updated_at: now };
      collection.payload_json = assertMaterialized('collection', collection.id,
        materializeCollectionPayload(collectionProjection(collection)), existingExtensions(collection.payload_json));
    } },
    operations: { async appendCanonicalOperation(_, record) { operation = record; } },
    audit: { async appendAuditEvent() { /* Flushed with the operation's identical canonical payload. */ } },
    facts: { async capture() { /* Pinned in the plan before any move. */ } },
    outbox: { async appendDomainEvents(_, events) { event = events[0]; } },
  };
  const app = createCanonicalMutationApplication(ports), moves: PlannedBookmarkMove[] = [];
  for (const input of inputs) {
    const result = await app.execute({ transaction: undefined }, input);
    moves.push({ input, result, event: event!, operation: operation!, after: nodes.get(input.mutation.target.resourceId)! });
  }
  return { collection, changed: [...changed.values()], moves };
}
