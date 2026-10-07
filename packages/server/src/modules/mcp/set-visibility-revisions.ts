/**
 * Host mapping from COLP `set_visibility` (collectionId + baseRevision +
 * visibility) onto Plan revision namespaces.
 *
 * public/unlisted, and private when `baseRevision` is the collection resource
 * fence, target Collection metadata. protected, and private when the fence
 * matches one live node, keep the existing node-visibility path.
 */
export type McpSetVisibilityKind = 'public' | 'unlisted' | 'protected' | 'private';

export interface McpSetVisibilityNodeMatch {
  readonly id: string;
  readonly resourceRevision: string;
}

export interface McpSetVisibilityRevisionDecision {
  readonly kind: 'collection' | 'node';
  readonly map: Readonly<Record<string, string>>;
}

export function decideMcpSetVisibilityRevisions(input: {
  readonly visibility: McpSetVisibilityKind;
  readonly collectionId: string;
  readonly baseRevision: string;
  readonly collectionResourceRevision: string;
  readonly collectionPolicyRevision: string;
  readonly matchingNodes: readonly McpSetVisibilityNodeMatch[];
}): McpSetVisibilityRevisionDecision | null {
  const collectionMatch = input.collectionResourceRevision === input.baseRevision;
  const uniqueNode = input.matchingNodes.length === 1 ? input.matchingNodes[0] : undefined;
  if (input.visibility === 'public' || input.visibility === 'unlisted') {
    if (!collectionMatch) return null;
    return collectionDecision(input);
  }
  if (input.visibility === 'protected') {
    if (uniqueNode === undefined) return null;
    return nodeDecision(input.collectionId, input.collectionPolicyRevision, uniqueNode);
  }
  if (collectionMatch && uniqueNode !== undefined) return null;
  if (collectionMatch) return collectionDecision(input);
  if (uniqueNode !== undefined) {
    return nodeDecision(input.collectionId, input.collectionPolicyRevision, uniqueNode);
  }
  return null;
}

export function isMcpCollectionVisibilityRevisionMap(
  baseRevisions: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(baseRevisions).some((key) => key.startsWith('resource.'));
}

function collectionDecision(input: {
  readonly collectionId: string;
  readonly collectionResourceRevision: string;
  readonly collectionPolicyRevision: string;
}): McpSetVisibilityRevisionDecision {
  return Object.freeze({
    kind: 'collection',
    map: Object.freeze({
      [`resource.${input.collectionId}`]: input.collectionResourceRevision,
      [`policy.${input.collectionId}`]: input.collectionPolicyRevision,
    }),
  });
}

function nodeDecision(
  collectionId: string,
  policyRevision: string,
  node: McpSetVisibilityNodeMatch,
): McpSetVisibilityRevisionDecision {
  return Object.freeze({
    kind: 'node',
    map: Object.freeze({
      [`node.${node.id}`]: node.resourceRevision,
      [`policy.${collectionId}`]: policyRevision,
    }),
  });
}
