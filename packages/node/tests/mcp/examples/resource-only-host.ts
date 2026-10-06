/**
 * COLP-MCP-12: minimal Resource-only MCP host example (type-checked).
 *
 * Mirrors the fenced example in `docs/MCP_HOST_GUIDE.md`. The docs version
 * imports from `@collection-protocol/node/mcp`; this compilable copy uses the
 * internal relative entry so `npm run typecheck` can prove the example
 * surface compiles without a prior `npm run build`.
 *
 * The host owns the projection port and the URI authority; the package
 * provides the stateless shared core, the Modern `2026-07-28` Resource
 * adapter and the per-request trusted context. One frozen adapter serves
 * every request; there is no Session and no per-client instance.
 */
import {
  createAnonymousPublicBinding,
  createMcp20260728RequestContext,
  createMcp20260728ResourceAdapter,
  createMcpStatelessReadCore,
  type McpResourceProjectionPort,
} from '../../../src/mcp/index.js';

const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const collectionMetadataUri = `colp://${serverUuid}/collections/collection-1`;

/** Host-owned, protocol-neutral projection port: authorize and project only. */
const projection: McpResourceProjectionPort = {
  listResources: async () => ({
    resources: [
      {
        uri: collectionMetadataUri,
        name: 'Collection 1',
        mimeType: 'application/json',
        provenance: { origin: 'internal' },
      },
    ],
  }),
  readResource: async () => ({
    contents: [
      {
        uri: collectionMetadataUri,
        mimeType: 'application/json',
        text: '{"id":"collection-1"}',
        provenance: { origin: 'internal' },
      },
    ],
  }),
};

/** Host-owned logical URI codec bound to the server's stable authority. */
const uriCodec = {
  serverUuid,
  collectionMetadata: (collectionId: string) =>
    `colp://${serverUuid}/collections/${collectionId}`,
  collectionSnapshot: (collectionId: string) =>
    `colp://${serverUuid}/collections/${collectionId}/snapshot`,
  collectionNode: (collectionId: string, nodeId: string) =>
    `colp://${serverUuid}/collections/${collectionId}/nodes/${nodeId}`,
  parse: (uri: string) => {
    const collectionId = uri.split('/collections/')[1] ?? '';
    return { kind: 'collection-metadata' as const, collectionId };
  },
};

/** One frozen adapter instance serves concurrent per-request contexts. */
const resourceAdapter = createMcp20260728ResourceAdapter({
  readCore: createMcpStatelessReadCore({ projection, uriCodec }),
  serverInfo: Object.freeze({ name: 'collection-host', version: '0.0.0' }),
});

/**
 * Host transport entry for a Resource-only mount: builds one trusted
 * per-request context and forwards it to the shared adapter.
 */
export async function handleResourceList(
  headers: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  body: Readonly<{ method: string; params?: Readonly<Record<string, unknown>> }>,
): Promise<unknown> {
  const context = createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body,
    binding: createAnonymousPublicBinding({
      resourceAudience: 'urn:colp:resource:public',
      securityEpoch: 'epoch-1',
    }),
  });
  return resourceAdapter.listResources(context, {});
}

export { resourceAdapter, collectionMetadataUri };
