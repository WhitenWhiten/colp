import { createHash } from 'node:crypto';
import { authorizeCapability, type MembershipRole } from '../../access-policy/index.js';
import { EditorAuthorizationError } from '../domain/index.js';
import type { EditorCollectionRow, GetCollectionEditorPageInput, GetCollectionEditorPagePorts } from './get-editor-page.js';

/** Both a page and a version probe must check current access under the collection lock. */
export async function authorizeEditorRead(ports: GetCollectionEditorPagePorts, input: GetCollectionEditorPageInput) {
  const collection = await ports.collections.lockForShare(input.collectionId);
  if (!collection || collection.deletedAt !== null) {
    throw new EditorAuthorizationError({ outcome: 'conceal', reasonCategory: 'resource_missing' });
  }
  const decision = await authorizeCapability(ports.accessPolicy, {
    collectionId: input.collectionId,
    actor: { ...input.actor, kind: 'account' },
    capability: 'read_editor',
  });
  if (decision.outcome !== 'allow') {
    throw new EditorAuthorizationError({ outcome: decision.outcome, reasonCategory: decision.reasonCategory });
  }
  return { collection, role: decision.effectiveRole };
}

export function editorReadRevision(
  collection: Pick<EditorCollectionRow, 'id' | 'resourceRevision' | 'contentRevision' | 'policyRevision' | 'isLibrary'>,
  role: MembershipRole | null,
  projectionRevision: string,
  productOrigin?: string,
): string {
  return createHash('sha256').update(JSON.stringify([
    'editor-read-v1', collection.id, collection.resourceRevision, collection.contentRevision,
    collection.policyRevision, collection.isLibrary === true, role, productOrigin ?? null, projectionRevision,
  ])).digest('hex');
}

/** No node payloads, cursor creation, pagination or response serialization on a version probe. */
export async function getCollectionEditorReadRevision(
  ports: GetCollectionEditorPagePorts,
  input: GetCollectionEditorPageInput,
): Promise<string | undefined> {
  const { collection, role } = await authorizeEditorRead(ports, input);
  if (!ports.loadSnapshot.loadProjectionRevision) return undefined;
  const projection = await ports.loadSnapshot.loadProjectionRevision(input.collectionId);
  return editorReadRevision(collection, role, projection, ports.productOrigin);
}
