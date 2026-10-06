/**
 * MCP 2026-07-28 read-side adapter hardening (coverage gaps).
 *
 * Exercises the fail-closed host-configuration and wire-input branches of the
 * Modern Read Tool / Resource adapters (`src/mcp/2026-07-28/tools.ts`,
 * `src/mcp/2026-07-28/resources.ts`), the Modern result builder
 * (`results.ts`), the Schema 2020-12 budget guard (`schema-budget.ts`), the
 * discover adapter (`discovery.ts`) and the shared stateless cores
 * (`shared/tools.ts`, `shared/resources.ts`). Each case asserts a stable
 * public observation so an inverted guard would fail the test.
 */
import { describe, expect, it, vi } from 'vitest';

import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';
import {
  McpInvalidToolNameError,
  McpToolOutputUnavailableError,
  McpUnknownToolError,
  createMcpStatelessToolCore,
} from '../../src/mcp/shared/tools.js';
import {
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  McpResourceRequestError,
  createMcpStatelessReadCore,
  type McpResourceProjectionPort,
} from '../../src/mcp/shared/resources.js';
import {
  Mcp20260728ReadToolSecretMarkerError,
  createMcp20260728ReadToolAdapter,
} from '../../src/mcp/2026-07-28/tools.js';
import { createMcp20260728ResourceAdapter } from '../../src/mcp/2026-07-28/resources.js';
import { createMcp20260728Result } from '../../src/mcp/2026-07-28/results.js';
import {
  McpSchemaBudgetError,
  assertMcpSchemaWithinBudget,
  resolveMcpSchemaBudget,
} from '../../src/mcp/2026-07-28/schema-budget.js';
import {
  createMcp20260728DiscoverResult,
  validateMcp20260728DiscoverRequest,
} from '../../src/mcp/2026-07-28/discovery.js';
import {
  createMcp20260728RequestContext,
  requireMcp20260728RequestContext,
  type Mcp20260728HeaderField,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
} from '../../src/mcp/2026-07-28/request-context.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import { readContext } from './read-trusted-context-fixture.js';

const serverInfo = Object.freeze({ name: 'colp-hardening-server', version: '0.0.0' });
const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const codec = createMcpResourceUriCodec(Object.freeze({ serverUuid }));
const metadataUri = codec.collectionMetadata('collection-1');
const authBinding = authenticatedBinding({ principalId: 'user-hardening', clientId: 'client-hardening' });
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

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

const simpleInputSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({ mode: Object.freeze({ type: 'string', enum: ['private', 'public'] }) }),
  required: ['mode'],
});

function toolDefinition(overrides: Readonly<Record<string, unknown>> = {}) {
  return Object.freeze({ name: 'collection.query', description: 'Query a collection', inputSchema: simpleInputSchema, ...overrides });
}

function toolCore(overrides: Readonly<Record<string, unknown>> = {}) {
  const listTools = overrides.listTools ?? vi.fn(() => [toolDefinition()]);
  const callTool = overrides.callTool
    ?? vi.fn(async () => Object.freeze({ structuredContent: Object.freeze({ ok: true }) }));
  return { listTools, callTool, ...overrides } as never;
}

function toolAdapter(overrides: Readonly<Record<string, unknown>> = {}) {
  return createMcp20260728ReadToolAdapter({
    toolCore: toolCore(overrides.toolCore as Readonly<Record<string, unknown>> | undefined),
    serverInfo,
    ...overrides,
  } as never);
}

function listResult(uris: readonly string[] = [metadataUri]) {
  return {
    resources: uris.map((uri) => ({
      uri, name: 'Collection', mimeType: 'application/json', provenance: { origin: 'internal' as const },
    })),
  };
}

function readResult(text = 'sanitized external data') {
  return {
    contents: [{
      mimeType: 'text/plain', text, provenance: { origin: 'external' as const, sourceUri: 'https://external.example/item' },
    }],
  };
}

function projectionPort(overrides: Readonly<Record<string, unknown>> = {}): McpResourceProjectionPort {
  return {
    listResources: vi.fn(async () => listResult()),
    readResource: vi.fn(async () => readResult()),
    ...overrides,
  } as unknown as McpResourceProjectionPort;
}

