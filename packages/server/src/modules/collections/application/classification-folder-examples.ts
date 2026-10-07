import { buildClassificationTaxonomy } from './classification-candidates.js';
import { CLASSIFICATION_POLICY as policy, type ClassificationFolderExample, type ClassificationFolderInput } from './classification-policy.js';
import { compileClassificationText, compareClassificationBytes, normalizeClassificationBookmark } from './classification-text.js';

/** Bounded, domain-diverse context. URLs, query strings and page contents never enter these examples. */
export function addClassificationFolderExamples(input: {
  readonly folders: readonly ClassificationFolderInput[];
  readonly bookmarks: readonly { readonly id?: string; readonly parentId: string; readonly title: string; readonly url: string }[];
}): readonly ClassificationFolderInput[] {
  const taxonomy = buildClassificationTaxonomy(input.folders);
  const samples = new Map<string, readonly ClassificationFolderExample[]>();
  const folderIds = new Set(taxonomy.map(folder => folder.id));
  const merge = (id: string, additions: readonly ClassificationFolderExample[]) => {
    const sorted = [...(samples.get(id) ?? []), ...additions].sort((a, b) =>
      compareClassificationBytes(a.hostname, b.hostname) || compareClassificationBytes(a.title, b.title)
      || compareClassificationBytes(a.bookmarkId ?? '', b.bookmarkId ?? ''));
    const seen = new Set<string>();
    samples.set(id, sorted.filter(example => {
      if (seen.has(example.hostname)) return false;
      seen.add(example.hostname); return true;
    }).slice(0, policy.maxFolderExamples));
  };
  for (const bookmark of input.bookmarks) {
    if (!folderIds.has(bookmark.parentId)) continue;
    try {
      const normalized = normalizeClassificationBookmark({ ...bookmark, description: null });
      merge(bookmark.parentId, [{ title: compileClassificationText(normalized.title, policy.folderExampleTitleBytes), hostname: normalized.hostname,
        ...(bookmark.id ? { bookmarkId: bookmark.id } : {}) }]);
    } catch { /* Unsupported native URLs are not classification context. */ }
  }
  // Propagate only bounded samples, once per edge, so large/deep branches do not expand prompts quadratically.
  for (const folder of [...taxonomy].sort((a, b) => b.depth - a.depth || compareClassificationBytes(a.id, b.id))) {
    if (folder.parentId !== null && samples.has(folder.id)) merge(folder.parentId, samples.get(folder.id)!);
  }
  return input.folders.map(folder => samples.has(folder.id) ? { ...folder, bookmarkExamples: samples.get(folder.id)! } : folder);
}
