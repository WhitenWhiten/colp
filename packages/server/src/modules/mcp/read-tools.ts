/**
 * P4B-R12 bounded Modern MCP Read Tools.
 *
 * The host owns the frozen read-only Tool registrations:
 * `collections.get`, `collections.get_snapshot`, and `nodes.get`. It composes
 * the COLP-MCP-09 stateless Tool core and Modern Read Tool adapter from the
 * supported `@know-n/colp/mcp` surface, stamps the fixed Phase 4B
 * server info, and keeps the static schema declarations available to the
 * transport for `Mcp-Name` / `Mcp-Param-*` validation.
 *
 * Tool descriptions are fixed trusted strings. Untrusted Collection content
 * only appears in structured results after the R08/R09/R10 projections have
 * authorized and projected it.
 */
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  DEFAULT_MCP_SCHEMA_BUDGET,
  createMcp20260728ReadToolAdapter,
  createMcpResourceUriCodec,
  createMcpStatelessToolCore,
  scanMcp20260728XMcpHeaderDeclarations,
  type Mcp20260728ReadToolAdapter,
  type Mcp20260728XMcpHeaderDeclaration,
  type McpToolDefinition,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import type { Phase4bMcpCollectionResourceProjection } from './collection-resources.js';
import { resolvePhase4bMcpServerInfo } from './discovery.js';
import type { Phase4bMcpNodeResourceProjection } from './node-resources.js';
import {
  PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX,
  PHASE4B_MCP_OWNED_SNAPSHOT_DEFAULT_LIMIT,
  canUseOwnedMcpRead,
  decodeOwnedSnapshotCursor,
  ownedMcpActorSubjectId,
  projectOwnedCollectionMetadata,
  projectOwnedNode,
  projectOwnedSnapshot,
  type Phase4bMcpOwnedCollectionReadPort,
  type Phase4bMcpOwnedCollectionRecord,
  type Phase4bMcpOwnedNodeRecord,
  type Phase4bMcpOwnedSnapshotAfter,
} from './owned-collection-read-mcp.js';
import type { Phase4bMcpSnapshotResourceProjection } from './snapshot-resources.js';

export const PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER = 'X-Collection-Id' as const;
export const PHASE4B_MCP_READ_TOOL_SCHEMA_BUDGET = DEFAULT_MCP_SCHEMA_BUDGET;
export const PHASE4B_MCP_READ_TOOL_NAMES: readonly [
  'collections.get',
  'collections.get_snapshot',
  'nodes.get',
] =
  Object.freeze(['collections.get', 'collections.get_snapshot', 'nodes.get']);
export const PHASE4B_MCP_READ_TOOL_SNAPSHOT_MIME_TYPE =
  'application/vnd.collection-protocol.snapshot+json' as const;
export const PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPE_PREFIX = 'mcp:read:' as const;
export const PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES: readonly [
  'collections:read',
  'nodes:read',
  'snapshots:read',
] = Object.freeze([
  'collections:read',
  'nodes:read',
  'snapshots:read',
]);

export function isPhase4bMcpReadScope(scope: string): boolean {
  return PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES.some((required) => required === scope)
    || scope.startsWith(PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPE_PREFIX);
}

export function hasAnyPhase4bMcpReadScope(scope: readonly string[]): boolean {
  return scope.some(isPhase4bMcpReadScope);
}

const MCP_JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema' as const;

const collectionIdProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 1_024,
  'x-mcp-header': PHASE4B_MCP_READ_TOOL_COLLECTION_ID_HEADER,
} as const);

const collectionIdInputSchema = Object.freeze({
  $schema: MCP_JSON_SCHEMA_2020_12,
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ collectionId: collectionIdProperty }),
  required: Object.freeze(['collectionId']),
} as const);

const snapshotInputSchema = Object.freeze({
  $schema: MCP_JSON_SCHEMA_2020_12,
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: collectionIdProperty,
    cursor: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: DEFAULT_MCP_RESOURCE_READ_BUDGET.maxCursorLength,
    }),
  }),
  required: Object.freeze(['collectionId']),
} as const);

