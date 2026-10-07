import { assertValidNodeTags, CollectionAuthorizationError, CollectionPreconditionError, CollectionsError,
  generateOpaqueId, strongEntityTag } from '../domain/index.js';
import type { LockedNodeRow, ProductCollectionCanonicalPorts } from './ports.js';
import { ifMatchSatisfied } from './update-collection-metadata.js';

export interface ClassificationContentSelection { readonly folderId: string | null; readonly addTags: readonly string[] }
export interface ClassificationVocabularyPort {
  /** Called under the collection lock; only live bookmark tags belong to this vocabulary. */
  existingTags(collectionId: string, tags: readonly string[]): Promise<readonly string[]>;
}
export interface ClassificationContentResult {
  readonly nodeId: string; readonly etag: string; readonly parentId: string;
  readonly tags: readonly string[]; readonly operationIds: readonly string[];
}
export function parseClassificationTagAdditions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 3) throw new CollectionsError('invalid_node_tags', 'addTags must contain at most 3 unique existing tags.');
  return assertValidNodeTags(value);
}
export function isClassificationOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 128;
}
export function parseClassificationConfirmation(value: unknown): ClassificationContentSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'folderId') || !Object.hasOwn(raw, 'addTags')) throw invalid();
  if (raw.folderId !== null && !isClassificationOpaqueId(raw.folderId)) throw invalid();
  const addTags = parseClassificationTagAdditions(raw.addTags);
  if (raw.folderId === null && !addTags.length) throw invalid();
  return {folderId: raw.folderId, addTags};
}
function invalid() { return new CollectionsError('invalid_node_input', 'Expected folderId and addTags with at least one requested change.'); }
function notFound(): never { throw new CollectionAuthorizationError({outcome:'conceal',reasonCategory:'resource_missing'}); }

type ContentPorts = Pick<ProductCollectionCanonicalPorts, 'nodes' | 'canonical'> & {readonly vocabulary: ClassificationVocabularyPort};
type ContentInput = {readonly actor:{readonly principalId:string;readonly principalType:'account'};readonly collectionId:string;readonly nodeId:string;
  readonly ifMatch:string;readonly selection:ClassificationContentSelection};

/** Read-only validation under the caller's collection lock, shared by batch preflight. */
export async function validateClassificationContent(ports:ContentPorts,input:ContentInput) {
  const node = await ports.nodes.getNode(input.collectionId, input.nodeId);
  if (!node || node.deletedAt !== null || node.kind !== 'bookmark' || node.isRoot || node.parentId === null) notFound();
  if (!ifMatchSatisfied(input.ifMatch, node.resourceRevision)) throw new CollectionPreconditionError({currentEtag:strongEntityTag(node.resourceRevision)});
  const additions = parseClassificationTagAdditions(input.selection.addTags);
  const vocabulary = new Set(await ports.vocabulary.existingTags(input.collectionId, additions));
  if (additions.some(tag => !vocabulary.has(tag))) throw new CollectionsError('invalid_node_tags', 'addTags must belong to the current live bookmark vocabulary.');
  const tags = assertValidNodeTags([...new Set([...(node.tags ?? []), ...additions])]);
  const parentId = input.selection.folderId ?? node.parentId;
  const parent = await ports.nodes.getNode(input.collectionId, parentId);
  if (!parent || parent.deletedAt !== null || parent.kind !== 'folder' || (input.selection.folderId !== null && parent.isRoot)) notFound();
  return {node,parentId,tags};
}

/** Internal primitive: caller owns the collection lock and outer receipt/transaction. */
export async function applyClassificationContent(ports:ContentPorts,input:ContentInput):Promise<ClassificationContentResult> {
  const {node,parentId,tags}=await validateClassificationContent(ports,input);
  const operations: string[] = [];
  let current = node;
  const execute = async (action: 'move' | 'update', currentNode: LockedNodeRow) => {
    const operationId = generateOpaqueId();
    const result = await ports.canonical.execute({operationId,collectionId:input.collectionId,actor:input.actor,mutation:{
      action,target:{collectionId:input.collectionId,resourceId:input.nodeId,resourceKind:'node'},parentId,
      ...(action === 'move' ? {relativePosition:{}} : {}),expectedResourceRevision:currentNode.resourceRevision,
      fields:{kindFields:{kind:currentNode.kind,title:currentNode.title,url:currentNode.url,description:currentNode.description,
        tags:action === 'update' ? tags : currentNode.tags,visibility:currentNode.visibility},extensions:{}},
    }});
    operations.push(operationId);
    return result.allocation.resourceRevision!;
  };
  let revision = current.resourceRevision;
  if (parentId !== current.parentId) {
    revision = await execute('move', current);
    // The canonical move intentionally preserves content (including concurrent sync fixes).
    // Reload its new revision for the separate content primitive in this same transaction.
    current = (await ports.nodes.getNode(input.collectionId, input.nodeId))!;
    if (!current || current.resourceRevision !== revision) throw new Error('Canonical move did not publish its new revision.');
  }
  if (tags.length !== (current.tags ?? []).length) revision = await execute('update', current);
  return {nodeId:node.id,etag:strongEntityTag(revision),parentId,tags,operationIds:operations};
}
