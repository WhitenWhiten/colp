import { readClassificationHostnameEvidence } from './classification-evidence-postgres.js';
import { readClassificationProfileBinding } from './classification-profile-provider.js';
import { sql, type Kysely } from 'kysely';
import {
  admitSnapshotTreeGrowth, estimateSnapshotNodeBytes, SNAPSHOT_TREE_CAPACITY,
  assertValidNodeTags, isAcceptedBookmarkUrl,
  type ClassificationTaxonomyReadPort, type ClassificationTaxonomySnapshot,
  ClassificationError, buildClassificationTaxonomy, addClassificationFolderExamples,
} from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type UnitOfWorkOptions, type DatabaseTransaction } from '../database/unit-of-work.js';
import { createPostgresClassificationSettingsStore } from './classification-settings-postgres.js';

export interface ClassificationTaxonomyReadOptions {
  readonly priorEnabled?:boolean;
  readonly signal?: AbortSignal;
  readonly cancelBackend?: UnitOfWorkOptions['cancelBackend'];
  /** Test-only interleaving seam; no provider or other side effects in this transaction. */
  readonly faultInjector?: { afterCollectionRead(): Promise<void> };
}

export function createPostgresClassificationTaxonomyReadPort(db: Kysely<DatabaseSchema>, options: ClassificationTaxonomyReadOptions = {}): ClassificationTaxonomyReadPort {
  const unit = createUnitOfWork(db, { isolationLevel: 'repeatable read', signal:options.signal,cancelBackend:options.cancelBackend });
  return {
    loadSnapshot(input) {
      return unit.execute(async ({ transaction }) => {
        await sql`SET TRANSACTION READ ONLY`.execute(transaction);
        return (await readClassificationTree(transaction,input,options))?.snapshot ?? null;
      });
    },
  };
}

export async function readClassificationTree(transaction:DatabaseTransaction,
  input:Parameters<ClassificationTaxonomyReadPort['loadSnapshot']>[0],options:ClassificationTaxonomyReadOptions={}) {
  const collection = await transaction.selectFrom('collections')
    .select(['id', 'title', 'summary', 'root_node_id', 'content_revision'])
    .where('id', '=', input.collectionId).where('owner_subject_id', '=', input.ownerSubjectId)
    .where('deleted_at', 'is', null).executeTakeFirst();
  if (!collection) return null;
  const settings = await createPostgresClassificationSettingsStore(transaction).loadOwned(input);
  if (!settings) return null;
  const providerBinding=settings.providerProfileId===null?undefined:await readClassificationProfileBinding(transaction,settings.providerProfileId,input.ownerSubjectId);
  await options.faultInjector?.afterCollectionRead();
  const nodes = await transaction.selectFrom('nodes')
    .select(['id', 'parent_id', 'kind', 'is_root', 'title', 'url', 'description', 'tags', 'resource_revision', 'created_at', 'payload_json'])
    .where('collection_id', '=', collection.id).where('deleted_at', 'is', null)
    .orderBy(sql`id COLLATE "C"`).limit(SNAPSHOT_TREE_CAPACITY.maxNodes + 1).execute();
  // LIMIT is only an overflow sentinel, never a silently truncated taxonomy.
  admitSnapshotTreeGrowth({ liveNodeCount: nodes.length, extraNodes: 0, liveEstimatedBytes: 0, extraBytes: 0 });
  let bytes = 0;
  const parsed = nodes.map(node => {
    const storedTags = node.tags ?? [];
    if (!Array.isArray(storedTags) || !storedTags.every((tag): tag is string => typeof tag === 'string')) throw new ClassificationError('invalid_taxonomy');
    const tags = assertValidNodeTags(storedTags);
    bytes += estimateSnapshotNodeBytes({ ...node, title: node.title ?? '', tags });
    return { ...node, tags };
  });
  admitSnapshotTreeGrowth({ liveNodeCount: nodes.length, extraNodes: 0, liveEstimatedBytes: bytes, extraBytes: 0 });
  const root = parsed.find(node => node.id === collection.root_node_id);
  if (!root || !root.is_root || root.kind !== 'folder' || root.parent_id !== null || parsed.some(node => node.is_root && node.id !== root.id)) throw new ClassificationError('invalid_taxonomy');
  const folders = parsed.filter(node => node.kind === 'folder' && !node.is_root).map(node => ({
    id: node.id, parentId: node.parent_id === root.id ? null : node.parent_id,
    title: node.title ?? '', description: node.description,
    ...(typeof node.payload_json?.folderRole === 'string' ? { folderRole: node.payload_json.folderRole } : {}),
  }));
  if (parsed.some(node => !node.is_root && node.parent_id === null)) throw new ClassificationError('invalid_taxonomy');
  buildClassificationTaxonomy(folders);
  const folderIds = new Set([root.id, ...folders.map(folder => folder.id)]);
  if (parsed.some(node => !node.is_root && !folderIds.has(node.parent_id!))) throw new ClassificationError('invalid_taxonomy');
  const tagCounts = new Map<string, number>();
  for (const node of parsed) if (node.kind === 'bookmark') {
    for (const tag of node.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const node = input.nodeId === undefined ? undefined : parsed.find(n => n.id === input.nodeId && n.kind === 'bookmark');
  if (input.nodeId !== undefined && (!node || !isAcceptedBookmarkUrl(node.url))) return null;
  const hostnameEvidence=options.priorEnabled?await readClassificationHostnameEvidence(transaction,{collectionId:collection.id,ownerSubjectId:input.ownerSubjectId,
    taxonomyRevision:collection.content_revision,urls:node?.url?[node.url]:input.bookmarkUrl?[input.bookmarkUrl]:[]}):undefined;
  const snapshot: ClassificationTaxonomySnapshot = {
    ...(hostnameEvidence?{hostnameEvidence}:{}),
    ...(providerBinding?{providerBinding}:{}), collectionId: collection.id, title: collection.title, summary: collection.summary,
    contentRevision: collection.content_revision, settings,
    folders: addClassificationFolderExamples({ folders, bookmarks: parsed.filter(n => n.kind === 'bookmark' && n.url !== null && n.id !== input.nodeId)
      .map(n => ({ id: n.id, parentId: n.parent_id!, title: n.title ?? '', url: n.url! })) }),
    tagUsage: [...tagCounts].map(([tag, count]) => ({ tag, count })),
    node: node && node.url !== null ? { id: node.id, title: node.title ?? '', url: node.url,
      description: node.description, tags: node.tags, resourceRevision: node.resource_revision } : null,
  };
  return {snapshot,rootId:root.id,bookmarks:parsed.filter(node=>node.kind==='bookmark'&&node.url!==null).map(node=>({
    id:node.id,parentId:node.parent_id!,title:node.title??'',url:node.url!,description:node.description,
    tags:node.tags,resourceRevision:node.resource_revision,createdAt:node.created_at.toISOString(),
  }))};
}
