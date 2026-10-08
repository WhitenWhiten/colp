import assert from 'node:assert/strict';

export interface KeysetPlanNode {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Actual Rows': number;
  readonly 'Actual Loops': number;
  readonly 'Rows Removed by Filter'?: number;
  readonly 'Rows Removed by Index Recheck'?: number;
  readonly 'Heap Fetches'?: number;
  readonly Plans?: readonly KeysetPlanNode[];
}

/** Cardinality and seek checks intentionally do not interpret MVCC heap
 * visibility work as index traversal distance. */
export function assertOwnedKeysetPlan(plan: KeysetPlanNode, continuation: boolean): void {
  const flatten = (node: KeysetPlanNode): KeysetPlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
  const nodes = flatten(plan);
  assert.equal(nodes.some(node => /Seq Scan|Sort/.test(node['Node Type'])), false,
    'owned page must avoid full scans and sorts');
  const scan = nodes.find(node => node['Index Name'] === 'collections_owned_live_updated_id_idx');
  assert.ok(scan, 'owned page must use the owner/live/keyset index');
  assert.match(scan['Index Cond'] ?? '', /owner_subject_id/, 'seek must bind the owner');
  if (continuation) assert.match(scan['Index Cond'] ?? '', /updated_at <=/,
    'continuation must seek to its timestamp boundary, not filter earlier pages');
  const traversed = (scan['Actual Rows'] + (scan['Rows Removed by Filter'] ?? 0)
    + (scan['Rows Removed by Index Recheck'] ?? 0)) * scan['Actual Loops'];
  assert.ok(traversed <= 32, `owned page scanned/filtered ${traversed} tuples for a limit of 31`);
  assert.ok(plan['Actual Rows'] <= 31, 'owned page output exceeds limit');
}
