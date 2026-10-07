import { createHash } from 'node:crypto';
import type { DeploymentConformanceTarget } from '@know-n/colp/conformance';

/**
 * Unit-only synthetic target for exercising opaque-evidence rejection paths.
 * It is not deployment evidence and must never be used by a release success path.
 */
export function createUnitOnlySyntheticPhase2Target(): DeploymentConformanceTarget {
  const ledger = new Map<string, string>();
  const reservedIds = new Set<string>();
  const objects = new Map<string, unknown>();
  const parents = new Map<string, string | null>();

  return {
    async execute(command) {
      switch (command.kind) {
        case 'id-ledger.reserve': {
          const replay = ledger.get(command.logicalKey);
          if (replay !== undefined) return { status: 'reserved', id: replay };
          if (reservedIds.has(command.requestedId)) return { status: 'conflict' };
          ledger.set(command.logicalKey, command.requestedId);
          reservedIds.add(command.requestedId);
          return { status: 'reserved', id: command.requestedId };
        }
        case 'id-ledger.delete-resource':
          ledger.delete(command.logicalKey);
          return { status: 'deleted' };
        case 'pre-write.write': {
          const candidate = command.candidate as Record<string, unknown>;
          if (typeof candidate.url !== 'string') return { status: 'rejected' };
          if (typeof candidate.urlHash === 'string') {
            const expected = `sha-256=:${createHash('sha256').update(candidate.url).digest('base64')}:`;
            if (candidate.urlHash !== expected) return { status: 'rejected' };
          }
          objects.set(command.objectId, structuredClone(command.candidate));
          return { status: 'stored' };
        }
        case 'pre-write.load':
          return objects.has(command.objectId)
            ? { status: 'found', value: structuredClone(objects.get(command.objectId)) }
            : { status: 'missing' };
        case 'parent-cycle.seed':
        case 'node-subtree.seed':
          for (const node of command.nodes) parents.set(node.id, node.parentId);
          return { status: 'stored' };
        case 'parent-cycle.move': {
          let current: string | null | undefined = command.parentId;
          const visited = new Set<string>();
          while (current !== null && current !== undefined && !visited.has(current)) {
            if (current === command.nodeId) return { status: 'rejected' };
            visited.add(current);
            current = parents.get(current);
          }
          parents.set(command.nodeId, command.parentId);
          return { status: 'stored' };
        }
        case 'parent-cycle.parent':
          return parents.has(command.nodeId)
            ? { status: 'found', parentId: parents.get(command.nodeId) }
            : { status: 'missing' };
        case 'node-subtree.delete': {
          if (!parents.has(command.nodeId)) return { status: 'missing' };
          const deleted = new Set([command.nodeId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const [nodeId, parentId] of parents) {
              if (!deleted.has(nodeId) && parentId !== null && deleted.has(parentId)) {
                deleted.add(nodeId);
                changed = true;
              }
            }
          }
          for (const nodeId of deleted) parents.delete(nodeId);
          return { status: 'deleted', affectedCount: deleted.size };
        }
        case 'node-subtree.read':
          return parents.has(command.nodeId) ? { status: 'found' } : { status: 'missing' };
        case 'publication.http-contract':
          return {
            challenge: command.challenge,
            initialStatus: 200,
            conditionalStatus: 304,
            etag: '"unit-only-synthetic"',
            validated: true,
          };
        default:
          throw new Error(`Unit-only Phase 2 target does not implement ${command.kind}`);
      }
    },
    async restart() {
      // Deliberately process-local: suitable only for unit rejection tests.
    },
    async readDiagnostics() {
      return { fixture: 'unit-only-synthetic' };
    },
  };
}
