import {
  createCollectionsGetSnapshotTool,
  type CollectionSnapshotLinkApplicationServicePort,
} from './collections-get-snapshot.js';
import {
  createMcpToolInputValidator,
  type McpToolInputSchema,
} from './tool-input.js';
import { snapshotMcpData } from './safe-data.js';
import { createCanonicalMcpSchemaReference } from './schema-ref.js';
import type { McpTrustedReadRequestContext } from './shared/resources.js';
import { requireTrustedReadRequestContext } from './shared/resources.js';
import {
  createMcpStatelessToolCore,
  McpToolOutputUnavailableError,
  type McpReadToolResult,
  type McpStatelessToolCore,
  type McpToolDefinition,
  type McpToolRegistration,
} from './shared/tools.js';

export {
  McpInvalidToolNameError,
  McpToolOutputUnavailableError,
  McpUnknownToolError,
  type McpReadToolResult,
  type McpToolDefinition,
} from './shared/tools.js';

export interface CollectionReadApplicationServicePort {
  readonly getCollection: (
    input: Readonly<{ collectionId: string }>,
    context: McpTrustedReadRequestContext,
  ) => unknown | PromiseLike<unknown>;
}

export interface CollectionsGetTool {
  readonly definition: McpToolDefinition & { readonly name: 'collections.get' };
  readonly invoke: (
    input: unknown,
    context: McpTrustedReadRequestContext,
  ) => Promise<McpReadToolResult>;
}

/**
 * Optional gateway registration for `collections.get_snapshot`.
 * When omitted, the gateway publishes only `collections.get` (default).
 */
export interface McpReadToolGatewayOptions {
  readonly snapshotLink?: {
    readonly manifest: Readonly<{ serverUuid: string }>;
    readonly applicationService: CollectionSnapshotLinkApplicationServicePort;
  };
}

/**
 * Stateless read Tool gateway. `callTool` re-accepts a per-request trusted
 * read context (authorization binding, scope, budget and abort signal) and
 * never retains request-scoped state; the underlying shared Tool core serves
 * concurrent requests without hidden per-client instances.
 */
export interface McpReadToolGateway {
  readonly listTools: () => readonly McpToolDefinition[];
  readonly callTool: (
    name: string,
    input: unknown,
    context: McpTrustedReadRequestContext,
  ) => Promise<McpReadToolResult>;
}

const collectionIdSchema = createCanonicalMcpSchemaReference('opaqueId');

const collectionsGetInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ collectionId: collectionIdSchema }),
  required: Object.freeze(['collectionId']),
} as const satisfies McpToolInputSchema);

export const collectionsGetToolDefinition = Object.freeze({
  name: 'collections.get',
  description: 'Get metadata for one Collection.',
  inputSchema: collectionsGetInputSchema,
} as const satisfies McpToolDefinition);

const validateCollectionsGetInput = createMcpToolInputValidator(collectionsGetInputSchema);

/**
 * Creates the read Tool execution registration; authorization and business
 * lookup remain in the application port. The port must own `getCollection` as
 * an own data function (not an inherited / class-prototype method). Prefer
 * `{ getCollection }` literals or `{ getCollection: service.getCollection.bind(service) }`.
 */
export function createCollectionsGetTool(
  port: CollectionReadApplicationServicePort,
): CollectionsGetTool {
  const service = readCollectionReadService(port);

  const invoke = async (
    input: unknown,
    context: McpTrustedReadRequestContext,
  ): Promise<McpReadToolResult> => {
    const trustedContext = requireTrustedReadRequestContext(context);
    const validated = validateCollectionsGetInput(input);
    const collectionId = validated.collectionId as string;
    try {
      const projected = await Reflect.apply(service.method, service.receiver, [
        Object.freeze({ collectionId }),
        trustedContext,
      ]);
      const structuredContent = snapshotMcpData(projected);
      return Object.freeze({ structuredContent });
    } catch {
      throw new McpToolOutputUnavailableError();
    }
  };

  return Object.freeze({
    definition: collectionsGetToolDefinition,
    invoke,
  });
}

