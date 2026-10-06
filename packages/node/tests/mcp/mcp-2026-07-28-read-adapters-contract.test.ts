/**
 * COLP-MCP-09: Modern MCP 2026-07-28 Read adapter contracts.
 *
 * Covers `src/mcp/2026-07-28/resources.ts` (Modern Resource adapters:
 * resources/list, resources/read, resources/templates/list) and
 * `src/mcp/2026-07-28/tools.ts` (Modern Read Tool adapters: tools/list,
 * tools/call). The adapters are thin layers over the stateless shared cores:
 *
 * - every result is `complete`, carries `io.modelcontextprotocol/serverInfo`
 *   in `_meta`, and only cacheable methods carry accurate ttlMs/cacheScope;
 * - tools/list is deterministically ordered by registered name;
 * - unknown resource/tool names map to a stable Invalid Params (-32602)
 *   not-found error through `normalizeMcp20260728Error`;
 * - arbitrary JSON structured content (scalar/array/object) passes through,
 *   and raw secret markers in output are never leaked;
 * - one frozen adapter instance concurrently serves isolated per-request
 *   contexts; no hidden per-client instance.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CallToolResultSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';

import { createMcp20260728ResourceAdapter } from '../../src/mcp/2026-07-28/resources.js';
import {
  Mcp20260728ReadToolSecretMarkerError,
  createMcp20260728ReadToolAdapter,
} from '../../src/mcp/2026-07-28/tools.js';
import {
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  Mcp20260728RequestError,
  createMcp20260728RequestContext,
  requireMcp20260728RequestContext,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
} from '../../src/mcp/2026-07-28/request-context.js';
import {
  normalizeMcp20260728Error,
  type Mcp20260728Result,
} from '../../src/mcp/2026-07-28/results.js';
import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';
import { createMcpResourceTemplates } from '../../src/mcp/resource-templates.js';
import type { McpToolInputSchema } from '../../src/mcp/tool-input.js';
import {
  McpReadRequestAbortedError,
  McpResourceNotFoundError,
  McpResourceRequestError,
  createMcpStatelessReadCore,
  resolveMcpResourceReadBudget,
  type McpResourceProjectionPort,
} from '../../src/mcp/shared/resources.js';
import {
  createMcpStatelessToolCore,
  type McpStatelessToolCore,
  type McpToolRegistration,
} from '../../src/mcp/shared/tools.js';
import { createAnonymousPublicBinding } from '../../src/mcp/shared/authorization.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const serverInfo = Object.freeze({ name: 'colp-test-server', version: '0.0.0' });
const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const codec = createMcpResourceUriCodec(Object.freeze({ serverUuid }));
const metadataUri = codec.collectionMetadata('collection-1');
const snapshotUri = codec.collectionSnapshot('collection-1');
const nodeUri = codec.collectionNode('collection-1', 'node-1');
const templates = createMcpResourceTemplates(Object.freeze({ serverUuid }));

const anonBinding = createAnonymousPublicBinding({
  resourceAudience: 'urn:colp:resource:public',
  securityEpoch: 'epoch-1',
});
const authBinding = authenticatedBinding({ principalId: 'user-a', clientId: 'client-a' });

function meta(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_CAPABILITIES_META_KEY]: {},
    ...overrides,
  };
}

function header(name: string, value: string): Mcp20260728HeaderField {
  return { name, value };
}

function createContext(
  method: string,
  params: Readonly<Record<string, unknown>> | undefined,
  overrides: Readonly<Record<string, unknown>> = {},
  nameHeader?: string,
): Mcp20260728RequestContext {
  const headers = [header('mcp-protocol-version', '2026-07-28'), header('mcp-method', method)];
  if (nameHeader !== undefined) headers.push(header('mcp-name', nameHeader));
  return requireMcp20260728RequestContext(createMcp20260728RequestContext({
    headers,
    httpMethod: 'POST',
    body: { method, ...(params !== undefined ? { params } : {}) },
    binding: authBinding,
    ...overrides,
  } as Mcp20260728RequestContextInput));
}

function resourceListInput(cursor?: string): Record<string, unknown> {
  return cursor === undefined ? {} : { cursor };
}

function listResult(uris: readonly string[] = [metadataUri]) {
  return {
    resources: uris.map((uri) => ({
      uri,
      name: 'Collection',
      mimeType: 'application/json',
      provenance: { origin: 'internal' as const },
    })),
  };
}

function readResult(text = 'sanitized external data') {
  return {
    contents: [{
      mimeType: 'text/plain',
      text,
      provenance: { origin: 'external' as const, sourceUri: 'https://external.example/item' },
    }],
  };
}

function resourceHarness(
  overrides: Readonly<Record<string, unknown>> = {},
  adapterOptions: Readonly<Record<string, unknown>> = {},
) {
  const projection = {
    listResources: vi.fn(async () => listResult()),
    readResource: vi.fn(async () => readResult()),
    ...overrides,
  } as unknown as McpResourceProjectionPort;
  const core = createMcpStatelessReadCore({ projection, uriCodec: codec });
  const adapter = createMcp20260728ResourceAdapter({
    readCore: core,
    serverInfo,
    templates,
    ...adapterOptions,
  } as never);
  return { projection, core, adapter };
}

function simpleInputSchema(): McpToolInputSchema {
  return Object.freeze({
    type: 'object',
    additionalProperties: false,
    properties: Object.freeze({ collectionId: Object.freeze({ type: 'string', minLength: 1 }) }),
    required: Object.freeze(['collectionId']),
  });
}

function registration(
  name: string,
  invoke: (input: unknown, context: unknown) => unknown,
  inputSchema: McpToolInputSchema = { type: 'object' },
): McpToolRegistration {
  return {
    definition: Object.freeze({ name, description: `Tool ${name}.`, inputSchema }),
    invoke: invoke as McpToolRegistration['invoke'],
  };
}


function firstResourceUri(result: Mcp20260728Result): string | undefined {
  const resources = (result as { resources?: readonly { uri?: string }[] }).resources;
  return resources?.[0]?.uri;
}

function toolNames(result: Mcp20260728Result): readonly string[] {
  const tools = (result as { tools?: readonly { name: string }[] }).tools;
  return tools?.map((tool) => tool.name) ?? [];
}

function toolHarness(
  registrations: readonly McpToolRegistration[] = [],
  adapterOptions: Readonly<Record<string, unknown>> = {},
) {
  const toolCore = createMcpStatelessToolCore({ tools: registrations });
  const adapter = createMcp20260728ReadToolAdapter({
    toolCore,
    serverInfo,
    ...adapterOptions,
  } as never);
  return { toolCore, adapter };
}

function callContext(name: string, args: unknown, overrides: Readonly<Record<string, unknown>> = {}) {
  return createContext('tools/call', { name, ...(args !== undefined ? { arguments: args } : {}), _meta: meta() }, overrides, name);
}

describe('MCP 2026-07-28 resource adapter: list/read/templates', () => {
  it('listResources returns a complete, cacheable, serverInfo-stamped result', async () => {
    const { adapter } = resourceHarness();
    const result = await adapter.listResources(createContext('resources/list', { _meta: meta() }), {});
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
    expect(result._meta?.[SERVER_INFO_META_KEY]).toEqual(serverInfo);
    expect(result.resources).toEqual([{ uri: metadataUri, name: 'Collection', mimeType: 'application/json' }]);
    expect(ListResourcesResultSchema.safeParse(result).success).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.resources)).toBe(true);
  });

  it('listResources forwards optional description and _meta onto the wire', async () => {
    const { adapter, projection } = resourceHarness();
    (projection.listResources as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      resources: [{
        uri: metadataUri,
        name: 'Collection',
        mimeType: 'application/json',
        provenance: { origin: 'internal' as const },
        description: 'Newest public path',
        _meta: { nodeCount: 4, updatedAt: '2026-08-05T07:00:00.000Z' },
      }],
    }));
    const result = await adapter.listResources(createContext('resources/list', { _meta: meta() }), {});
    expect(result.resources).toEqual([{
      uri: metadataUri,
      name: 'Collection',
      mimeType: 'application/json',
      description: 'Newest public path',
      _meta: { nodeCount: 4, updatedAt: '2026-08-05T07:00:00.000Z' },
    }]);
    expect(ListResourcesResultSchema.safeParse(result).success).toBe(true);
  });

  it('listResources honors configured cacheScope/TTL and passes cursor/scope through', async () => {
    const { adapter, projection } = resourceHarness({}, {
      cache: { 'resources/list': { ttlMs: 5_000, cacheScope: 'public' } },
    });
    (projection.listResources as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_input: unknown, context: Mcp20260728RequestContext) => ({
        resources: [{ uri: metadataUri, name: 'C', mimeType: 'application/json', provenance: { origin: 'internal' } }],
        nextCursor: 'next-page',
      }),
    );
    const result = await adapter.listResources(
      createContext('resources/list', { _meta: meta() }),
      resourceListInput('page-1'),
    );
    expect(result.ttlMs).toBe(5_000);
    expect(result.cacheScope).toBe('public');
    expect(result.nextCursor).toBe('next-page');
    expect(projection.listResources).toHaveBeenCalledWith(
      { cursor: 'page-1' },
      expect.objectContaining({ scope: expect.any(Array) }),
    );
    expect(ListResourcesResultSchema.safeParse(result).success).toBe(true);
  });

  it('listResources isolates anonymous and authenticated contexts', async () => {
    const scopes: string[][] = [];
    const { adapter, projection } = resourceHarness();
    (projection.listResources as ReturnType<typeof vi.fn>).mockImplementation(
      async (_input: unknown, context: Mcp20260728RequestContext) => {
        scopes.push([...context.scope]);
        return listResult(context.binding.kind === 'anonymous' ? [metadataUri] : [nodeUri]);
      },
    );
    const anon = await adapter.listResources(createContext(
      'resources/list',
      { _meta: meta() },
      { binding: anonBinding, scope: ['public:read'] },
    ));
    const auth = await adapter.listResources(createContext(
      'resources/list',
      { _meta: meta() },
      { scope: ['collections:read'] },
    ));
    expect(anon.resources).toEqual([{ uri: metadataUri, name: 'Collection', mimeType: 'application/json' }]);
    expect(auth.resources).toEqual([{ uri: nodeUri, name: 'Collection', mimeType: 'application/json' }]);
    expect(scopes).toEqual([['public:read'], ['collections:read']]);
  });

  it('listResources rejects an over-budget large result without leaking details', async () => {
    const { adapter, projection } = resourceHarness();
    (projection.listResources as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const items = [];
      for (let index = 0; index < 5; index += 1) items.push({ uri: metadataUri, name: 'C', mimeType: 'application/json', provenance: { origin: 'internal' } });
      return { resources: items };
    });
    const context = createContext('resources/list', { _meta: meta() }, {
      budget: resolveMcpResourceReadBudget({ maxListItems: 2 }),
    });
    const error = await adapter.listResources(context, {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpResourceRequestError);
    expect(normalizeMcp20260728Error(error)).toEqual({ code: -32603, message: 'Internal error' });
  });

  it('readResource returns canonical complete contents and stamps serverInfo', async () => {
    const { adapter } = resourceHarness();
    const result = await adapter.readResource(
      createContext('resources/read', { uri: metadataUri, _meta: meta() }, {}, metadataUri),
      { uri: metadataUri },
    );
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
    expect(result.contents).toEqual([{ uri: metadataUri, mimeType: 'text/plain', text: 'sanitized external data' }]);
    expect(ReadResourceResultSchema.safeParse(result).success).toBe(true);
  });

  it('readResource unknown resource maps to stable Invalid Params not-found', async () => {
    const { adapter, projection } = resourceHarness();
    (projection.readResource as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new McpResourceNotFoundError();
    });
    const error = await adapter.readResource(
      createContext('resources/read', { uri: metadataUri, _meta: meta() }, {}, metadataUri),
      { uri: metadataUri },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Mcp20260728RequestError);
    expect((error as Mcp20260728RequestError).kind).toBe('invalid_params');
    expect((error as Mcp20260728RequestError).wireCode).toBe(MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
    expect(normalizeMcp20260728Error(error)).toEqual(expect.objectContaining({
      code: -32602,
      message: 'Resource not found.',
    }));
  });

  it('readResource malformed input is Invalid Params', async () => {
    const { adapter } = resourceHarness();
    const context = createContext('resources/read', { uri: metadataUri, _meta: meta() }, {}, metadataUri);
    await expect(adapter.readResource(context, {})).rejects.toMatchObject({
      kind: 'invalid_params',
      wireCode: -32602,
    });
    await expect(adapter.readResource(context, { uri: 42 })).rejects.toMatchObject({
      kind: 'invalid_params',
      wireCode: -32602,
    });
  });

  it('readResource aborts with McpReadRequestAbortedError and never yields a result', async () => {
    const controller = new AbortController();
    const { adapter, projection } = resourceHarness();
    (projection.readResource as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_input: unknown, context: Mcp20260728RequestContext) => {
        await new Promise<void>((resolve) => {
          context.abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        return readResult();
      },
    );
    const pending = adapter.readResource(
      createContext('resources/read', { uri: metadataUri, _meta: meta() }, { abortSignal: controller.signal }, metadataUri),
      { uri: metadataUri },
    );
    controller.abort();
    await expect(pending).rejects.toThrow(McpReadRequestAbortedError);
  });

  it('listResourceTemplates returns a complete cacheable result for anonymous bindings', async () => {
    const { adapter } = resourceHarness({}, {
      cache: { 'resources/templates/list': { ttlMs: 10_000, cacheScope: 'public' } },
    });
    const result = await adapter.listResourceTemplates(createContext(
      'resources/templates/list',
      { _meta: meta() },
      { binding: anonBinding, scope: ['public:read'] },
    ), { cursor: 'ignored' });
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(10_000);
    expect(result.cacheScope).toBe('public');
    expect(result.resourceTemplates).toEqual(templates.map(({ uriTemplate, name, title, mimeType }) => ({
      uriTemplate, name, title, mimeType,
    })));
    expect(ListResourceTemplatesResultSchema.safeParse(result).success).toBe(true);
  });

  it('serves concurrent isolated requests from one frozen adapter instance', async () => {
    const { adapter, projection } = resourceHarness();
    (projection.listResources as ReturnType<typeof vi.fn>).mockImplementation(
      async (_input: unknown, context: Mcp20260728RequestContext) => listResult(
        context.binding.kind === 'anonymous' ? [metadataUri] : [snapshotUri],
      ),
    );
    const contexts = Array.from({ length: 6 }, (_, index) => createContext(
      'resources/list',
      { _meta: meta() },
      index % 2 === 0
        ? { binding: anonBinding, scope: ['public:read'] }
        : { scope: [`collections:read:${index}`] },
    ));
    const results = await Promise.all(contexts.map((context) => adapter.listResources(context, {})));
    results.forEach((result, index) => {
      expect(firstResourceUri(result)).toBe(index % 2 === 0 ? metadataUri : snapshotUri);
    });
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(projection.listResources).toHaveBeenCalledTimes(6);
  });
});

describe('MCP 2026-07-28 read tool adapter: list/call', () => {
  it('listTools is deterministically ordered by registered name', async () => {
    const { adapter } = toolHarness([
      registration('zeta.query', async () => ({ structuredContent: { z: 1 } })),
      registration('alpha.get', async () => ({ structuredContent: { a: 1 } })),
      registration('middle.list', async () => ({ structuredContent: { m: 1 } })),
    ]);
    const result = await adapter.listTools(createContext('tools/list', { _meta: meta() }), {});
    expect(result.resultType).toBe('complete');
    expect(toolNames(result)).toEqual(['alpha.get', 'middle.list', 'zeta.query']);
    expect(result.ttlMs).toBe(0);
    expect(result.cacheScope).toBe('private');
    expect(ListToolsResultSchema.safeParse(result).success).toBe(true);
  });

  it('listTools returns an empty list when no tools are registered', async () => {
    const { adapter } = toolHarness([]);
    const result = await adapter.listTools(createContext('tools/list', { _meta: meta() }), {});
    expect(result.tools).toEqual([]);
    expect(ListToolsResultSchema.safeParse(result).success).toBe(true);
  });

  it('callTool passes through structured scalar, array and object content', async () => {
    const { adapter } = toolHarness([
      registration('echo.scalar', async (_input, _context) => ({ structuredContent: 42 })),
      registration('echo.array', async () => ({ structuredContent: [1, 'two', { three: 3 }] })),
      registration('echo.object', async () => ({ structuredContent: { ok: true, items: [1, 2] } })),
    ]);
    for (const [name, value] of [
      ['echo.scalar', 42],
      ['echo.array', [1, 'two', { three: 3 }]],
      ['echo.object', { ok: true, items: [1, 2] }],
    ] as const) {
      const result = await adapter.callTool(callContext(name, {}), { name, arguments: {} });
      expect(result.resultType).toBe('complete');
      expect(result.structuredContent).toEqual(value);
      expect(result.content).toEqual([]);
      expect(result.ttlMs).toBeUndefined();
      expect(result.cacheScope).toBeUndefined();
      expect(CallToolResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it('callTool treats omitted optional arguments as an empty object', async () => {
    const { adapter } = toolHarness([
      registration('ping.now', async () => ({ structuredContent: { ok: true } })),
    ]);
    const context = callContext('ping.now', {});
    const result = await adapter.callTool(context, { name: 'ping.now' });
    expect(result.resultType).toBe('complete');
    expect(result.structuredContent).toEqual({ ok: true });
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it('callTool validates arguments and maps invalid input to Invalid Params', async () => {
    const { adapter } = toolHarness([
      registration('collections.get', async () => ({ structuredContent: { ok: true } }), simpleInputSchema()),
    ]);
    const context = callContext('collections.get', {});
    await expect(adapter.callTool(context, { name: 'collections.get', arguments: {} }))
      .rejects.toMatchObject({ kind: 'invalid_params', wireCode: -32602 });
  });

  it('callTool unknown tool maps to stable Invalid Params not-found', async () => {
    const { adapter } = toolHarness([
      registration('alpha.get', async () => ({ structuredContent: { ok: true } })),
    ]);
    const error = await adapter.callTool(callContext('alpha.get', {}), {
      name: 'missing.tool',
      arguments: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Mcp20260728RequestError);
    expect((error as Mcp20260728RequestError).wireCode).toBe(-32602);
    expect(normalizeMcp20260728Error(error)).toEqual(expect.objectContaining({ code: -32602 }));
  });

  it('callTool aborts with McpReadRequestAbortedError', async () => {
    const controller = new AbortController();
    const { adapter } = toolHarness([
      registration('alpha.get', async () => ({ structuredContent: { ok: true } })),
    ]);
    const context = callContext('alpha.get', {}, { abortSignal: controller.signal });
    controller.abort();
    await expect(adapter.callTool(context, { name: 'alpha.get', arguments: {} }))
      .rejects.toThrow(McpReadRequestAbortedError);
  });

  it('callTool never leaks raw secret markers in structured content', async () => {
    const { adapter } = toolHarness([
      registration('keys.peek', async () => ({ structuredContent: { token: 'sk-secret-123' } })),
    ]);
    const error = await adapter.callTool(callContext('keys.peek', {}), {
      name: 'keys.peek',
      arguments: {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Mcp20260728ReadToolSecretMarkerError);
    const normalized = normalizeMcp20260728Error(error);
    expect(normalized).toEqual({ code: -32603, message: 'Internal error' });
    expect(JSON.stringify(normalized)).not.toContain('sk-secret-123');
  });

  it('serves concurrent isolated tool calls from one frozen adapter instance', async () => {
    const principals: string[] = [];
    const { adapter } = toolHarness([
      registration('whoami.echo', async (_input, context) => {
        const ctx = context as Mcp20260728RequestContext;
        principals.push(ctx.binding.principalId);
        return { structuredContent: { principal: ctx.binding.principalId } };
      }),
    ]);
    const contexts = Array.from({ length: 4 }, (_, index) => callContext('whoami.echo', {}, {
      binding: index % 2 === 0
        ? anonBinding
        : authenticatedBinding({ principalId: `user-${index}` }),
    }));
    const results = await Promise.all(contexts.map((context) => adapter.callTool(context, {
      name: 'whoami.echo',
      arguments: {},
    })));
    results.forEach((result, index) => {
      expect((result.structuredContent as { principal: string }).principal)
        .toBe(index % 2 === 0 ? 'public' : `user-${index}`);
    });
    expect(principals).toHaveLength(4);
    expect(Object.isFrozen(adapter)).toBe(true);
  });
});