const nodeIdProperty = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 1_024,
} as const);

const nodesGetInputSchema = Object.freeze({
  $schema: MCP_JSON_SCHEMA_2020_12,
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    collectionId: collectionIdProperty,
    nodeId: nodeIdProperty,
  }),
  required: Object.freeze(['collectionId', 'nodeId']),
} as const);

// MCP outputSchema describes structuredContent. Content blocks are validated
// and bounded separately by the public tool adapter.
const collectionsGetOutputSchema = Object.freeze({
  $schema: MCP_JSON_SCHEMA_2020_12,
  type: 'object',
} as const);
const collectionsGetSnapshotOutputSchema = collectionsGetOutputSchema;

export const PHASE4B_MCP_COLLECTIONS_GET_DESCRIPTION =
  'Get one library including revision (collection resource fence). Owners with mcp:read:own can read unpublished libraries; anonymous and mcp:read:public-only callers see published libraries only. resources/list is the published public directory.';
export const PHASE4B_MCP_COLLECTIONS_GET_SNAPSHOT_DESCRIPTION =
  'Get one snapshot page. Owners with mcp:read:own can read unpublished libraries; others only published ones.';
export const PHASE4B_MCP_NODES_GET_DESCRIPTION =
  'Get one node including revision (node resource fence for nodes.update and node set_visibility). Owners with mcp:read:own can read unpublished libraries; others only published ones.';

export const collectionsGetDefinition = Object.freeze({
  name: 'collections.get',
  description: PHASE4B_MCP_COLLECTIONS_GET_DESCRIPTION,
  inputSchema: collectionIdInputSchema,
  outputSchema: collectionsGetOutputSchema,
} as const satisfies McpToolDefinition);

export const collectionsGetSnapshotDefinition = Object.freeze({
  name: 'collections.get_snapshot',
  description: PHASE4B_MCP_COLLECTIONS_GET_SNAPSHOT_DESCRIPTION,
  inputSchema: snapshotInputSchema,
  outputSchema: collectionsGetSnapshotOutputSchema,
} as const satisfies McpToolDefinition);

export const nodesGetDefinition = Object.freeze({
  name: 'nodes.get',
  description: PHASE4B_MCP_NODES_GET_DESCRIPTION,
  inputSchema: nodesGetInputSchema,
  outputSchema: collectionsGetOutputSchema,
} as const satisfies McpToolDefinition);

const scanResult = scanMcp20260728XMcpHeaderDeclarations(collectionIdInputSchema);
if (!scanResult.valid) {
  throw new TypeError(`Invalid P4B-R12 Tool header declaration: ${scanResult.reason}`);
}

export const PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS: readonly Mcp20260728XMcpHeaderDeclaration[] =
  Object.freeze(scanResult.declarations.map((declaration) => Object.freeze({
    path: Object.freeze([...declaration.path]),
    headerName: declaration.headerName,
    type: declaration.type,
  })));

export interface Phase4bMcpReadToolAdapterBundle {
  readonly adapter: Mcp20260728ReadToolAdapter;
  readonly paramDeclarations: readonly Mcp20260728XMcpHeaderDeclaration[];
}

export interface Phase4bMcpReadToolAdapterOptions {
  readonly collectionProjection: Phase4bMcpCollectionResourceProjection;
  readonly snapshotProjection: Phase4bMcpSnapshotResourceProjection;
  readonly nodeProjection: Phase4bMcpNodeResourceProjection;
  readonly serverUuid: string;
  readonly writeEnabled?: boolean;
  /** Canonical owner/member reads for unpublished libraries (`mcp:read:own`). */
  readonly ownedRead?: Phase4bMcpOwnedCollectionReadPort;
}

/**
 * Returns `true` for anonymous principals (treated as holding `mcp:read:public`
 * for the mounted read tools) and for authenticated calls carrying at
 * least one Read scope. Authenticated empty-scope and write-only scopes get
 * no Read Tool surface. Write tools stay gated separately.
 */
