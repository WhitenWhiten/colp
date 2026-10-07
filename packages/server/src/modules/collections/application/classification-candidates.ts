import { assertValidNodeTags } from '../domain/validation.js';
import {
  CLASSIFICATION_POLICY as policy, CLASSIFICATION_TAXONOMY_BUDGET as budget, ClassificationError,
  type ClassificationBookmark, type ClassificationFolder, type ClassificationFolderInput,
  type ClassificationTagUsage, type ClassificationRequested, type ClassificationCandidateCoverage,
  isClassificationContainer,
} from './classification-policy.js';
import { classificationBookmarkTokens, classificationJaccard, classificationTokens, compareClassificationBytes } from './classification-text.js';

const encoder = new TextEncoder();

/** Iterative ancestry walk avoids recursive stack overflow on deep live trees. */
export function buildClassificationTaxonomy(input: readonly ClassificationFolderInput[]): readonly ClassificationFolder[] {
  const source = new Map<string, ClassificationFolderInput>();
  for (const folder of input) {
    if (!folder.id || source.has(folder.id) || typeof folder.title !== 'string' || (folder.description !== null && typeof folder.description !== 'string')) throw new ClassificationError('invalid_taxonomy');
    source.set(folder.id, folder);
  }
  const resolved = new Map<string, ClassificationFolder>();
  const pathTitleBytes = new Map<string, number>();
  let expandedEntries = 0; let expandedTitleBytes = 0;
  for (const folder of input) {
    const chain: ClassificationFolderInput[] = []; const seen = new Set<string>();
    let current: ClassificationFolderInput | undefined = folder;
    while (current && !resolved.has(current.id)) {
      if (seen.has(current.id)) throw new ClassificationError('invalid_taxonomy');
      seen.add(current.id); chain.push(current);
      if (current.parentId === null) break;
      current = source.get(current.parentId);
      if (!current) throw new ClassificationError('invalid_taxonomy');
    }
    for (const item of chain.reverse()) {
      const parent = item.parentId === null ? null : resolved.get(item.parentId);
      if (item.parentId !== null && !parent) throw new ClassificationError('invalid_taxonomy');
      const path = [...(parent?.path ?? []), item.title];
      const itemPathTitleBytes = (parent ? pathTitleBytes.get(parent.id)! : 0) + encoder.encode(item.title).length;
      expandedEntries += path.length; expandedTitleBytes += itemPathTitleBytes;
      // The raw tree budget never sees this derived data: a legal tree expands
      // quadratically, so refuse before the materialized copies exhaust memory.
      if (expandedEntries > budget.maxPathEntries || expandedTitleBytes > budget.maxPathTitleBytes) throw new ClassificationError('context_limit');
      pathTitleBytes.set(item.id, itemPathTitleBytes);
      resolved.set(item.id, { ...item, l1FolderId: parent && !isClassificationContainer(parent) ? parent.l1FolderId : item.id,
        depth: (parent?.depth ?? 0) + 1, path });
    }
  }
  return [...resolved.values()].sort((a, b) => compareClassificationBytes(a.id, b.id));
}

export interface ClassificationCandidates {
  readonly taxonomy: readonly ClassificationFolder[];
  readonly l1: readonly ClassificationFolder[];
  readonly tags: readonly string[];
  readonly tagChunks: readonly (readonly string[])[];
  readonly coverage: ClassificationCandidateCoverage;
}

function folderScore(folder: ClassificationFolder, query: ReadonlySet<string>): number {
  const scope = classificationJaccard(query, classificationTokens(`${folder.path.join(' ')} ${folder.title} ${folder.description ?? ''}`));
  return Math.max(scope, ...(folder.bookmarkExamples ?? []).map(example =>
    classificationJaccard(query, classificationTokens(`${example.title} ${example.hostname}`))));
}

function selectFolders(folders: readonly ClassificationFolder[], limit: number, bookmark: ClassificationBookmark, extra: ReadonlyMap<string, number> = new Map()): readonly ClassificationFolder[] {
  const query = classificationBookmarkTokens(bookmark);
  const ranked = folders.map(folder => ({ folder, score: Math.max(folderScore(folder, query), extra.get(folder.id) ?? 0) }));
  ranked.sort((a, b) => (folders.length > limit ? b.score - a.score : 0) || compareClassificationBytes(a.folder.id, b.folder.id));
  return ranked.slice(0, limit).map(item => item.folder);
}

