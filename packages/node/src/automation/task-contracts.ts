import type { TaskSpec } from './types.generated.js';
export const TASK_OUTPUT_CONTRACTS: Readonly<Record<TaskSpec['type'], readonly string[]>> = {
  'classify.root': ['placement.subtree.v1'],
  'classify.refine': ['placement.subtree.v1'],
  'tags.generate': ['tags.sourced.v1'],
  'summary.generate': ['summary.sourced.v1'],
  'metadata.resolve': ['metadata.catalog.v1'],
  'review.generate': ['review.sourced.v1'],
  'digest.generate': ['digest.sourced.v1'],
};
/** Deterministic intake suppresses folder classification only. */
export function classificationRequests(satisfied: readonly string[]): { folder: boolean; tags: boolean; summary: boolean } {
  return { folder: !satisfied.includes('classify.root'), tags: !satisfied.includes('tags.generate'), summary: !satisfied.includes('summary.generate') };
}
