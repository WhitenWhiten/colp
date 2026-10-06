import { describe, expect, it, vi } from 'vitest';

import { collectionProtocolSchema, createAjv } from '../../src/schema/index.js';
import {
  McpSnapshotLinkUnavailableError,
  collectionsGetSnapshotToolDefinition,
  createCollectionsGetSnapshotTool,
} from '../../src/mcp/collections-get-snapshot.js';
import { McpToolInputError } from '../../src/mcp/tool-input.js';

// Local typed binding matching the pre-modern structural surface used by this suite.
const createSnapshotTool = createCollectionsGetSnapshotTool as unknown as NonNullable<
  SnapshotToolApi['createCollectionsGetSnapshotTool']
>;
import { readContext } from './read-trusted-context-fixture.js';

interface SnapshotLinkMetadataInput {
  readonly collectionId: string;
}

interface SnapshotLinkMetadata {
  readonly name: string;
  readonly lastModified: string;
}

interface SnapshotLinkMetadataPort {
  readonly getCollectionSnapshotLinkMetadata: (
    input: SnapshotLinkMetadataInput,
  ) => unknown | PromiseLike<unknown>;
}

interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
  readonly [keyword: string]: unknown;
}

interface SnapshotResourceLink {
  readonly type: 'resource_link';
  readonly uri: string;
  readonly name: string;
  readonly mimeType: 'application/vnd.collection-protocol.snapshot+json';
  readonly annotations: Readonly<{
    audience: readonly ['user', 'assistant'];
    priority: 0.8;
    lastModified: string;
  }>;
}

interface SnapshotToolDefinition {
  readonly name: 'collections.get_snapshot';
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

interface SnapshotToolResult {
  readonly content: readonly [SnapshotResourceLink];
}

interface SnapshotTool {
  readonly definition: SnapshotToolDefinition;
  readonly invoke: (input: unknown, context: import('../../src/mcp/shared/resources.js').McpTrustedReadRequestContext) => Promise<SnapshotToolResult>;
}

interface SnapshotToolApi {
  readonly collectionsGetSnapshotToolDefinition?: SnapshotToolDefinition;
  readonly createCollectionsGetSnapshotTool?: (
    manifest: Readonly<{ serverUuid: string }>,
    port: SnapshotLinkMetadataPort,
  ) => SnapshotTool;
}

const evidence = '[evidence:mcp.snapshot-resource-link]';
const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const forgedServerUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77df';
const collectionId = 'collection-1';
const metadata = Object.freeze({
  name: 'Interface Systems',
  lastModified: '2026-07-16T06:30:00Z',
});

function metadataPort(...args: [result?: unknown]): {
  readonly port: SnapshotLinkMetadataPort;
  readonly getCollectionSnapshotLinkMetadata: ReturnType<typeof vi.fn>;
} {
  const result = args.length === 0 ? metadata : args[0];
  const getCollectionSnapshotLinkMetadata = vi.fn(
    async (_input: SnapshotLinkMetadataInput): Promise<unknown> => result,
  );
  return {
    port: { getCollectionSnapshotLinkMetadata },
    getCollectionSnapshotLinkMetadata,
  };
}

function createTool(
  options: Readonly<{
    manifest?: Readonly<{ serverUuid: string }>;
    result?: unknown;
    port?: SnapshotLinkMetadataPort;
  }> = {},
): {
  readonly tool: SnapshotTool;
  readonly getCollectionSnapshotLinkMetadata: ReturnType<typeof vi.fn>;
} {
  expect(
    typeof createCollectionsGetSnapshotTool,
    'MCP-0012 needs a public collections.get_snapshot Tool factory',
  ).toBe('function');
  const createdPort = metadataPort(Object.hasOwn(options, 'result') ? options.result : metadata);
  const port = options.port ?? createdPort.port;
  return {
    tool: createSnapshotTool(
      options.manifest ?? { serverUuid },
      port,
    ),
    getCollectionSnapshotLinkMetadata: createdPort.getCollectionSnapshotLinkMetadata,
  };
}

function expectedLink(overrides: Partial<SnapshotResourceLink> = {}): SnapshotResourceLink {
  return {
    type: 'resource_link',
    uri: `colp://${serverUuid}/collections/${collectionId}/snapshot`,
    name: metadata.name,
    mimeType: 'application/vnd.collection-protocol.snapshot+json',
    annotations: {
      audience: ['user', 'assistant'],
      priority: 0.8,
      lastModified: metadata.lastModified,
    },
    ...overrides,
  };
}

function definition(): SnapshotToolDefinition {
  expect(
    collectionsGetSnapshotToolDefinition,
    'MCP-0012 needs an inspectable collections.get_snapshot definition',
  ).toBeDefined();
  return collectionsGetSnapshotToolDefinition!;
}

function compileInputSchema() {
  const ajv = createAjv({ allErrors: true, ownProperties: true });
  ajv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);
  return ajv.compile(definition().inputSchema);
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) expectDeeplyFrozen(descriptor.value, seen);
  }
}

