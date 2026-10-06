import type { GuardedNodeWriteMutation } from '../server/node-write-mutation.js';

/** No resolver calls: derive identities solely from the validated request. */
export function nodeWriteIdentityIds(mutation: GuardedNodeWriteMutation): readonly string[] {
  switch (mutation.kind) {
    case 'create-node':
      return Object.freeze([...new Set([mutation.parentId, mutation.nodeId])]);
    case 'move-node':
      return Object.freeze([...new Set([mutation.nodeId, mutation.parentId,
        ...(typeof mutation.afterId === 'string' ? [mutation.afterId] : []),
        ...(typeof mutation.beforeId === 'string' ? [mutation.beforeId] : [])])]);
    case 'reparent-node':
    case 'restore-node':
      return Object.freeze([...new Set([mutation.nodeId, mutation.parentId])]);
    default:
      return Object.freeze([]);
  }
}

/** Missing identity authorization fails closed for operations that need it. */
export async function authorizeNodeWriteIdentities(
  mutation: GuardedNodeWriteMutation,
  authorize: ((nodeId: string) => Promise<boolean>) | undefined,
): Promise<boolean> {
  const ids = nodeWriteIdentityIds(mutation);
  if (ids.length === 0) return true;
  if (authorize === undefined) return false;
  try {
    for (const id of ids) {
      if (await authorize(id) !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}