function resourceAdapter(overrides: Readonly<Record<string, unknown>> = {}, adapterOptions: Readonly<Record<string, unknown>> = {}) {
  const core = createMcpStatelessReadCore({ projection: projectionPort(overrides), uriCodec: codec } as never);
  return createMcp20260728ResourceAdapter({ readCore: core, serverInfo, ...adapterOptions } as never);
}

function captureError(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(() => undefined, (caught: unknown) => caught);
}

describe('MCP 2026-07-28 Read Tool adapter — host configuration hardening', () => {
  it('rejects a wrong argument count, non-object, array or Proxy options', () => {
    expect(() => createMcp20260728ReadToolAdapter(undefined as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter(null as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter([] as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter(new Proxy({}, {}) as never)).toThrow(TypeError);
  });

  it('rejects a malformed toolCore (non-object, missing or non-function ports)', () => {
    const options: Record<string, unknown> = { toolCore: { listTools: vi.fn(() => []) }, serverInfo };
    expect(() => createMcp20260728ReadToolAdapter({ ...options, toolCore: null } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({ ...options, toolCore: {} } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      ...options,
      toolCore: { listTools: 'nope', callTool: vi.fn() },
    } as never)).toThrow(TypeError);
  });

  it('rejects an invalid serverInfo or schemaBudget', () => {
    expect(() => createMcp20260728ReadToolAdapter({ toolCore: toolCore(), serverInfo: null } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      toolCore: toolCore(), serverInfo: Object.freeze({ name: 42 }),
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      toolCore: toolCore(), serverInfo, schemaBudget: 'nope',
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      toolCore: toolCore(), serverInfo, schemaBudget: Object.freeze({ maxNodes: 0 }),
    } as never)).toThrow(TypeError);
  });

  it('rejects invalid cache metadata and cache shapes', () => {
    const base: Record<string, unknown> = { toolCore: toolCore(), serverInfo };
    expect(() => createMcp20260728ReadToolAdapter({ ...base, cache: [] } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({ ...base, cache: { 'tools/call': {} } } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      ...base, cache: { 'tools/list': { ttlMs: -1, cacheScope: 'private' } },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      ...base, cache: { 'tools/list': { ttlMs: 100, cacheScope: 'shared' } },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      ...base, cache: { 'tools/list': { ttlMs: 100.5, cacheScope: 'private' } },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ReadToolAdapter({
      ...base,
      cache: { 'tools/list': Object.defineProperty({ ttlMs: 100, cacheScope: 'private' }, 'ttlMs', { get: () => 100 }) },
    } as never)).toThrow(TypeError);
  });

  it('rejects malformed tool definitions from the core', () => {
    const base: Record<string, unknown> = { serverInfo };
    const cases: unknown[] = [
      null, {},
      { name: '', description: 'd', inputSchema: simpleInputSchema },
      { name: 'x', description: '', inputSchema: simpleInputSchema },
      { name: 'x', description: 'd', inputSchema: 'nope' },
      { name: 'x', description: 'd', inputSchema: simpleInputSchema, outputSchema: 'nope' },
      { name: 'x', description: 'd', inputSchema: simpleInputSchema, extra: 1 },
    ];
    for (const definition of cases) {
      expect(() => createMcp20260728ReadToolAdapter({
        ...base, toolCore: toolCore({ listTools: vi.fn(() => [definition]) }),
      } as never), JSON.stringify(definition)).toThrow(TypeError);
    }
    expect(() => createMcp20260728ReadToolAdapter({
      ...base, toolCore: toolCore({ listTools: vi.fn(() => 'not-an-array') }),
    } as never)).toThrow(TypeError);
  });

  it('rejects an over-budget Tool schema at factory time', () => {
    const deep: Record<string, unknown> = { type: 'object' };
    let cursor: Record<string, unknown> = deep;
    for (let index = 0; index < 40; index += 1) {
      const next: Record<string, unknown> = { type: 'object' };
      cursor.properties = { nested: next };
      cursor = next;
    }
    expect(() => createMcp20260728ReadToolAdapter({
      toolCore: toolCore({ listTools: vi.fn(() => [toolDefinition({ inputSchema: deep })]) }),
      serverInfo,
    } as never)).toThrow(TypeError);
  });
});

describe('MCP 2026-07-28 Read Tool adapter — wire input and output hardening', () => {
  it('listTools accepts a valid cursor and rejects malformed cursors', async () => {
    const adapter = toolAdapter();
    const context = createContext('tools/list', { _meta: meta() });
    const ok = await adapter.listTools(context, { cursor: 'abc' });
    expect(ok.resultType).toBe('complete');
    expect(await captureError(adapter.listTools(context, { cursor: '' }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.listTools(context, { cursor: 42 }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.listTools(context, { unexpected: 1 }))).toMatchObject({ kind: 'invalid_params' });
  });

  it('callTool rejects unknown tools, malformed names and malformed arguments', async () => {
    const adapter = toolAdapter();
    const context = createContext('tools/call', { _meta: meta() });
    const unknown = await captureError(adapter.callTool(context, { name: 'nope.tool', arguments: { mode: 'public' } }));
    expect(unknown).toMatchObject({ kind: 'invalid_params', data: { name: 'nope.tool' } });
    expect(await captureError(adapter.callTool(context, { name: '' }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.callTool(context, { name: 'collection.query', arguments: 'nope' })))
      .toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.callTool(context, 'nope'))).toMatchObject({ kind: 'invalid_params' });
  });

  it('maps core unknown/invalid tool errors, aborts and withholds raw secret markers', async () => {
    const context = createContext('tools/call', { _meta: meta() });
    const unknownAdapter = toolAdapter({
      toolCore: toolCore({ callTool: vi.fn(async () => { throw new McpUnknownToolError(); }) }),
    });
    expect(await captureError(unknownAdapter.callTool(context, { name: 'collection.query', arguments: { mode: 'public' } })))
      .toMatchObject({ kind: 'invalid_params' });

    const invalidAdapter = toolAdapter({
      toolCore: toolCore({ callTool: vi.fn(async () => { throw new McpInvalidToolNameError(); }) }),
    });
    expect(await captureError(invalidAdapter.callTool(context, { name: 'collection.query', arguments: { mode: 'public' } })))
      .toMatchObject({ kind: 'invalid_params' });

    const abortAdapter = toolAdapter({
      toolCore: toolCore({ callTool: vi.fn(async () => { throw new McpReadRequestAbortedError(); }) }),
    });
    expect(await captureError(abortAdapter.callTool(context, { name: 'collection.query', arguments: { mode: 'public' } })))
      .toBeInstanceOf(McpReadRequestAbortedError);

    const secretAdapter = toolAdapter({
      toolCore: toolCore({
        callTool: vi.fn(async () => Object.freeze({ structuredContent: Object.freeze({ password: 'colp_sk_live_secret' }) })),
      }),
    });
    expect(await captureError(secretAdapter.callTool(context, { name: 'collection.query', arguments: { mode: 'public' } })))
      .toBeInstanceOf(Mcp20260728ReadToolSecretMarkerError);
  });

  it('propagates tool input validation failures as invalid_params with issues', async () => {
    const adapter = toolAdapter();
    const context = createContext('tools/call', { _meta: meta() });
    const error = await captureError(adapter.callTool(context, { name: 'collection.query', arguments: {} }));
    expect(error).toMatchObject({ kind: 'invalid_params' });
    expect((error as { data: { issues: unknown } }).data.issues).toBeDefined();
  });

  it('passes through content, structuredContent, isError and outputSchema registration', async () => {
    const adapter = toolAdapter({
      toolCore: toolCore({
        listTools: vi.fn(() => [toolDefinition({ outputSchema: simpleInputSchema })]),
        callTool: vi.fn(async () => Object.freeze({
          content: Object.freeze([Object.freeze({ type: 'text', text: 'hello' })]),
          structuredContent: Object.freeze({ ok: true }),
          isError: true,
        })),
      }),
    });
    const context = createContext('tools/call', { _meta: meta() });
    const result = await adapter.callTool(context, { name: 'collection.query', arguments: { mode: 'public' } });
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'hello' }] });
    const listed = await adapter.listTools(context, {});
    expect(JSON.stringify(listed.tools)).toContain('outputSchema');
  });
});

describe('MCP 2026-07-28 Resource adapter — configuration and wire hardening', () => {
  it('rejects malformed host configuration', () => {
    expect(() => createMcp20260728ResourceAdapter(undefined as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter(null as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter([] as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter(new Proxy({}, {}) as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({ readCore: {}, serverInfo } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({ readCore: { listResources: vi.fn(), readResource: 'nope' }, serverInfo } as never))
      .toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({ readCore: { listResources: vi.fn(), readResource: vi.fn() }, serverInfo: null } as never))
      .toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({ readCore: { listResources: vi.fn(), readResource: vi.fn() }, serverInfo: Object.freeze({ name: 42 }) } as never))
      .toThrow(TypeError);
  });

  it('rejects malformed templates and cache metadata', () => {
    const readCore = { listResources: vi.fn(), readResource: vi.fn() } as never;
    expect(() => createMcp20260728ResourceAdapter({ readCore, serverInfo, templates: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({ readCore, serverInfo, templates: [{ uriTemplate: 42 }] } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({
      readCore, serverInfo, templates: [Object.freeze({ uriTemplate: 'x', name: '', title: 't', mimeType: 'm' })],
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({ readCore, serverInfo, cache: [] } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({
      readCore, serverInfo, cache: { 'resources/read': { ttlMs: 0, cacheScope: 'shared' } },
    } as never)).toThrow(TypeError);
    expect(() => createMcp20260728ResourceAdapter({
      readCore, serverInfo, cache: { bogus: { ttlMs: 0, cacheScope: 'private' } },
    } as never)).toThrow(TypeError);
  });

  it('hardens listResources cursor, readResource uri and abort/not-found paths', async () => {
    const adapter = resourceAdapter();
    const listContext = createContext('resources/list', { _meta: meta() });
    const listed = await adapter.listResources(listContext, { cursor: 'abc' });
    expect(listed.resultType).toBe('complete');
    expect(await captureError(adapter.listResources(listContext, { cursor: '' }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.listResources(listContext, { cursor: 42 }))).toMatchObject({ kind: 'invalid_params' });

    const readCtx = createContext('resources/read', { uri: metadataUri, _meta: meta() }, {}, metadataUri);
    const read = await adapter.readResource(readCtx, { uri: metadataUri });
    expect(read.resultType).toBe('complete');
    expect(await captureError(adapter.readResource(readCtx, { uri: '' }))).toMatchObject({ kind: 'invalid_params' });
    expect(await captureError(adapter.readResource(readCtx, {}))).toMatchObject({ kind: 'invalid_params' });

    const notFound = resourceAdapter({ readResource: vi.fn(async () => { throw new McpResourceNotFoundError(); }) });
    expect(await captureError(notFound.readResource(readCtx, { uri: metadataUri })))
      .toMatchObject({ kind: 'invalid_params', data: { uri: metadataUri } });

    const aborted = resourceAdapter({ readResource: vi.fn(async () => { throw new McpReadRequestAbortedError(); }) });
    expect(await captureError(aborted.readResource(readCtx, { uri: metadataUri })))
      .toBeInstanceOf(McpReadRequestAbortedError);
  });

  it('propagates nextCursor and streams templates through resources/templates/list', async () => {
    const adapter = resourceAdapter({ listResources: vi.fn(async () => ({ ...listResult(), nextCursor: 'next-1' })) });
    const listed = await adapter.listResources(createContext('resources/list', { _meta: meta() }), {});
    expect(listed.nextCursor).toBe('next-1');
    const templates = await adapter.listResourceTemplates(
      createContext('resources/templates/list', { _meta: meta() }),
      { cursor: 'abc' },
    );
    expect(templates.resourceTemplates).toBeDefined();
  });
});

describe('MCP 2026-07-28 results — host-input hardening', () => {
  it('rejects malformed result inputs fail-closed', () => {
    expect(() => createMcp20260728Result(null as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result([] as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({} as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', resultType: 'bogus' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'resources/list', resultType: 'input_required' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', serverInfo: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', serverInfo: Object.freeze({ name: 42 }) } as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', cache: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', fields: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcp20260728Result({ method: 'tools/call', fields: Object.freeze({ resultType: 'complete' }) } as never)).toThrow(TypeError);
  });
});

describe('MCP 2026-07-28 schema budget — guard hardening', () => {
  it('rejects malformed budgets and non-JSON schema values', () => {
    expect(() => resolveMcpSchemaBudget('nope' as never)).toThrow(TypeError);
    expect(() => resolveMcpSchemaBudget([] as never)).toThrow(TypeError);
    expect(() => resolveMcpSchemaBudget(new Proxy({}, {}) as never)).toThrow(TypeError);
    expect(() => resolveMcpSchemaBudget(Object.freeze({ maxBytes: 0 }))).toThrow(TypeError);
    expect(() => assertMcpSchemaWithinBudget(() => 1)).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget(Number.NaN)).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget(Number.POSITIVE_INFINITY)).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget({ __proto__: null, type: 'object' })).not.toThrow();
  });

  it('rejects over-budget node/byte/reference, cycle, symbol and non-enumerable schemas', () => {
    expect(() => assertMcpSchemaWithinBudget([1, 2, 3], Object.freeze({ maxNodes: 1 }))).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget({ type: 'object', nested: { x: 1 } }, Object.freeze({ maxNodes: 2 }))).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget({ a: { b: 1 } }, Object.freeze({ maxNodes: 1 }))).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget({ a: Object.freeze({ $ref: '#/x' }), b: Object.freeze({ $ref: '#/y' }) }, Object.freeze({ maxReferences: 1 }))).toThrow(McpSchemaBudgetError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => assertMcpSchemaWithinBudget(cycle)).toThrow(McpSchemaBudgetError);
    const withSymbol: Record<string | symbol, unknown> = {};
    withSymbol[Symbol('k')] = 1;
    expect(() => assertMcpSchemaWithinBudget(withSymbol)).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget([1, , 3] as unknown[])).toThrow(McpSchemaBudgetError);
    const nonEnumerable: Record<string, unknown> = { type: 'object' };
    Object.defineProperty(nonEnumerable, 'hidden', { value: 1, enumerable: false });
    expect(() => assertMcpSchemaWithinBudget(nonEnumerable)).toThrow(McpSchemaBudgetError);
    expect(() => assertMcpSchemaWithinBudget(new Date() as never)).toThrow(McpSchemaBudgetError);
  });
});

describe('MCP 2026-07-28 discover — host-input hardening', () => {
  it('rejects malformed discover inputs and validates discover requests', () => {
    expect(() => createMcp20260728DiscoverResult(null as never)).toThrow(TypeError);
    expect(() => createMcp20260728DiscoverResult([] as never)).toThrow(TypeError);
    expect(() => createMcp20260728DiscoverResult({ capabilities: {} } as never)).toThrow(TypeError);
    expect(() => createMcp20260728DiscoverResult({ serverInfo: null, capabilities: {} } as never)).toThrow(TypeError);
    expect(() => createMcp20260728DiscoverResult({ serverInfo, capabilities: {}, instructions: 42 } as never)).toThrow(TypeError);
    const result = createMcp20260728DiscoverResult({
      serverInfo,
      capabilities: Object.freeze({ tools: Object.freeze({ listChanged: true }) }),
      instructions: 'read-only server',
    });
    expect(result.supportedVersions).toEqual(['2026-07-28']);
    expect(result.instructions).toBe('read-only server');
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']).toEqual(serverInfo);
    expect(validateMcp20260728DiscoverRequest({ method: 'server/discover' })).toEqual({ ok: true });
    expect(validateMcp20260728DiscoverRequest('nope')).toEqual({ ok: false, issue: expect.any(String) });
  });
});

describe('shared stateless read core — configuration and context hardening', () => {
  it('rejects malformed core options fail-closed', () => {
    expect(() => createMcpStatelessReadCore(undefined as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore(null as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore([] as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore(new Proxy({}, {}) as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore({ projection: {}, uriCodec: codec } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore({
      projection: { listResources: vi.fn(), readResource: 'nope' }, uriCodec: codec,
    } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore({
      projection: { listResources: vi.fn(), readResource: vi.fn() }, uriCodec: { ...codec, serverUuid: '' },
    } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore({
      projection: { listResources: vi.fn(), readResource: vi.fn() }, uriCodec: { ...codec, parse: 'nope' },
    } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore({
      projection: { listResources: vi.fn(), readResource: vi.fn() }, uriCodec: codec, clock: { now: 'nope' },
    } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessReadCore({
      projection: { listResources: vi.fn(), readResource: vi.fn() }, uriCodec: codec, clock: undefined,
    } as never)).not.toThrow();
  });

  it('rejects malformed trusted contexts and non-canonical URIs', async () => {
    const core = createMcpStatelessReadCore({ projection: projectionPort(), uriCodec: codec });
    const invalidContexts: unknown[] = [
      null,
      'nope',
      new Proxy({}, {}) as never,
      { binding: null, scope: [], budget: undefined, abortSignal: new AbortController().signal, authorization: {} },
      { binding: {}, scope: [], budget: {}, abortSignal: new AbortController().signal, authorization: {} },
      { binding: {}, scope: [], budget: Object.freeze({ maxListItems: 0 }), abortSignal: new AbortController().signal, authorization: {} },
      { binding: {}, scope: 'nope', budget: undefined, abortSignal: new AbortController().signal, authorization: {} },
      { binding: {}, scope: [''], budget: undefined, abortSignal: new AbortController().signal, authorization: {} },
      { binding: {}, scope: [], budget: undefined, abortSignal: {}, authorization: {} },
      { binding: {}, scope: [], budget: undefined, abortSignal: new AbortController().signal, authorization: 'nope' },
    ];
    for (const candidate of invalidContexts) {
      await expect(core.listResources(candidate as never, {})).rejects.toBeInstanceOf(McpReadRequestContextError);
    }
    const nonCanonicalCore = createMcpStatelessReadCore({
      projection: projectionPort(),
      uriCodec: { ...codec, parse: () => ({ kind: 'collection-metadata' as const, collectionId: 'different' }) },
    } as never);
    await expect(nonCanonicalCore.readResource(readContext(), { uri: metadataUri }))
      .rejects.toBeInstanceOf(McpResourceRequestError);
    await expect(core.listResources(readContext(), { cursor: 'x' })).resolves.toMatchObject({ resources: expect.any(Array) });
  });
});

describe('shared stateless tool core — configuration and output hardening', () => {
  it('rejects malformed registrations and duplicate names', () => {
    const good = { definition: { name: 'a.b', description: 'd', inputSchema: simpleInputSchema }, invoke: vi.fn(() => ({ ok: true })) };
    expect(() => createMcpStatelessToolCore(undefined as never)).toThrow(TypeError);
    expect(() => createMcpStatelessToolCore(null as never)).toThrow(TypeError);
    expect(() => createMcpStatelessToolCore({ tools: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessToolCore({ tools: [good, good] } as never)).toThrow(TypeError);
    for (const name of ['', 'a', 'A.b', 'a..b', 'a b', 'x'.repeat(129)]) {
      expect(() => createMcpStatelessToolCore({
        tools: [{ definition: { name, description: 'd', inputSchema: simpleInputSchema }, invoke: vi.fn() }],
      } as never), name).toThrow(TypeError);
    }
    expect(() => createMcpStatelessToolCore({
      tools: [{ definition: { name: 'a.b', description: '', inputSchema: simpleInputSchema }, invoke: vi.fn() }],
    } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessToolCore({
      tools: [{ definition: { name: 'a.b', description: 'd', inputSchema: 'nope' }, invoke: vi.fn() }],
    } as never)).toThrow(TypeError);
    expect(() => createMcpStatelessToolCore({
      tools: [{ definition: { name: 'a.b', description: 'd', inputSchema: simpleInputSchema }, invoke: 'nope' }],
    } as never)).toThrow(TypeError);
  });

  it('hides application failures and rejects non-object tool output', async () => {
    const hidden = createMcpStatelessToolCore({
      tools: [{ definition: { name: 'a.b', description: 'd', inputSchema: simpleInputSchema }, invoke: vi.fn(() => { throw new Error('boom'); }) }],
    });
    await expect(hidden.callTool(readContext(), 'a.b', { mode: 'public' })).rejects.toBeInstanceOf(McpToolOutputUnavailableError);
    const nonObject = createMcpStatelessToolCore({
      tools: [{ definition: { name: 'a.b', description: 'd', inputSchema: simpleInputSchema }, invoke: vi.fn(() => 'nope') }],
    });
    await expect(nonObject.callTool(readContext(), 'a.b', { mode: 'public' })).rejects.toBeInstanceOf(McpToolOutputUnavailableError);
  });
});
