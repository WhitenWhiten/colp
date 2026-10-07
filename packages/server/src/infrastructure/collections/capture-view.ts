import type { CaptureDecision, ProductCollectionCanonicalPorts, ClassificationContentResult } from '../../modules/collections/index.js';
import type { CaptureDecisionTable } from './capture-records.js';

export function captureDecisionView(row: CaptureDecisionTable): CaptureDecision {
  const result = row.current_result_json ?? row.undo_result_json ?? row.result_json;
  return { decisionId: row.id, captureId: row.capture_id, collectionId: row.collection_id, nodeId: row.node_id,
    status: row.status, reason: row.reason, revision: row.revision, nodeEtag: result?.etag ?? row.input_json.nodeEtag,
    originalParentId: row.original_parent_id, parentId: result?.parentId ?? null,
    ...(row.suggestion_json?.path ? { suggestedPath: row.suggestion_json.path } : {}),
    suggestedParentId: row.suggestion_json?.folderId ?? null,
    tags: result?.tags ?? row.original_tags, executionId: row.execution_id,
    ...(row.suggestion_json?.suggestedTags?.length ? { suggestedTags: row.suggestion_json.suggestedTags } : {}),
    createdAt: row.created_at.toISOString(), appliedAt: row.applied_at?.toISOString() ?? null, undoneAt: row.undone_at?.toISOString() ?? null,
    automaticApplied: Boolean(row.applied_at && !row.suggestion_json?.appliedExplicitly),
    feedbackRevision: row.feedback_revision, effectiveFeedback: row.effective_feedback,
    ...(result?.collectionTitle ? { collectionTitle: result.collectionTitle, path: result.path } : {}),
    ...(row.suggestion_json?.explanation ? { explanation: row.suggestion_json.explanation } : {}) };
}

export async function captureResultLocation(ports: ProductCollectionCanonicalPorts, collectionId: string, collectionTitle: string,
  result: ClassificationContentResult): Promise<ClassificationContentResult & { collectionTitle: string; path: readonly string[] }> {
  const path: string[] = []; let id: string | null = result.parentId; const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id); const node = await ports.nodes.getNode(collectionId, id);
    if (!node || node.deletedAt) throw new Error('capture_path_unavailable');
    if (!node.isRoot) path.unshift(node.title ?? 'Untitled folder'); id = node.parentId;
  }
  return { ...result, collectionTitle, path: [collectionTitle, ...path] };
}

export async function captureSuggestionPath(db: import('kysely').Kysely<import('../database/runtime.js').DatabaseSchema>, collectionId: string, parentId: string) {
  const collection = await db.selectFrom('collections').select('title').where('id', '=', collectionId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!collection) return [];
  const path: string[] = []; let id: string | null = parentId; const seen = new Set<string>();
  while (id && !seen.has(id) && seen.size < 100) {
    seen.add(id);
    const node: { title: string | null; parent_id: string | null; is_root: boolean } | undefined = await db.selectFrom('nodes').select(['title', 'parent_id', 'is_root'])
      .where('id', '=', id).where('collection_id', '=', collectionId).where('kind', '=', 'folder').where('deleted_at', 'is', null).executeTakeFirst();
    if (!node) return [];
    if (!node.is_root) path.unshift(node.title ?? 'Untitled folder'); id = node.parent_id;
  }
  return id ? [] : [collection.title, ...path];
}
