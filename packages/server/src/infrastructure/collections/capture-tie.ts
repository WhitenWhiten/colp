import type { Kysely } from 'kysely';
import { resolveCapturePrimaryTie, eligibleCapturePrior, APPROVED_CAPTURE_PRIOR_EVALUATION,
  buildClassificationTaxonomy, isClassificationContainer, type CapturePriorEvaluation } from '../../modules/collections/index.js';
import type { ClassificationDeploymentIdentity } from './classification-provider-factory.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import type { CaptureDecisionTable } from './capture-records.js';
import { readCapturePreferenceEvidence } from './capture-memory.js';
export interface CaptureModelFolder {
  readonly folderId: string | null; readonly decision: string; readonly confidence: number;
  readonly l1FolderId?: string | null;
  readonly probabilities?: readonly { folderId: string | null; probability: number }[];
}
export async function chooseCaptureTie(db: Kysely<DatabaseSchema>, row: CaptureDecisionTable, folder: CaptureModelFolder, options: {
  enabled?: boolean; evaluation?: CapturePriorEvaluation | null; onError?: () => void;
  identity?: ClassificationDeploymentIdentity | null;
}) {
  const fallback = { folderId: folder.folderId!, explanation: null, evidenceGeneration: 0 };
  if (!options.enabled || !options.identity || !eligibleCapturePrior(options.evaluation === undefined ? APPROVED_CAPTURE_PRIOR_EVALUATION : options.evaluation, options.identity)
    || !folder.folderId || !row.original_url || !folder.probabilities || folder.decision === 'later') return fallback;
  try {
    return await createUnitOfWork(db, { isolationLevel: 'repeatable read' }).execute(async ({ transaction: tx }) => {
      const preference = await tx.selectFrom('bookmark_preferences').select('learn_from_corrections').where('account_id', '=', row.account_id).executeTakeFirst();
      if (preference?.learn_from_corrections === false) return fallback;
      const collection = await tx.selectFrom('collections').select(['root_node_id', 'content_revision'])
        .where('id', '=', row.collection_id).where('owner_subject_id', '=', row.owner_subject_id).where('deleted_at', 'is', null).executeTakeFirst();
      if (!collection) return fallback;
      const folders = await tx.selectFrom('nodes').select(['id', 'parent_id', 'title', 'description', 'payload_json']).where('collection_id', '=', row.collection_id)
        .where('kind', '=', 'folder').where('deleted_at', 'is', null).where('is_root', '=', false).limit(10001).execute();
      if (folders.length > 10000) return fallback;
      const taxonomy = buildClassificationTaxonomy(folders.map(candidate => ({ id: candidate.id,
        parentId: candidate.parent_id === collection.root_node_id ? null : candidate.parent_id,
        title: candidate.title ?? '', description: candidate.description,
        ...(typeof candidate.payload_json?.folderRole === 'string' ? { folderRole: candidate.payload_json.folderRole } : {}) })));
      const legal = new Set(taxonomy.filter(candidate => {
        if (isClassificationContainer(candidate) || candidate.folderRole === 'managed-bookmarks') return false;
        if (folder.decision === 'l1_root') return candidate.l1FolderId === candidate.id;
        return candidate.l1FolderId === folder.l1FolderId && candidate.id !== folder.l1FolderId;
      }).map(folder => folder.id));
      const evidence = await readCapturePreferenceEvidence(tx, { accountId: row.account_id, collectionId: row.collection_id,
        ownerSubjectId: row.owner_subject_id, url: row.original_url! });
      const control = await tx.selectFrom('bookmark_capture_learning').select('generation').where('account_id', '=', row.account_id).executeTakeFirst();
      return { evidenceGeneration: control?.generation ?? 0, ...resolveCapturePrimaryTie({ ...folder, folderId: folder.folderId!, probabilities: folder.probabilities! }, evidence, collection.content_revision, legal) };
    });
  } catch { options.onError?.(); return fallback; } // Optional memory failure must leave the base Jev decision usable.
}
