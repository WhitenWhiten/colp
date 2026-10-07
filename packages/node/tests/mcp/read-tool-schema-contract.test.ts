import { describe, expect, it, vi } from 'vitest';

import { collectionProtocolSchema, createAjv } from '../../src/schema/index.js';
import { createCollectionsGetTool, createMcpReadToolGateway } from '../../src/mcp/collections-get.js';
import { createMcpToolInputValidator, McpToolInputError } from '../../src/mcp/tool-input.js';
import { McpInvalidToolNameError, McpUnknownToolError } from '../../src/mcp/shared/tools.js';
import { readContext } from './read-trusted-context-fixture.js';

interface CollectionGetInput {
  readonly collectionId: string;
}

interface McpReadApplicationService {
  readonly getCollection: (input: CollectionGetInput) => Promise<unknown>;
}

interface McpToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly [keyword: string]: unknown;
}

interface McpReadToolDefinition {
  readonly name: string;
  readonly inputSchema: McpToolInputSchema;
}

interface McpReadToolResult {
  readonly structuredContent: unknown;
  readonly [field: string]: unknown;
}

interface McpReadToolGateway {
  readonly listTools: () => readonly McpReadToolDefinition[];
  readonly callTool: (name: string, input: unknown, context: import('../../src/mcp/shared/resources.js').McpTrustedReadRequestContext) => Promise<McpReadToolResult>;
}

const collectionId = 'collection-1';
const collectionMetadata = Object.freeze({
  id: collectionId,
  title: 'Read-only collection',
  visibility: 'private',
});

async function expectToolInputError(operation: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(McpToolInputError);
  expect(caught).toMatchObject({
    name: 'McpToolInputError',
    code: 'invalid_tool_input',
  });
  expect((caught as McpToolInputError).issues.length).toBeGreaterThan(0);
}

function createGateway(
  getCollection = vi.fn(async (_input: CollectionGetInput): Promise<unknown> => collectionMetadata),
): { readonly gateway: McpReadToolGateway; readonly getCollection: typeof getCollection } {
  expect(
    typeof createMcpReadToolGateway,
    'MCP-0002 needs a public read-only Tool gateway backed by an application-service port',
  ).toBe('function');
  return {
    gateway: createMcpReadToolGateway({ getCollection }) as McpReadToolGateway,
    getCollection,
  };
}

function collectionGetDefinition(gateway: McpReadToolGateway): McpReadToolDefinition {
  const definitions = gateway.listTools();
  const definition = definitions.find(({ name }) => name === 'collections.get');

  expect(definition, 'collections.get must publish its inputSchema').toBeDefined();
  return definition!;
}

function compilePublishedInputSchema(gateway: McpReadToolGateway) {
  const ajv = createAjv();
  ajv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);
  return ajv.compile(collectionGetDefinition(gateway).inputSchema);
}