/**
 * Exposes the stateless read Tool gateway: always `collections.get`, and
 * optionally `collections.get_snapshot` when `options.snapshotLink` is an
 * own-data configuration object.
 */
export function createMcpReadToolGateway(
  port: CollectionReadApplicationServicePort,
  options?: McpReadToolGatewayOptions,
): McpReadToolGateway {
  if (arguments.length > 2) {
    throw new TypeError('createMcpReadToolGateway accepts at most a port and options object.');
  }

  const registrations: McpToolRegistration[] = [];
  const collectionsGet = createCollectionsGetTool(port);
  registrations.push({ definition: collectionsGet.definition, invoke: collectionsGet.invoke });

  const snapshotLink = readOptionalSnapshotLink(options);
  if (snapshotLink !== undefined) {
    const snapshotTool = createCollectionsGetSnapshotTool(
      snapshotLink.manifest,
      snapshotLink.applicationService,
    );
    registrations.push({ definition: snapshotTool.definition, invoke: snapshotTool.invoke });
  }

  const core: McpStatelessToolCore = createMcpStatelessToolCore({ tools: registrations });
  return Object.freeze({
    listTools: core.listTools,
    callTool: (name: string, input: unknown, context: McpTrustedReadRequestContext) =>
      core.callTool(context, name, input),
  });
}

function readCollectionReadService(port: CollectionReadApplicationServicePort): {
  readonly receiver: object;
  readonly method: CollectionReadApplicationServicePort['getCollection'];
} {
  if (typeof port !== 'object' || port === null) {
    throw new TypeError('createCollectionsGetTool requires a Collection read application service.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(port, 'getCollection');
  if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'function') {
    throw new TypeError(
      'The Collection read application service must own getCollection as a data function '
        + '(class prototype methods are rejected; bind or wrap as an own property).',
    );
  }
  return Object.freeze({ receiver: port, method: descriptor.value });
}

function readOptionalSnapshotLink(
  options: McpReadToolGatewayOptions | undefined,
): McpReadToolGatewayOptions['snapshotLink'] | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('createMcpReadToolGateway options must be an own-data object when provided.');
  }

  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => typeof key !== 'string') || keys.some((key) => key !== 'snapshotLink')) {
    throw new TypeError(
      'createMcpReadToolGateway options may only own an optional snapshotLink data property.',
    );
  }

  const descriptor = Object.getOwnPropertyDescriptor(options, 'snapshotLink');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor) || descriptor.enumerable !== true) {
    throw new TypeError('snapshotLink must be an own enumerable data property.');
  }
  if (descriptor.value === undefined) return undefined;

  const snapshotLink = descriptor.value;
  if (typeof snapshotLink !== 'object' || snapshotLink === null) {
    throw new TypeError('snapshotLink must be an own-data object.');
  }
  const snapshotKeys = Reflect.ownKeys(snapshotLink);
  if (
    snapshotKeys.length !== 2
    || !snapshotKeys.includes('manifest')
    || !snapshotKeys.includes('applicationService')
    || snapshotKeys.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError(
      'snapshotLink must own exactly manifest and applicationService data properties.',
    );
  }

  const manifestDescriptor = Object.getOwnPropertyDescriptor(snapshotLink, 'manifest');
  const serviceDescriptor = Object.getOwnPropertyDescriptor(snapshotLink, 'applicationService');
  if (
    manifestDescriptor === undefined
    || !('value' in manifestDescriptor)
    || serviceDescriptor === undefined
    || !('value' in serviceDescriptor)
  ) {
    throw new TypeError(
      'snapshotLink must own exactly manifest and applicationService data properties.',
    );
  }

  return Object.freeze({
    manifest: manifestDescriptor.value as Readonly<{ serverUuid: string }>,
    applicationService: serviceDescriptor.value as CollectionSnapshotLinkApplicationServicePort,
  });
}
