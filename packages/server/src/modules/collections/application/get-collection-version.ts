import {
  CollectionVersionNotFoundError,
  diffCollectionTree,
  truncateCollectionVersionChanges,
  type CollectionVersionStorePort,
} from './capture-collection-tree-version.js';
import { toCollectionVersionDto, type CollectionVersionDto } from './create-collection-version.js';

const OPAQUE_ID = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface GetCollectionVersionPorts {
  readonly versions: CollectionVersionStorePort;
}

export interface GetCollectionVersionInput {
  readonly actor: { readonly principalId: string; readonly subjectId: string };
  readonly collectionId: string;
  readonly versionId: string;
}

export async function getCollectionVersion(
  ports: GetCollectionVersionPorts,
  input: GetCollectionVersionInput,
): Promise<CollectionVersionDto> {
  if (typeof input.actor?.principalId !== 'string' || input.actor.principalId.length < 1
    || typeof input.actor.subjectId !== 'string' || input.actor.subjectId.length < 1) {
    throw new CollectionVersionNotFoundError();
  }
  if (typeof input.collectionId !== 'string' || !OPAQUE_ID.test(input.collectionId)
    || typeof input.versionId !== 'string' || !OPAQUE_ID.test(input.versionId)) {
    throw new CollectionVersionNotFoundError();
  }
  const collection = await ports.versions.getOwnedLive(input.collectionId, input.actor.subjectId);
  if (!collection) throw new CollectionVersionNotFoundError();
  const record = await ports.versions.getById(
    input.actor.principalId,
    input.collectionId,
    input.versionId,
  );
  if (!record) throw new CollectionVersionNotFoundError();
  const live = await ports.versions.loadLiveMembers(input.collectionId);
  const { changes, changeCounts } = diffCollectionTree(record.treeJson, live);
  const truncated = truncateCollectionVersionChanges(changes);
  return toCollectionVersionDto(record, changeCounts, {
    changes: truncated.changes,
    truncated: truncated.truncated,
  });
}
