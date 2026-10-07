/** Production v3 adds topic roots and bookmark context; the v2 experiments remain archived. */
export const CLASSIFICATION_POLICY = Object.freeze({
  version: 'classification.v3', candidateVersion: 'candidates.v2',
  promptVersion: 'topic-context-v3',
  maxL1: 32, maxDescendants: 64, maxTags: 96, tagChunkSize: 16,
  maxRequestBytes: 32768, folderDescriptionBytes: 384,
  summaryBytes: 768, bookmarkDescriptionBytes: 1536, titleBytes: 512,
  maxFolderExamples: 3, folderExampleTitleBytes: 96, folderExamplesBytes: 256,
  l2SpecificityMin: 0.5, l2ConfidenceMin: 0.4, suggestThreshold: 0.7,
  maxAddedTags: 3, maxFinalTags: 64,
});

/** Bounds derived materialized-path data; the raw tree budget lives in SNAPSHOT_TREE_CAPACITY. */
export const CLASSIFICATION_TAXONOMY_BUDGET = Object.freeze({
  /** Copied ancestor-path entries across the resolved taxonomy; bounds expanded heap. */
  maxPathEntries: 1_000_000,
  /** Copied ancestor-path title bytes across the resolved taxonomy; bounds joins and serialization. */
  maxPathTitleBytes: 16 * 1024 * 1024,
});

export class ClassificationError extends Error {
  constructor(readonly code: 'invalid_input' | 'invalid_taxonomy' | 'context_limit' | 'contract_drift' | 'resource_not_found') {
    super(code); this.name = 'ClassificationError';
  }
}

export interface ClassificationBookmark {
  readonly title: string;
  readonly url: string;
  readonly description: string | null;
}

export interface ClassificationFolderInput {
  readonly id: string;
  /** Collection root is represented by null, never a candidate. */
  readonly parentId: string | null;
  readonly title: string;
  readonly description: string | null;
  /** Browser roots organize topics but must never be recommended as a topic. */
  readonly folderRole?: string;
  readonly bookmarkExamples?: readonly ClassificationFolderExample[];
}

export interface ClassificationFolderExample {
  readonly title: string; readonly hostname: string;
  /** Internal provenance for omitting a batch target from its own context; never sent to the provider. */
  readonly bookmarkId?: string;
}

export function isClassificationContainer(folder: ClassificationFolderInput): boolean {
  return ['root', 'bookmarks-bar', 'other-bookmarks', 'mobile-bookmarks'].includes(folder.folderRole ?? '');
}

export interface ClassificationFolder extends ClassificationFolderInput {
  readonly l1FolderId: string;
  readonly depth: number;
  readonly path: readonly string[];
}

export interface ClassificationTagUsage { readonly tag: string; readonly count: number }
export interface ClassificationRequested { readonly folder: boolean; readonly tags: boolean }
export type ClassificationFolderSelectionMode = 'allow_later' | 'require_candidate';

export interface ClassificationCandidateCoverage {
  readonly policyVersion: string;
  readonly l1Total: number;
  readonly l1Included: number;
  readonly descendantTotal: number;
  readonly descendantIncluded: number;
  readonly tagTotal: number;
  readonly tagIncluded: number;
}
