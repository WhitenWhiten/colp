import { generateOpaqueId } from '../../modules/identity/index.js';
import type { ClassificationContentResult, ProductCollectionCanonicalPorts } from '../../modules/collections/index.js';
import { CaptureError } from '../../modules/collections/index.js';

/** Restore only this operation's original content under its exact application revision. */
export async function mutateCaptureContent(ports: ProductCollectionCanonicalPorts, input: {
  readonly collectionId: string; readonly nodeId: string; readonly parentId: string; readonly tags: readonly string[];
  readonly principalId: string; readonly ifMatch: string;
}): Promise<ClassificationContentResult> {
  let node = await ports.nodes.getNode(input.collectionId, input.nodeId);
  if (!node || node.deletedAt || node.kind !== 'bookmark') throw new CaptureError('resource_not_found');
  if (`"${node.resourceRevision}"` !== input.ifMatch) throw new CaptureError('precondition_failed');
  const parent = await ports.nodes.getNode(input.collectionId, input.parentId);
  if (!parent || parent.deletedAt || parent.kind !== 'folder') throw new CaptureError('resource_not_found');
  const operationIds: string[] = [];
  for (const action of ['move', 'update'] as const) {
    if (action === 'move' && node.parentId === input.parentId) continue;
    if (action === 'update' && JSON.stringify(node.tags ?? []) === JSON.stringify(input.tags)) continue;
    const operationId = generateOpaqueId();
    await ports.canonical.execute({ operationId, collectionId: input.collectionId, actor: { principalId: input.principalId, principalType: 'account' },
      mutation: { action, target: { collectionId: input.collectionId, resourceId: input.nodeId, resourceKind: 'node' },
        parentId: input.parentId, ...(action === 'move' ? { relativePosition: {} } : {}), expectedResourceRevision: node.resourceRevision,
        fields: { kindFields: { kind: 'bookmark', title: node.title, url: node.url, description: node.description,
          tags: action === 'update' ? input.tags : node.tags, visibility: node.visibility }, extensions: {} } } });
    operationIds.push(operationId);
    node = (await ports.nodes.getNode(input.collectionId, input.nodeId))!;
  }
  return { nodeId: input.nodeId, parentId: input.parentId, tags: input.tags, etag: `"${node.resourceRevision}"`, operationIds };
}