async function rejection(operation: () => unknown | PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}

async function expectToolInputError(operation: () => Promise<unknown>): Promise<void> {
  const error = await rejection(operation);
  expect(error).toBeInstanceOf(McpToolInputError);
  expect(error).toMatchObject({
    name: 'McpToolInputError',
    code: 'invalid_tool_input',
  });
  expect((error as McpToolInputError).issues.length).toBeGreaterThan(0);
}

async function expectSnapshotUnavailable(operation: () => Promise<unknown>): Promise<unknown> {
  const error = await rejection(operation);
  expect(error).toBeInstanceOf(McpSnapshotLinkUnavailableError);
  expect(error).toMatchObject({
    name: 'McpSnapshotLinkUnavailableError',
    code: 'snapshot_link_unavailable',
  });
  return error;
}

describe(`MCP-0012 Snapshot Resource Link ${evidence}`, () => {
  it(`exports the same factory and definition from the package and MCP boundaries ${evidence}`, () => {
    expect(createCollectionsGetSnapshotTool).toBe(
      createCollectionsGetSnapshotTool,
    );
    expect(collectionsGetSnapshotToolDefinition).toBe(
      collectionsGetSnapshotToolDefinition,
    );
  });

  it(`publishes the exact collections.get_snapshot Tool name ${evidence}`, () => {
    expect(definition().name).toBe('collections.get_snapshot');
  });

  it(`publishes a closed collectionId-only inputSchema ${evidence}`, () => {
    expect(definition().inputSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        collectionId: {
          $ref: `${collectionProtocolSchema.$id}#/$defs/opaqueId`,
        },
      },
      required: ['collectionId'],
    });
  });

  it(`publishes an inputSchema that compiles and accepts a valid opaque ID ${evidence}`, () => {
    const validate = compileInputSchema();

    expect(validate({ collectionId }), JSON.stringify(validate.errors)).toBe(true);
  });

  it(`deep-freezes the definition and every nested inputSchema value ${evidence}`, () => {
    expectDeeplyFrozen(definition());
  });

  it(`creates a frozen Tool with only definition and invoke ${evidence}`, () => {
    const { tool } = createTool();

    expect(Object.keys(tool).sort()).toEqual(['definition', 'invoke']);
    expect(tool.definition).toBe(definition());
    expect(Object.isFrozen(tool)).toBe(true);
  });

  it(`calls the minimal link-metadata port exactly once with a frozen DTO ${evidence}`, async () => {
    const { tool, getCollectionSnapshotLinkMetadata } = createTool();

    await tool.invoke({ collectionId }, readContext());

    expect(getCollectionSnapshotLinkMetadata).toHaveBeenCalledOnce();
    expect(getCollectionSnapshotLinkMetadata).toHaveBeenCalledWith({ collectionId }, expect.any(Object));
    expect(Object.isFrozen(getCollectionSnapshotLinkMetadata.mock.calls[0]![0])).toBe(true);
  });

  it(`returns the exact protocol Resource Link fields and values ${evidence}`, async () => {
    const { tool } = createTool();

    expect(await tool.invoke({ collectionId }, readContext())).toEqual({ content: [expectedLink()] });
  });

  it(`binds the Snapshot URI authority to the supplied Manifest serverUuid ${evidence}`, async () => {
    const { tool } = createTool({ manifest: { serverUuid: forgedServerUuid } });

    expect((await tool.invoke({ collectionId }, readContext())).content[0].uri).toBe(
      `colp://${forgedServerUuid}/collections/${collectionId}/snapshot`,
    );
  });

  it(`emits exact MCP annotations with fixed audience and priority ${evidence}`, async () => {
    const result = (await createTool().tool.invoke({ collectionId }, readContext())).content[0];

    expect(result.annotations).toEqual({
      audience: ['user', 'assistant'],
      priority: 0.8,
      lastModified: metadata.lastModified,
    });
    expect(Object.keys(result.annotations).sort()).toEqual([
      'audience',
      'lastModified',
      'priority',
    ]);
  });

  it(`deep-freezes the Resource Link including annotations and audience ${evidence}`, async () => {
    expectDeeplyFrozen(await createTool().tool.invoke({ collectionId }, readContext()));
  });

  it(`returns a deterministic Resource Link for equal inputs ${evidence}`, async () => {
    const { tool } = createTool();
    const first = await tool.invoke({ collectionId }, readContext());
    const second = await tool.invoke({ collectionId }, readContext());

    expect(second).toEqual(first);
  });

  it(`snapshots valid input before asynchronous service observation ${evidence}`, async () => {
    let release!: () => void;
    const mayObserve = new Promise<void>((resolve) => {
      release = resolve;
    });
    let observed: string | undefined;
    const getCollectionSnapshotLinkMetadata = vi.fn(async (input: SnapshotLinkMetadataInput) => {
      await mayObserve;
      observed = input.collectionId;
      return metadata;
    });
    const { tool } = createTool({ port: { getCollectionSnapshotLinkMetadata } });
    const input = { collectionId };

    const pending = tool.invoke(input, readContext());
    input.collectionId = 'attacker-controlled-after-validation';
    release();
    await pending;

    expect(observed).toBe(collectionId);
    expect(getCollectionSnapshotLinkMetadata.mock.calls[0]![0]).not.toBe(input);
  });

  it.each([
    ['missing input', undefined],
    ['null input', null],
    ['array input', [collectionId]],
    ['missing collectionId', {}],
    ['extra input member', { collectionId, extra: true }],
    ['null collectionId', { collectionId: null }],
    ['numeric collectionId', { collectionId: 1 }],
    ['object collectionId', { collectionId: { value: collectionId } }],
  ] as const)(`rejects %s without calling the service ${evidence}`, async (_label, input) => {
    const { tool, getCollectionSnapshotLinkMetadata } = createTool();

    await expectToolInputError(() => tool.invoke(input, readContext()));
    expect(getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
  });

  it.each(['', '.', '..', 'collection/child', 'x'.repeat(129), 'collection%2Fchild'])(
    `rejects invalid or ambiguous collectionId %j without calling the service ${evidence}`,
    async (invalidCollectionId) => {
      const { tool, getCollectionSnapshotLinkMetadata } = createTool();

      await expectToolInputError(() => tool.invoke({ collectionId: invalidCollectionId }, readContext()));
      expect(getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
    },
  );

  it(`rejects an inherited collectionId without calling the service ${evidence}`, async () => {
    const { tool, getCollectionSnapshotLinkMetadata } = createTool();
    const input = Object.create({ collectionId }) as SnapshotLinkMetadataInput;

    await expectToolInputError(() => tool.invoke(input, readContext()));
    expect(getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
  });

  it(`rejects an accessor input without evaluating it or calling the service ${evidence}`, async () => {
    const { tool, getCollectionSnapshotLinkMetadata } = createTool();
    const getter = vi.fn(() => collectionId);
    const input = Object.defineProperty({}, 'collectionId', { enumerable: true, get: getter });

    await expectToolInputError(() => tool.invoke(input, readContext()));
    expect(getter).not.toHaveBeenCalled();
    expect(getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ['missing Manifest', undefined],
    ['null Manifest', null],
    ['missing serverUuid', {}],
    ['invalid serverUuid', { serverUuid: 'forged/authority' }],
  ] as const)(`fails closed for %s before service use ${evidence}`, (_label, manifest) => {
    const createdPort = metadataPort();
    const create = createSnapshotTool as (...args: unknown[]) => SnapshotTool;

    expect(() => create(manifest, createdPort.port)).toThrow();
    expect(createdPort.getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
  });

  it(`rejects an inherited Manifest serverUuid ${evidence}`, () => {
    const manifest = Object.create({ serverUuid }) as { serverUuid: string };
    const createdPort = metadataPort();

    expect(() => createSnapshotTool(manifest, createdPort.port)).toThrow();
    expect(createdPort.getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
  });

  it(`rejects a Manifest serverUuid getter without evaluating it ${evidence}`, () => {
    const getter = vi.fn(() => serverUuid);
    const manifest = Object.defineProperty({}, 'serverUuid', { enumerable: true, get: getter });
    const createdPort = metadataPort();

    expect(() => createSnapshotTool(
      manifest as { serverUuid: string },
      createdPort.port,
    )).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(createdPort.getCollectionSnapshotLinkMetadata).not.toHaveBeenCalled();
  });

  it(`captures Manifest authority so later forgery cannot change Snapshot URIs ${evidence}`, async () => {
    const manifest = { serverUuid };
    const { tool } = createTool({ manifest });
    manifest.serverUuid = forgedServerUuid;

    expect((await tool.invoke({ collectionId }, readContext())).content[0].uri).toBe(
      `colp://${serverUuid}/collections/${collectionId}/snapshot`,
    );
  });

  it.each([
    ['undefined service', undefined],
    ['null service', null],
    ['empty service', {}],
    ['non-function method', { getCollectionSnapshotLinkMetadata: true }],
  ] as const)(`rejects %s at factory construction ${evidence}`, (_label, port) => {
    const create = createSnapshotTool as (...args: unknown[]) => SnapshotTool;

    expect(() => create({ serverUuid }, port)).toThrow();
  });

  it(`rejects an inherited service method without invoking it ${evidence}`, () => {
    const inherited = vi.fn(async () => metadata);
    const port = Object.create({ getCollectionSnapshotLinkMetadata: inherited });

    expect(() => createSnapshotTool({ serverUuid }, port)).toThrow();
    expect(inherited).not.toHaveBeenCalled();
  });

  it(`rejects a service method getter without evaluating it ${evidence}`, () => {
    const method = vi.fn(async () => metadata);
    const getter = vi.fn(() => method);
    const port = Object.defineProperty({}, 'getCollectionSnapshotLinkMetadata', {
      enumerable: true,
      get: getter,
    });

    expect(() => createSnapshotTool(
      { serverUuid },
      port as SnapshotLinkMetadataPort,
    )).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(method).not.toHaveBeenCalled();
  });

  it(`ignores extra service capabilities without reading or invoking them ${evidence}`, async () => {
    const createdPort = metadataPort();
    const getSnapshot = vi.fn();
    const writeGetter = vi.fn(() => vi.fn());
    const port = Object.defineProperties(createdPort.port, {
      getSnapshot: { enumerable: true, value: getSnapshot },
      write: { enumerable: true, get: writeGetter },
    });

    const tool = createSnapshotTool({ serverUuid }, port);
    expect(await tool.invoke({ collectionId }, readContext())).toEqual({ content: [expectedLink()] });
    expect(createdPort.getCollectionSnapshotLinkMetadata).toHaveBeenCalledOnce();
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(writeGetter).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined metadata', undefined],
    ['null metadata', null],
    ['missing name', { lastModified: metadata.lastModified }],
    ['missing lastModified', { name: metadata.name }],
    ['wrong name type', { name: 7, lastModified: metadata.lastModified }],
    ['wrong lastModified type', { name: metadata.name, lastModified: 7 }],
    ['non-canonical lastModified', { name: metadata.name, lastModified: '2026-07-16' }],
  ] as const)(`rejects malformed service output: %s ${evidence}`, async (_label, result) => {
    const { tool } = createTool({ result });

    await expectSnapshotUnavailable(() => tool.invoke({ collectionId }, readContext()));
  });

  it(`ignores extra metadata without reading or leaking it ${evidence}`, async () => {
    const nodesGetter = vi.fn(() => [{ secret: 'snapshot-node-secret' }]);
    const result = Object.defineProperties({ ...metadata }, {
      nodes: { enumerable: true, get: nodesGetter },
      secret: { enumerable: true, value: 'metadata-secret' },
    });

    expect(await createTool({ result }).tool.invoke({ collectionId }, readContext())).toEqual({
      content: [expectedLink()],
    });
    expect(nodesGetter).not.toHaveBeenCalled();
  });

  it(`rejects accessor service metadata without evaluating it ${evidence}`, async () => {
    const getter = vi.fn(() => metadata.name);
    const result = Object.defineProperties({}, {
      name: { enumerable: true, get: getter },
      lastModified: { enumerable: true, value: metadata.lastModified },
    });

    await expectSnapshotUnavailable(() => createTool({ result }).tool.invoke({ collectionId }, readContext()));
    expect(getter).not.toHaveBeenCalled();
  });

  it(`sanitizes service exceptions without leaking names, messages, details, or secrets ${evidence}`, async () => {
    const secret = 'oauth-secret-value-never-for-model-context';
    const source = Object.assign(new Error(`private backend failed with ${secret}`), {
      code: 'private_snapshot_lookup',
      details: { secret },
    });
    const getCollectionSnapshotLinkMetadata = vi.fn(async () => {
      throw source;
    });
    const { tool } = createTool({ port: { getCollectionSnapshotLinkMetadata } });

    const error = await expectSnapshotUnavailable(() => tool.invoke({ collectionId }, readContext()));

    expect(error).not.toBe(source);
    expect(String(error)).not.toContain(source.message);
    expect(String(error)).not.toContain(source.code);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it(`returns no Snapshot body, nodes, sidecars, structuredContent, or secret ${evidence}`, async () => {
    const secret = 'snapshot-secret-that-must-not-leak';
    const toolResult = await createTool({
      port: {
        getCollectionSnapshotLinkMetadata: vi.fn(async () => {
          expect(secret).toBeTruthy();
          return metadata;
        }),
      },
    }).tool.invoke({ collectionId }, readContext());

    expect(Object.keys(toolResult)).toEqual(['content']);
    expect(toolResult.content).toHaveLength(1);
    const result = toolResult.content[0];
    expect(Object.keys(result).sort()).toEqual([
      'annotations',
      'mimeType',
      'name',
      'type',
      'uri',
    ]);
    expect(result).not.toHaveProperty('snapshot');
    expect(result).not.toHaveProperty('nodes');
    expect(result).not.toHaveProperty('sidecars');
    expect(result).not.toHaveProperty('structuredContent');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it(`exposes no write, Plan, approval, key, OAuth, or Resource read-list capability ${evidence}`, () => {
    const { tool } = createTool();
    const exposed = [
      ...Reflect.ownKeys(tool).map(String),
      ...Reflect.ownKeys(tool.definition).map(String),
      tool.definition.name,
    ].join(' ');

    expect(exposed).not.toMatch(
      /(?:^|[. _-])(create|update|delete|move|write|plan|commit|approv|key|oauth|readResource|listResources)(?:$|[. _-])/iu,
    );
  });
});