export function canAccessPhase4bMcpReadTools(
  context: McpTrustedReadRequestContext,
): boolean {
  if (context.binding.kind === 'anonymous') return true;
  return context.binding.kind === 'authenticated' && hasAnyPhase4bMcpReadScope(context.scope);
}

/**
 * Builds the single frozen P4B-R12 Modern Read Tool adapter bundle. The
 * adapter can serve concurrent requests and never retains request state.
 */
export function createPhase4bMcpReadToolAdapter(
  options: Phase4bMcpReadToolAdapterOptions,
): Phase4bMcpReadToolAdapterBundle {
  const collectionProjection = readOwnedProjection(
    options,
    'collectionProjection',
  ) as Phase4bMcpCollectionResourceProjection;
  const snapshotProjection = readOwnedProjection(
    options,
    'snapshotProjection',
  ) as Phase4bMcpSnapshotResourceProjection;
  const nodeProjection = readOwnedProjection(
    options,
    'nodeProjection',
  ) as Phase4bMcpNodeResourceProjection;
  const ownedRead = readOptionalOwnedRead(options);
  const serverUuid = readOwnedServerUuid(options);
  const uriCodec = createMcpResourceUriCodec(Object.freeze({ serverUuid }));
  const toolCore = createMcpStatelessToolCore({
    tools: [
      {
        definition: collectionsGetDefinition,
        invoke: (input, context) =>
          invokeCollectionsGet(collectionProjection, ownedRead, input, context),
      },
      {
        definition: collectionsGetSnapshotDefinition,
        invoke: (input, context) =>
          invokeCollectionsGetSnapshot(
            snapshotProjection,
            uriCodec,
            ownedRead,
            input,
            context,
          ),
      },
      {
        definition: nodesGetDefinition,
        invoke: (input, context) => invokeNodesGet(nodeProjection, ownedRead, input, context),
      },
    ],
  });
  const adapter = createMcp20260728ReadToolAdapter({
    toolCore,
    serverInfo: resolvePhase4bMcpServerInfo(options.writeEnabled === true),
    schemaBudget: PHASE4B_MCP_READ_TOOL_SCHEMA_BUDGET,
  });
  return Object.freeze({
    adapter,
    paramDeclarations: PHASE4B_MCP_READ_TOOL_PARAM_DECLARATIONS,
  });
}

async function invokeCollectionsGet(
  projection: Phase4bMcpCollectionResourceProjection,
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  input: unknown,
  context: McpTrustedReadRequestContext,
): Promise<Readonly<{ content: unknown; structuredContent: unknown }>> {
  const args = input as Readonly<{ collectionId: string }>;
  if (args.collectionId === '.' || args.collectionId === '..') {
    throw new TypeError('Collection id must not be a relative path segment.');
  }
  const owned = await tryOwnedCollection(ownedRead, args.collectionId, context);
  if (owned !== null) {
    const structuredContent = projectOwnedCollectionMetadata(owned);
    return Object.freeze({
      content: jsonTextContent(structuredContent),
      structuredContent,
    });
  }
  const projected = await projection.readResource(
    Object.freeze({
      resource: Object.freeze({
        kind: 'collection-metadata',
        collectionId: args.collectionId,
      }),
    }),
    context,
  );
  const structuredContent = readProjectionJson(projected);
  return Object.freeze({
    content: jsonTextContent(structuredContent),
    structuredContent,
  });
}

