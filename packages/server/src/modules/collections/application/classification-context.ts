import type { ClassificationHostnameEvidence } from './classification-hostname-prior.js';
import { buildClassificationCandidates } from './classification-candidates.js';
import { ClassificationError, type ClassificationBookmark, type ClassificationFolderInput, type ClassificationTagUsage } from './classification-policy.js';
import { type ClassificationPreviewInput } from './classification-input.js';
import { compileClassificationText, normalizeClassificationBookmark } from './classification-text.js';
import { CLASSIFICATION_POLICY } from './classification-policy.js';
import type { ClassificationSettings } from './classification-settings.js';

export interface ClassificationTaxonomySnapshot {
  readonly hostnameEvidence?:readonly ClassificationHostnameEvidence[];
  readonly providerBinding?:{readonly profileId:string;readonly revision:string;readonly ownerSubjectId:string};
  readonly collectionId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly contentRevision: string;
  readonly settings: ClassificationSettings;
  readonly folders: readonly ClassificationFolderInput[];
  readonly tagUsage: readonly ClassificationTagUsage[];
  readonly node: (ClassificationBookmark & { readonly id: string; readonly resourceRevision: string; readonly tags: readonly string[] }) | null;
}

export interface ClassificationTaxonomyReadPort {
  /** Owner-only, complete bounded tree, vocabulary and optional Node in ONE snapshot. */
  loadSnapshot(input: { readonly ownerSubjectId: string; readonly collectionId: string; readonly nodeId?: string;readonly bookmarkUrl?:string }): Promise<ClassificationTaxonomySnapshot | null>;
}

export async function loadClassificationContext(input: {
  readonly ownerSubjectId: string; readonly collectionId: string;
  readonly preview: ClassificationPreviewInput; readonly tagsEnabled: boolean;
}, reads: ClassificationTaxonomyReadPort) {
  const nodeId = 'nodeId' in input.preview ? input.preview.nodeId : undefined;
  const snapshot = await reads.loadSnapshot({ ownerSubjectId: input.ownerSubjectId, collectionId: input.collectionId, nodeId,...('bookmark' in input.preview?{bookmarkUrl:input.preview.bookmark.url}:{}) });
  if (!snapshot) return null;
  if (snapshot.collectionId !== input.collectionId || (nodeId !== undefined && snapshot.node?.id !== nodeId)) throw new ClassificationError('invalid_taxonomy');
  const original = 'bookmark' in input.preview ? input.preview.bookmark : snapshot.node;
  if (!original) return null;
  const requested = { folder: input.preview.requested.folder, tags: input.preview.requested.tags && input.tagsEnabled && snapshot.settings.autoTagMode !== 'off' };
  // Both may be false after settings disable tags; return an explicit no-call
  // context instead of pretending that a model successfully evaluated tags.
  const candidates = requested.folder || requested.tags ? buildClassificationCandidates({
    bookmark: original, folders: snapshot.folders, tagUsage: snapshot.tagUsage,
    existingTags: snapshot.node?.tags ?? [], requested, excludeBookmarkId: nodeId, rejectedFolderIds: input.preview.rejectedFolderIds,
  }) : null;
  return { snapshot, requested, ...input.preview.rejectedFolderIds ? { rejectedFolderIds: input.preview.rejectedFolderIds } : {},
    ...(input.preview.folderSelectionMode ? { folderSelectionMode: input.preview.folderSelectionMode } : {}), bookmark: normalizeClassificationBookmark(original), candidates,
    collection: { title: compileClassificationText(snapshot.title, CLASSIFICATION_POLICY.titleBytes),
      summary: snapshot.summary === null ? null : compileClassificationText(snapshot.summary, CLASSIFICATION_POLICY.summaryBytes) } };
}
