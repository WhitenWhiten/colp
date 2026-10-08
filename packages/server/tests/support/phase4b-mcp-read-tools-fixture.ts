import {
  createMcp20260728ReadToolAdapter,
  createMcpStatelessToolCore,
  McpResourceNotFoundError,
} from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_SERVER_INFO,
  createPhase4bMcpReadToolAdapter,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpReadToolAdapterBundle,
  type Phase4bMcpSnapshotResourceProjection,
} from '../../src/modules/mcp/index.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';

/** Empty Modern Tool surface for phase4b tests that do not exercise Tools. */
export function emptyReadToolAdapterBundle(): Phase4bMcpReadToolAdapterBundle {
  const toolCore = createMcpStatelessToolCore({ tools: [] });
  const adapter = createMcp20260728ReadToolAdapter({
    toolCore,
    serverInfo: PHASE4B_MCP_SERVER_INFO,
  });
  return Object.freeze({
    adapter,
    paramDeclarations: Object.freeze([]),
  });
}

function unusedNodeProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new McpResourceNotFoundError();
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

/** Real P4B-R12 host adapter bundle composed from the Read projections. */
export function hostReadToolAdapterBundle(
  collectionProjection: Phase4bMcpCollectionResourceProjection,
  snapshotProjection: Phase4bMcpSnapshotResourceProjection,
  nodeProjection: Phase4bMcpNodeResourceProjection = unusedNodeProjection(),
): Phase4bMcpReadToolAdapterBundle {
  return createPhase4bMcpReadToolAdapter({
    collectionProjection,
    snapshotProjection,
    nodeProjection,
    serverUuid: SERVER_UUID,
  });
}