async function invokeNodesGet(
  projection: Phase4bMcpNodeResourceProjection,
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  input: unknown,
  context: McpTrustedReadRequestContext,
): Promise<Readonly<{ content: unknown; structuredContent: unknown }>> {
  const args = input as Readonly<{ collectionId: string; nodeId: string }>;
  if (args.collectionId === '.' || args.collectionId === '..') {
    throw new TypeError('Collection id must not be a relative path segment.');
  }
  if (args.nodeId === '.' || args.nodeId === '..') {
    throw new TypeError('Node id must not be a relative path segment.');
  }
  const owned = await tryOwnedNode(ownedRead, args.collectionId, args.nodeId, context);
  if (owned !== null) {
    const structuredContent = projectOwnedNode(owned);
    return Object.freeze({
      content: jsonTextContent(structuredContent),
      structuredContent,
    });
  }
  const projected = await projection.readResource(
    Object.freeze({
      resource: Object.freeze({
        kind: 'collection-node',
        collectionId: args.collectionId,
        nodeId: args.nodeId,
      }),
    }),
    context,
  );
  const structuredContent = readProjectionJson(projected);
  return Object.freeze({
    content: jsonTextContent(structuredContent),
    structuredContent,
  });
}

async function invokeCollectionsGetSnapshot(
  projection: Phase4bMcpSnapshotResourceProjection,
  uriCodec: ReturnType<typeof createMcpResourceUriCodec>,
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  input: unknown,
  context: McpTrustedReadRequestContext,
): Promise<Readonly<{ content: unknown; structuredContent: unknown }>> {
  const args = input as Readonly<{ collectionId: string; cursor?: string }>;
  if (args.collectionId === '.' || args.collectionId === '..') {
    throw new TypeError('Collection id must not be a relative path segment.');
  }
  const ownedBody = await tryOwnedSnapshot(ownedRead, args.collectionId, args.cursor, context);
  const body = ownedBody ?? await readPublicationSnapshot(projection, args, context);
  const collection = body.collection;
  if (typeof collection !== 'object' || collection === null) {
    throw new TypeError('Snapshot projection is missing its collection envelope.');
  }
  const metadata = collection as Readonly<Record<string, unknown>>;
  const name = metadata.title;
  const lastModified = metadata.updatedAt;
  if (typeof name !== 'string' || name.length === 0 || typeof lastModified !== 'string') {
    throw new TypeError('Snapshot projection is missing link metadata.');
  }
  return Object.freeze({
    content: Object.freeze([
      jsonTextContentBlock(body),
      Object.freeze({
        type: 'resource_link',
        uri: uriCodec.collectionSnapshot(args.collectionId),
        name,
        mimeType: PHASE4B_MCP_READ_TOOL_SNAPSHOT_MIME_TYPE,
        annotations: Object.freeze({
          audience: Object.freeze(['user', 'assistant'] as const),
          priority: 0.8,
          lastModified,
        }),
      }),
    ]),
    structuredContent: body,
  });
}

async function readPublicationSnapshot(
  projection: Phase4bMcpSnapshotResourceProjection,
  args: Readonly<{ collectionId: string; cursor?: string }>,
  context: McpTrustedReadRequestContext,
): Promise<Readonly<Record<string, unknown>>> {
  const resource = Object.freeze({
    kind: 'collection-snapshot' as const,
    collectionId: args.collectionId,
  });
  const projected = args.cursor === undefined
    ? await projection.readResource(Object.freeze({ resource }), context)
    : await projection.readPage(Object.freeze({ resource, pageCursor: args.cursor }), context);
  return readProjectionJson(projected) as Readonly<Record<string, unknown>>;
}

async function tryOwnedCollection(
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  collectionId: string,
  context: McpTrustedReadRequestContext,
): Promise<Phase4bMcpOwnedCollectionRecord | null> {
  const actor = ownedReadContext(ownedRead, context);
  if (actor === undefined) return null;
  return ownedRead!.readCollection({ collectionId, actorSubjectId: actor });
}

async function tryOwnedNode(
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  collectionId: string,
  nodeId: string,
  context: McpTrustedReadRequestContext,
): Promise<Phase4bMcpOwnedNodeRecord | null> {
  const actor = ownedReadContext(ownedRead, context);
  if (actor === undefined) return null;
  return ownedRead!.readNode({ collectionId, nodeId, actorSubjectId: actor });
}

