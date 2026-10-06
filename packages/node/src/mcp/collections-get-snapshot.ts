import { isRfc3339DateTime } from '../shared/date-time.js';
import type { Manifest } from '../types/index.js';
import type { McpToolDefinition } from './collections-get.js';
import { createMcpResourceUriCodec } from './resource-uri.js';
import { createCanonicalMcpSchemaReference } from './schema-ref.js';
import {
  createMcpToolInputValidator,
  McpToolInputError,
  type McpToolInputSchema,
} from './tool-input.js';
import type { McpTrustedReadRequestContext } from './shared/resources.js';
import { requireTrustedReadRequestContext } from './shared/resources.js';

export interface CollectionSnapshotLinkMetadata {
  readonly name: string;
  readonly lastModified: string;
}

export interface CollectionSnapshotLinkApplicationServicePort {
  /** Returns only already-authorized metadata needed to describe the snapshot link. */
  readonly getCollectionSnapshotLinkMetadata: (
    input: Readonly<{ collectionId: string }>,
    context: McpTrustedReadRequestContext,
  ) => CollectionSnapshotLinkMetadata | PromiseLike<CollectionSnapshotLinkMetadata>;
}

/** Default MCP Resource Link presentation annotations for collection snapshots. */
export const DEFAULT_SNAPSHOT_LINK_ANNOTATIONS = Object.freeze({
  audience: Object.freeze(['user', 'assistant'] as const),
  priority: 0.8 as const,
});

export interface McpSnapshotResourceLink {
  readonly type: 'resource_link';
  readonly uri: string;
  readonly name: string;
  readonly mimeType: 'application/vnd.collection-protocol.snapshot+json';
  readonly annotations: {
    readonly audience: typeof DEFAULT_SNAPSHOT_LINK_ANNOTATIONS.audience;
    readonly priority: typeof DEFAULT_SNAPSHOT_LINK_ANNOTATIONS.priority;
    readonly lastModified: string;
  };
}

export interface CollectionsGetSnapshotToolResult {
  readonly content: readonly [McpSnapshotResourceLink];
}

export interface CollectionsGetSnapshotTool {
  readonly definition: McpToolDefinition & {
    readonly name: 'collections.get_snapshot';
  };
  readonly invoke: (
    input: unknown,
    context: McpTrustedReadRequestContext,
  ) => Promise<CollectionsGetSnapshotToolResult>;
}

export class McpSnapshotLinkUnavailableError extends Error {
  readonly code = 'snapshot_link_unavailable' as const;

  constructor() {
    super('Collection snapshot link is unavailable.');
    this.name = 'McpSnapshotLinkUnavailableError';
  }
}

const collectionIdSchema = createCanonicalMcpSchemaReference('opaqueId');

const collectionsGetSnapshotInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ collectionId: collectionIdSchema }),
  required: Object.freeze(['collectionId']),
} as const satisfies McpToolInputSchema);

export const collectionsGetSnapshotToolDefinition = Object.freeze({
  name: 'collections.get_snapshot',
  description: 'Get a Resource Link for one authorized Collection snapshot.',
  inputSchema: collectionsGetSnapshotInputSchema,
} as const satisfies McpToolDefinition);

const validateCollectionsGetSnapshotInput = createMcpToolInputValidator(
  collectionsGetSnapshotInputSchema,
);

/**
 * Creates a read-only link Tool. The application service authorizes the request and
 * projects link metadata without loading a Snapshot body or access-control state.
 * Every invocation re-accepts the current per-request trusted read context.
 */
export function createCollectionsGetSnapshotTool(
  manifest: Pick<Manifest, 'serverUuid'>,
  port: CollectionSnapshotLinkApplicationServicePort,
): CollectionsGetSnapshotTool {
  const uriCodec = createMcpResourceUriCodec(readManifestIdentity(manifest));
  const service = readSnapshotLinkService(port);

  const invoke = async (
    input: unknown,
    context: McpTrustedReadRequestContext,
  ): Promise<CollectionsGetSnapshotToolResult> => {
    const trustedContext = requireTrustedReadRequestContext(context);
    const validated = validateCollectionsGetSnapshotInput(input);
    const collectionId = validated.collectionId as string;
    if (collectionId === '.' || collectionId === '..') {
      throw new McpToolInputError([Object.freeze({
        instancePath: '/collectionId',
        keyword: 'mcpResourcePath',
        message: 'must not be a relative path segment',
      })]);
    }
    const uri = uriCodec.collectionSnapshot(collectionId);

    try {
      const metadata = await Reflect.apply(service.method, service.receiver, [
        Object.freeze({ collectionId }),
        trustedContext,
      ]) as CollectionSnapshotLinkMetadata;
      const projected = projectLinkMetadata(metadata);
      const annotations = Object.freeze({
        audience: DEFAULT_SNAPSHOT_LINK_ANNOTATIONS.audience,
        priority: DEFAULT_SNAPSHOT_LINK_ANNOTATIONS.priority,
        lastModified: projected.lastModified,
      });
      const link = Object.freeze({
        type: 'resource_link' as const,
        uri,
        name: projected.name,
        mimeType: 'application/vnd.collection-protocol.snapshot+json' as const,
        annotations,
      });
      return Object.freeze({ content: Object.freeze([link] as const) });
    } catch {
      throw new McpSnapshotLinkUnavailableError();
    }
  };

  return Object.freeze({
    definition: collectionsGetSnapshotToolDefinition,
    invoke,
  });
}

function readManifestIdentity(
  manifest: Pick<Manifest, 'serverUuid'>,
): Pick<Manifest, 'serverUuid'> {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new TypeError('A Manifest identity is required.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(manifest, 'serverUuid');
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError('Manifest must own serverUuid as a data property.');
  }
  return Object.freeze({ serverUuid: descriptor.value as Manifest['serverUuid'] });
}

function readSnapshotLinkService(port: CollectionSnapshotLinkApplicationServicePort): {
  readonly receiver: object;
  readonly method: CollectionSnapshotLinkApplicationServicePort['getCollectionSnapshotLinkMetadata'];
} {
  if (typeof port !== 'object' || port === null) {
    throw new TypeError('A snapshot link application service is required.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    port,
    'getCollectionSnapshotLinkMetadata',
  );
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError(
      'The snapshot link application service must own getCollectionSnapshotLinkMetadata as a data function.',
    );
  }
  return Object.freeze({ receiver: port, method: descriptor.value });
}

function projectLinkMetadata(metadata: CollectionSnapshotLinkMetadata): CollectionSnapshotLinkMetadata {
  if (typeof metadata !== 'object' || metadata === null) throw new TypeError();
  const name = readOwnDataProperty(metadata, 'name');
  const lastModified = readOwnDataProperty(metadata, 'lastModified');
  if (typeof name !== 'string' || name.length === 0) throw new TypeError();
  if (typeof lastModified !== 'string' || !isRfc3339DateTime(lastModified)) throw new TypeError();
  return Object.freeze({ name, lastModified });
}

function readOwnDataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (descriptor === undefined || !('value' in descriptor)) throw new TypeError();
  return descriptor.value;
}