describe('MCP-0002 read Tool public contract [evidence:mcp.tool-schema]', () => {
  it('exports a frozen read-only gateway with one actual collections.get Tool [evidence:mcp.tool-schema]', () => {
    const { gateway } = createGateway();
    const definitions = gateway.listTools();

    expect(typeof createMcpReadToolGateway).toBe('function');
    expect(Object.keys(gateway).sort()).toEqual(['callTool', 'listTools']);
    expect(Object.isFrozen(gateway)).toBe(true);
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.name).toBe('collections.get');
    expect(Object.isFrozen(definitions)).toBe(true);
  });

  it('rejects a Collection read port whose getCollection is only inherited [evidence:mcp.tool-schema]', () => {
    const inherited = Object.create({
      getCollection: async () => collectionMetadata,
    }) as McpReadApplicationService;

    expect(typeof createCollectionsGetTool).toBe('function');
    expect(() => createCollectionsGetTool(inherited)).toThrow(/own getCollection/i);
    expect(() => createCollectionsGetTool(inherited)).toThrow(/class prototype methods/i);
    expect(() => createMcpReadToolGateway(inherited)).toThrow(/own getCollection/i);
  });

  it('publishes a closed JSON Schema for the collections.get input [evidence:mcp.tool-schema]', () => {
    const { gateway } = createGateway();
    const definition = collectionGetDefinition(gateway);
    const { inputSchema } = definition;

    expect(inputSchema).toMatchObject({
      type: 'object',
      properties: {
        collectionId: {
          $ref: `${collectionProtocolSchema.$id}#/$defs/opaqueId`,
        },
      },
      required: ['collectionId'],
      additionalProperties: false,
    });
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(inputSchema)).toBe(true);
    expect(Object.isFrozen(inputSchema.properties)).toBe(true);
    expect(Object.isFrozen(inputSchema.properties.collectionId)).toBe(true);
    expect(Object.isFrozen(inputSchema.required)).toBe(true);
  });

  it('executes the common compiled inputSchema validator before dispatch [evidence:mcp.tool-schema]', () => {
    expect(typeof createMcpToolInputValidator).toBe('function');
    const validate = createMcpToolInputValidator({
      type: 'object',
      properties: { value: { const: 'compiled-schema-ran' } },
      required: ['value'],
      additionalProperties: false,
    });

    expect(validate({ value: 'compiled-schema-ran' })).toEqual({ value: 'compiled-schema-ran' });
    expect(() => validate({ value: 'schema-was-not-run' })).toThrow();
  });

  it('delegates valid input to the application-service port and returns only its result [evidence:mcp.tool-schema]', async () => {
    const { gateway, getCollection } = createGateway();
    const input = { collectionId };

    const result = await gateway.callTool('collections.get', input, readContext());

    expect(getCollection).toHaveBeenCalledOnce();
    expect(getCollection).toHaveBeenCalledWith({ collectionId }, expect.any(Object));
    expect(getCollection.mock.calls[0]?.[0]).not.toBe(input);
    expect(Object.isFrozen(getCollection.mock.calls[0]?.[0])).toBe(true);
    expect(result.structuredContent).toEqual(collectionMetadata);
    expect(result.structuredContent).not.toBe(collectionMetadata);
    expect(Object.keys(result)).toEqual(['structuredContent']);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    'collections.get',
    'a.b',
    'collections.get_snapshot',
    `a.${'b'.repeat(126)}`,
  ])('accepts legal lower dotted Tool name syntax up to 128 characters: %j [evidence:mcp.tool-schema]', async (name) => {
    const { gateway, getCollection } = createGateway();

    if (name === 'collections.get') {
      await gateway.callTool(name, { collectionId }, readContext());
      expect(getCollection).toHaveBeenCalledOnce();
    } else {
      await expect(gateway.callTool(name, { collectionId }, readContext())).rejects.toBeInstanceOf(
        McpUnknownToolError,
      );
      expect(getCollection).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['missing input object', undefined],
    ['a null input object', null],
    ['an array input object', [collectionId]],
    ['missing required input', {}],
    ['unknown input instead of the required member', { unknown: 'value' }],
    ['an additional member', { collectionId, unknown: 'value' }],
    ['a null collectionId', { collectionId: null }],
    ['a numeric collectionId', { collectionId: 1 }],
    ['a boolean collectionId', { collectionId: true }],
    ['an array collectionId', { collectionId: [collectionId] }],
    ['an object collectionId', { collectionId: { value: collectionId } }],
  ] as const)(
    'uses the published inputSchema to reject %s before service invocation [evidence:mcp.tool-schema]',
    async (_label, input) => {
      const { gateway, getCollection } = createGateway();
      const validatePublishedSchema = compilePublishedInputSchema(gateway);

      expect(validatePublishedSchema(input)).toBe(false);
      await expectToolInputError(gateway.callTool('collections.get', input, readContext()));
      expect(getCollection).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['an empty collectionId', ''],
    ['a collectionId beyond the shared opaque ID boundary', 'x'.repeat(129)],
    ['a path-shaped collectionId', 'collection/child'],
  ] as const)(
    'shares the CORE ID boundary between schema and dispatch for %s [evidence:mcp.tool-schema]',
    async (_label, invalidCollectionId) => {
      const { gateway, getCollection } = createGateway();
      const validatePublishedSchema = compilePublishedInputSchema(gateway);
      const input = { collectionId: invalidCollectionId };

      expect(validatePublishedSchema(input)).toBe(false);
      await expectToolInputError(gateway.callTool('collections.get', input, readContext()));
      expect(getCollection).not.toHaveBeenCalled();
    },
  );

  it.each([
    'collections.list',
    'collections.update',
    'nodes.create',
    'access.plan_change',
  ])(
    'rejects an unexposed Tool %j without crossing the read service port [evidence:mcp.tool-schema]',
    async (name) => {
      const { gateway, getCollection } = createGateway();

      await expect(gateway.callTool(name, { collectionId }, readContext())).rejects.toBeInstanceOf(
        McpUnknownToolError,
      );
      expect(getCollection).not.toHaveBeenCalled();
    },
  );

  it.each([
    '',
    'Collections.get',
    'collections/get',
    'collections..get',
    'collections.get!',
    'x'.repeat(129),
  ])(
    'rejects an illegal or overlong Tool name %j before service invocation [evidence:mcp.tool-schema]',
    async (name) => {
      const { gateway, getCollection } = createGateway();

      await expect(gateway.callTool(name, { collectionId }, readContext())).rejects.toBeInstanceOf(
        McpInvalidToolNameError,
      );
      expect(getCollection).not.toHaveBeenCalled();
    },
  );

  it('keeps write, Plan, approval, and API-key capabilities outside the read boundary [evidence:mcp.tool-schema]', () => {
    const { gateway } = createGateway();
    const exposedSurface = [
      ...Object.keys(gateway),
      ...gateway.listTools().map(({ name }) => name),
    ].join(' ');

    expect(exposedSurface).not.toMatch(
      /create|update|delete|move|write|plan|commit|approv|api.?key|secret/iu,
    );
  });

  it('does not echo an unknown input member or secret in a Tool result [evidence:mcp.tool-schema]', async () => {
    const secret = 'api-key-secret-that-must-not-reach-model-context';
    const { gateway, getCollection } = createGateway();
    const input = { collectionId } as Record<string, unknown>;
    Object.defineProperty(input, 'apiKey', { value: secret, enumerable: false });

    const result = await gateway.callTool('collections.get', input, readContext());
    const delegated = getCollection.mock.calls[0]?.[0] as unknown as Record<string, unknown>;

    expect(Object.keys(delegated)).toEqual(['collectionId']);
    expect(delegated).not.toHaveProperty('apiKey');
    expect(JSON.stringify(result)).not.toContain('apiKey');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('rejects a required input inherited through the prototype chain [evidence:mcp.tool-schema]', async () => {
    const { gateway, getCollection } = createGateway();
    const inherited = Object.create({ collectionId }) as CollectionGetInput;

    await expectToolInputError(gateway.callTool('collections.get', inherited, readContext()));
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('rejects accessor-backed input without evaluating its getter [evidence:mcp.tool-schema]', async () => {
    const { gateway, getCollection } = createGateway();
    const collectionIdGetter = vi.fn(() => collectionId);
    const input = Object.defineProperty({}, 'collectionId', {
      enumerable: true,
      get: collectionIdGetter,
    });

    await expectToolInputError(gateway.callTool('collections.get', input, readContext()));
    expect(collectionIdGetter).not.toHaveBeenCalled();
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('deep-snapshots nested Tool input values so callers cannot alias into validation results [evidence:mcp.tool-schema]', () => {
    expect(typeof createMcpToolInputValidator).toBe('function');
    const validate = createMcpToolInputValidator!({
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: {
          type: 'object',
          additionalProperties: false,
          properties: { tags: { type: 'array', items: { type: 'string' } } },
          required: ['tags'],
        },
      },
      required: ['filter'],
    });
    const nestedTags = ['stable'];
    const filter = { tags: nestedTags };
    const input = { filter };

    const snapshot = validate(input) as {
      readonly filter: Readonly<{ tags: readonly string[] }>;
    };
    expect(snapshot).toEqual(input);
    expect(snapshot).not.toBe(input);
    expect(snapshot.filter).not.toBe(filter);
    expect(snapshot.filter.tags).not.toBe(nestedTags);
    expect(Object.isFrozen(snapshot.filter)).toBe(true);
    expect(Object.isFrozen(snapshot.filter.tags)).toBe(true);
    nestedTags[0] = 'mutated';
    expect(snapshot.filter.tags).toEqual(['stable']);
  });

  it('snapshots input before asynchronous service work can observe later mutation [evidence:mcp.tool-schema]', async () => {
    let releaseService!: () => void;
    const serviceMayRead = new Promise<void>((resolve) => {
      releaseService = resolve;
    });
    let observedCollectionId: string | undefined;
    const getCollection = vi.fn(async (input: CollectionGetInput): Promise<unknown> => {
      await serviceMayRead;
      observedCollectionId = input.collectionId;
      return collectionMetadata;
    });
    const { gateway } = createGateway(getCollection);
    const input = { collectionId };

    const pendingResult = gateway.callTool('collections.get', input, readContext());
    input.collectionId = 'attacker-controlled-after-validation';
    releaseService();
    await pendingResult;

    expect(observedCollectionId).toBe(collectionId);
    expect(getCollection.mock.calls[0]?.[0]).not.toBe(input);
  });
});