async function tryOwnedSnapshot(
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  collectionId: string,
  cursor: string | undefined,
  context: McpTrustedReadRequestContext,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  const actor = ownedReadContext(ownedRead, context);
  if (actor === undefined) return undefined;
  let after: Phase4bMcpOwnedSnapshotAfter | undefined;
  if (cursor !== undefined) {
    after = decodeOwnedSnapshotCursor(collectionId, cursor);
    if (cursor.startsWith(PHASE4B_MCP_OWNED_SNAPSHOT_CURSOR_PREFIX) && after === undefined) {
      throw new TypeError('Snapshot projection is missing its collection envelope.');
    }
    if (after === undefined) return undefined;
  }
  const record = await ownedRead!.readSnapshot({
    collectionId,
    actorSubjectId: actor,
    limit: PHASE4B_MCP_OWNED_SNAPSHOT_DEFAULT_LIMIT,
    ...(after === undefined ? {} : { after }),
  });
  if (record === null) return undefined;
  return projectOwnedSnapshot(record, cursor);
}

function ownedReadContext(
  ownedRead: Phase4bMcpOwnedCollectionReadPort | undefined,
  context: McpTrustedReadRequestContext,
): string | undefined {
  if (ownedRead === undefined || !canUseOwnedMcpRead(context)) return undefined;
  return ownedMcpActorSubjectId(context);
}

function jsonTextContent(value: unknown): readonly [Readonly<{ type: 'text'; text: string }>] {
  return Object.freeze([jsonTextContentBlock(value)]);
}

function jsonTextContentBlock(value: unknown): Readonly<{ type: 'text'; text: string }> {
  return Object.freeze({ type: 'text', text: JSON.stringify(value) });
}

function readProjectionJson(
  projected: Readonly<{ contents?: readonly unknown[] }>,
): unknown {
  if (
    !Array.isArray(projected.contents)
    || projected.contents.length !== 1
    || typeof projected.contents[0] !== 'object'
    || projected.contents[0] === null
  ) {
    throw new TypeError('Read projection returned an invalid content envelope.');
  }
  const content = projected.contents[0] as Readonly<Record<string, unknown>>;
  const text = content.text;
  if (typeof text !== 'string') {
    throw new TypeError('Read projection returned non-text content.');
  }
  return JSON.parse(text) as unknown;
}

function readOwnedProjection(
  options: Phase4bMcpReadToolAdapterOptions,
  name: 'collectionProjection' | 'snapshotProjection' | 'nodeProjection',
):
  | Phase4bMcpCollectionResourceProjection
  | Phase4bMcpSnapshotResourceProjection
  | Phase4bMcpNodeResourceProjection
{
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('P4B-R12 Tool adapter options are required.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, name);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`P4B-R12 Tool adapter requires ${name}.`);
  }
  const projection = descriptor.value;
  if (typeof projection !== 'object' || projection === null) {
    throw new TypeError(`P4B-R12 Tool adapter ${name} must be an object.`);
  }
  return projection as
    | Phase4bMcpCollectionResourceProjection
    | Phase4bMcpSnapshotResourceProjection
    | Phase4bMcpNodeResourceProjection;
}

function readOptionalOwnedRead(
  options: Phase4bMcpReadToolAdapterOptions,
): Phase4bMcpOwnedCollectionReadPort | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'ownedRead');
  if (descriptor === undefined || !('value' in descriptor) || descriptor.value === undefined) {
    return undefined;
  }
  const port = descriptor.value;
  if (typeof port !== 'object' || port === null) {
    throw new TypeError('P4B-R12 Tool adapter ownedRead must be an object.');
  }
  return port as Phase4bMcpOwnedCollectionReadPort;
}

function readOwnedServerUuid(options: Phase4bMcpReadToolAdapterOptions): string {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'serverUuid');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') {
    throw new TypeError('P4B-R12 Tool adapter requires serverUuid.');
  }
  const serverUuid = descriptor.value;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(serverUuid)) {
    throw new TypeError('P4B-R12 Tool adapter serverUuid must be a lowercase UUID.');
  }
  return serverUuid;
}
