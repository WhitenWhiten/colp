import { validateNodeUrlHashSemantics, type SemanticIssue, type SemanticValidationResult } from '../semantic/index.js';
import type { Node } from '../types/index.js';

interface NodeWriteExpectation {
  readonly collectionId: string;
  readonly parentId: string;
  readonly nodeId?: string;
  readonly position?: string;
}

/** Bind a structurally valid write response to the request and its final placement. */
export function validateNodeWriteResponse(
  node: Node,
  expected: NodeWriteExpectation,
  path = '',
): SemanticValidationResult {
  const issues: SemanticIssue[] = [];
  const bindings = [
    ['collectionId', expected.collectionId, 'collection_identity_mismatch'],
    ['parentId', expected.parentId, 'node_parent_mismatch'],
    ['id', expected.nodeId, 'node_identity_mismatch'],
    ['position', expected.position, 'node_position_mismatch'],
  ] as const;
  for (const [field, value, code] of bindings) {
    if (value !== undefined && node[field] !== value) {
      issues.push({ code, path: `${path}/${field}`,
        message: `Node write response ${field} does not match the requested resource or final placement.` });
    }
  }
  issues.push(...validateNodeUrlHashSemantics(node, `${path}/urlHash`).issues);
  return issues.length === 0 ? { valid: true, issues: [] } : { valid: false, issues };
}