function withoutRejectedFolders(taxonomy: readonly ClassificationFolder[], rejectedIds: readonly string[] = []): readonly ClassificationFolder[] {
  if (!rejectedIds.length) return taxonomy;
  const rejected = new Set(rejectedIds), byId = new Map(taxonomy.map(folder => [folder.id, folder]));
  const turnedDown = (folder: ClassificationFolder): boolean => {
    for (let current: ClassificationFolder | undefined = folder; current; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
      if (rejected.has(current.id)) return true;
    }
    return false;
  };
  return taxonomy.filter(folder => !turnedDown(folder));
}

export function buildClassificationCandidates(input: {
  readonly bookmark: ClassificationBookmark;
  readonly folders: readonly ClassificationFolderInput[];
  readonly tagUsage: readonly ClassificationTagUsage[];
  readonly existingTags: readonly string[];
  readonly requested: ClassificationRequested;
  readonly excludeBookmarkId?: string;
  /** Turned-down folders: they and their subfolders are never candidates. Unknown ids are ignored. */
  readonly rejectedFolderIds?: readonly string[];
}): ClassificationCandidates {
  if (typeof input.requested.folder !== 'boolean' || typeof input.requested.tags !== 'boolean' || (!input.requested.folder && !input.requested.tags)) throw new ClassificationError('invalid_input');
  const query = classificationBookmarkTokens(input.bookmark);
  const folders = input.excludeBookmarkId ? input.folders.map(folder => ({ ...folder,
    ...(folder.bookmarkExamples ? { bookmarkExamples: folder.bookmarkExamples.filter(example => example.bookmarkId !== input.excludeBookmarkId) } : {}) })) : input.folders;
  const taxonomy = withoutRejectedFolders(buildClassificationTaxonomy(folders), input.rejectedFolderIds);
  const roots = input.requested.folder ? taxonomy.filter(f => f.l1FolderId === f.id
    && !isClassificationContainer(f) && f.folderRole !== 'managed-bookmarks') : [];
  const descendants = new Map<string, number>();
  for (const folder of taxonomy) if (folder.id !== folder.l1FolderId && !isClassificationContainer(folder)) {
    descendants.set(folder.l1FolderId, Math.max(descendants.get(folder.l1FolderId) ?? 0, folderScore(folder, query)));
  }
  const l1 = selectFolders(roots, policy.maxL1, input.bookmark, descendants);
  assertValidNodeTags(input.existingTags);
  const seen = new Set<string>();
  for (const entry of input.tagUsage) {
    assertValidNodeTags([entry.tag]);
    if (seen.has(entry.tag) || !Number.isSafeInteger(entry.count) || entry.count < 1) throw new ClassificationError('invalid_taxonomy');
    seen.add(entry.tag);
  }
  const available = input.requested.tags ? input.tagUsage.filter(t => !input.existingTags.includes(t.tag)) : [];
  const tags = available.map(entry => ({ ...entry, score: classificationJaccard(query, classificationTokens(entry.tag)) }))
    .sort((a, b) => b.score - a.score || b.count - a.count || compareClassificationBytes(a.tag, b.tag))
    .slice(0, policy.maxTags).map(t => t.tag).sort(compareClassificationBytes);
  const tagChunks: string[][] = [];
  for (let i = 0; i < tags.length; i += policy.tagChunkSize) tagChunks.push(tags.slice(i, i + policy.tagChunkSize));
  return { taxonomy, l1, tags, tagChunks, coverage: { policyVersion: policy.candidateVersion,
    l1Total: roots.length, l1Included: l1.length, descendantTotal: 0, descendantIncluded: 0, tagTotal: available.length, tagIncluded: tags.length } };
}

export function selectClassificationDescendants(candidates: ClassificationCandidates, l1FolderId: string, bookmark: ClassificationBookmark): {
  readonly folders: readonly ClassificationFolder[]; readonly coverage: ClassificationCandidateCoverage;
} {
  if (!candidates.l1.some(f => f.id === l1FolderId)) throw new ClassificationError('contract_drift');
  const all = candidates.taxonomy.filter(f => f.l1FolderId === l1FolderId && f.id !== l1FolderId
    && !isClassificationContainer(f) && f.folderRole !== 'managed-bookmarks');
  const folders = selectFolders(all, policy.maxDescendants, bookmark);
  return { folders, coverage: { ...candidates.coverage, descendantTotal: all.length, descendantIncluded: folders.length } };
}
