/**
 * COLP-MCP-07: stateless MCP Resource projection and Tool execution ports.
 *
 * The removed per-Session Resource Server is replaced by protocol-neutral
 * shared ports (`src/mcp/shared/resources.ts`, `src/mcp/shared/tools.ts`):
 * one frozen application core serves concurrent per-request trusted read
 * contexts (authorization binding, scope, budget, abort signal plus opaque
 * host residual). No instance keeps subscription state, echoes a sessionId,
 * or captures a request context between calls.
 *
 * Covers: concurrent principal isolation, anonymous/authenticated binding
 * threading, cursor/URI canonicalization, scope/security epoch passthrough,
 * abort, read/tool budgets, application exception hiding, no retained
 * context, protocol-neutral fake ports, Sync Session non-collateral, and
 * runtime absence of the removed Session API.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as mcpBoundary from '../../src/mcp/index.js';
import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';
import { McpToolInputError } from '../../src/mcp/tool-input.js';
import {
  createMcpStatelessReadCore,
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  McpResourceRequestError,
  resolveMcpResourceReadBudget,
  type McpResourceProjectionPort,
  type McpStatelessReadCore,
} from '../../src/mcp/shared/resources.js';
import {
  createMcpStatelessToolCore,
  McpInvalidToolNameError,
  McpToolOutputUnavailableError,
  McpUnknownToolError,
  type McpStatelessToolCore,
  type McpToolRegistration,
} from '../../src/mcp/shared/tools.js';
import {
  assertVerifiedSyncSession,
  SyncSessionGateDeniedError,
} from '../../src/sync/session.js';
import { authenticatedBinding } from './authenticated-binding-fixture.js';
import {
  anonymousReadContext,
  readContext,
  READ_RESOURCE_AUDIENCE,
  READ_SECURITY_EPOCH,
} from './read-trusted-context-fixture.js';

const evidence = '[evidence:mcp.server-resource-safety]';
const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const codec = createMcpResourceUriCodec(Object.freeze({ serverUuid }));
const metadataUri = codec.collectionMetadata('collection-1');
const snapshotUri = codec.collectionSnapshot('collection-1');
const nodeUri = codec.collectionNode('collection-1', 'node-1');

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

function projectionPort(overrides: Readonly<Record<string, unknown>> = {}): McpResourceProjectionPort {
  return {
    listResources: vi.fn(async () => listResult()),
    readResource: vi.fn(async () => readResult()),
    ...overrides,
  } as unknown as McpResourceProjectionPort;
}

function resourceHarness(
  projection = projectionPort(),
  options: Readonly<{ clock?: unknown }> = {},
) {
  const core = createMcpStatelessReadCore({
    projection,
    uriCodec: codec,
    ...options,
  } as never);
  return { core, projection };
}

function toolRegistrations(overrides: Readonly<Record<string, unknown>> = {}): McpToolRegistration[] {
  return [{
    definition: Object.freeze({
      name: 'collections.get',
      description: 'Get metadata for one Collection.',
      inputSchema: Object.freeze({
        type: 'object',
        additionalProperties: false,
        properties: Object.freeze({ collectionId: Object.freeze({ $ref: 'opaqueId' }) }),
        required: Object.freeze(['collectionId']),
      }),
    }),
    invoke: vi.fn(async (input: unknown) => {
      if ((input as Readonly<Record<string, unknown>>).collectionId === undefined) {
        throw new McpToolInputError([Object.freeze({
          instancePath: '/collectionId',
          keyword: 'required',
          message: 'must have string collectionId',
        })]);
      }
      return Object.freeze({ structuredContent: Object.freeze({ id: 'collection-1' }) });
    }),
    ...overrides,
  }];
}

function toolHarness(registrations = toolRegistrations()) {
  const core = createMcpStatelessToolCore({ tools: registrations });
  return { core, registrations };
}

function serialized(value: unknown): string {
  try {
    return `${String(value)} ${JSON.stringify(value)}`;
  } catch {
    return String(value);
  }
}

async function captureRejection(operation: () => unknown | PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}

describe(`stateless Resource projection core ${evidence}`, () => {
  it('creates one frozen core with only list/read methods and no session or subscription surface', () => {
    const { core } = resourceHarness();
    expect(Object.isFrozen(core)).toBe(true);
    expect(Object.keys(core).sort()).toEqual(['listResources', 'readResource']);
    for (const name of ['sessionId', 'subscribeResource', 'unsubscribeResource', 'publishResourceUpdated'] as const) {
      expect((core as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
    expect(Object.values(Object.getOwnPropertyDescriptors(core)).every((d) => d.writable === false)).toBe(true);
  });

  it('serves concurrent principal-isolated reads and lists on one shared instance', async () => {
    const { core, projection } = resourceHarness();
    const alice = readContext({ binding: authenticatedBinding({ principalId: 'alice', clientId: 'client-a' }) });
    const bob = readContext({ binding: authenticatedBinding({ principalId: 'bob', clientId: 'client-b' }) });
    const anon = anonymousReadContext();

    const calls = await Promise.all([
      core.readResource(alice, { uri: metadataUri }),
      core.readResource(bob, { uri: nodeUri }),
      core.readResource(anon, { uri: snapshotUri }),
      core.listResources(alice, { cursor: 'page-2' }),
    ]);

    expect(calls[0]).toMatchObject({ contents: [{ uri: metadataUri }] });
    expect(calls[1]).toMatchObject({ contents: [{ uri: nodeUri }] });
    expect(calls[2]).toMatchObject({ contents: [{ uri: snapshotUri }] });

    const readInputs = (projection.readResource as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input);
    expect(readInputs.map((input: { resource: { kind: string } }) => input.resource.kind)).toEqual([
      'collection-metadata',
      'collection-node',
      'collection-snapshot',
    ]);
    const readContexts = (projection.readResource as ReturnType<typeof vi.fn>).mock.calls.map(([, context]) => context);
    expect(readContexts.map((context: { binding: { principalId: string } }) => context.binding.principalId)).toEqual([
      'alice',
      'bob',
      'public',
    ]);
    const listContext = (projection.listResources as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(listContext.binding.principalId).toBe('alice');
    expect(listContext.binding.clientId).toBe('client-a');
  });

  it('threads anonymous and authenticated bindings with scope and security epoch untouched', async () => {
    const { core, projection } = resourceHarness();
    const anon = anonymousReadContext();
    const auth = readContext({
      binding: authenticatedBinding({
        principalId: 'principal-auth',
        clientId: 'client-auth',
        credentialBindingId: 'credential-auth',
      }),
      scope: Object.freeze(['collections:read', 'snapshots:read']),
    });

    await core.readResource(anon, { uri: metadataUri });
    await core.readResource(auth, { uri: metadataUri });

    const received = (projection.readResource as ReturnType<typeof vi.fn>).mock.calls.map(([, context]) => context);
    expect(received[0]).toMatchObject({
      binding: { kind: 'anonymous', principalId: 'public', resourceAudience: READ_RESOURCE_AUDIENCE, securityEpoch: READ_SECURITY_EPOCH },
      scope: ['public:read'],
    });
    expect(received[1]).toMatchObject({
      binding: {
        kind: 'authenticated',
        principalId: 'principal-auth',
        clientId: 'client-auth',
        credentialBindingId: 'credential-auth',
      },
      scope: ['collections:read', 'snapshots:read'],
    });
    expect(received[0].binding.kind).not.toBe(received[1].binding.kind);
  });

  it('rejects malformed, accessor-backed, or forged-kind trusted contexts without invoking the port', async () => {
    const { core, projection } = resourceHarness();
    const base = readContext();
    const missingBinding = Object.freeze({ ...base, binding: undefined });
    const accessor = Object.defineProperty(
      { ...base },
      'authorization',
      { configurable: true, enumerable: true, get: () => ({ subject: 'alice' }) },
    );
    const forgedKind = readContext({ binding: { kind: 'oauth', principalId: 'x', clientId: 'y', credentialBindingId: 'z', resourceAudience: 'a', securityEpoch: 'e' } as never });
    const missingBudget = Object.freeze({ ...base, budget: undefined });

    for (const context of [missingBinding, accessor, forgedKind, missingBudget] as never[]) {
      const error = await captureRejection(() => core.readResource(context, { uri: metadataUri }));
      expect(error).toBeInstanceOf(McpReadRequestContextError);
      expect(error).toMatchObject({ code: 'invalid_read_request_context' });
    }
    expect(projection.readResource).not.toHaveBeenCalled();
  });

  it('passes an opaque cursor unchanged and rejects empty or oversized cursors fail-closed', async () => {
    const { core, projection } = resourceHarness();
    await core.listResources(readContext(), { cursor: 'opaque-page-7' });
    expect(projection.listResources).toHaveBeenCalledWith(
      { cursor: 'opaque-page-7' },
      expect.any(Object),
    );
    await core.listResources(readContext(), { cursor: undefined as never });
    expect(projection.listResources).toHaveBeenLastCalledWith({}, expect.any(Object));
    await expect(core.listResources(readContext(), { cursor: '' })).rejects.toBeInstanceOf(McpResourceRequestError);
    expect(projection.listResources).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-empty nextCursor and oversized nextCursor from the application', async () => {
    const bad = projectionPort({ listResources: vi.fn(async () => ({ resources: [], nextCursor: '' })) });
    const { core } = resourceHarness(bad);
    await expect(core.listResources(readContext(), {})).rejects.toBeInstanceOf(McpResourceRequestError);

    const longCursor = 'x'.repeat(2049);
    const oversized = projectionPort({ listResources: vi.fn(async () => ({ resources: [], nextCursor: longCursor })) });
    const coreOversized = createMcpStatelessReadCore({ projection: oversized, uriCodec: codec });
    await expect(coreOversized.listResources(readContext(), {})).rejects.toBeInstanceOf(McpResourceRequestError);
  });

  it('delegates only canonical URIs and rejects forged, percent, query, fragment, and userinfo forms', async () => {
    const { core, projection } = resourceHarness();
    for (const uri of [metadataUri, snapshotUri, nodeUri]) {
      await core.readResource(readContext(), { uri });
    }
    const delegated = (projection.readResource as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input.resource);
    expect(delegated).toEqual([
      { kind: 'collection-metadata', collectionId: 'collection-1' },
      { kind: 'collection-snapshot', collectionId: 'collection-1' },
      { kind: 'collection-node', collectionId: 'collection-1', nodeId: 'node-1' },
    ]);

    const hostile = [
      `colp://019b3c67-a03c-7f02-9c7e-1ee8d50a77df/collections/collection-1`,
      `${metadataUri}?x=1`,
      `${metadataUri}#frag`,
      `${metadataUri}/nodes/node-1%2Ftraversal`,
      'colp://user@019b3c67-a03c-7f02-9c7e-1ee8d50a77de/collections/collection-1',
    ];
    for (const uri of hostile) {
      await expect(core.readResource(readContext(), { uri })).rejects.toBeInstanceOf(McpResourceRequestError);
    }
    expect(projection.readResource).toHaveBeenCalledTimes(3);
  });

  it('enforces read budgets on list items, read contents, text bytes, and cursor length', async () => {
    const budget = resolveMcpResourceReadBudget({
      maxListItems: 2,
      maxReadContents: 1,
      maxTextBytes: 8,
      maxCursorLength: 4,
    });
    const many = projectionPort({ listResources: vi.fn(async () => listResult([metadataUri, snapshotUri, nodeUri])) });
    const coreMany = createMcpStatelessReadCore({ projection: many, uriCodec: codec });
    await expect(coreMany.listResources(readContext({ budget }), {})).rejects.toBeInstanceOf(McpResourceRequestError);

    const wide = projectionPort({ readResource: vi.fn(async () => ({ contents: [readResult().contents[0], readResult().contents[0]] })) });
    const coreWide = createMcpStatelessReadCore({ projection: wide, uriCodec: codec });
    await expect(coreWide.readResource(readContext({ budget }), { uri: metadataUri })).rejects.toBeInstanceOf(McpResourceRequestError);

    const longText = projectionPort({ readResource: vi.fn(async () => readResult('1234567890')) });
    const coreLong = createMcpStatelessReadCore({ projection: longText, uriCodec: codec });
    await expect(coreLong.readResource(readContext({ budget }), { uri: metadataUri })).rejects.toBeInstanceOf(McpResourceRequestError);

    await expect(coreMany.listResources(readContext({ budget }), { cursor: 'abcde' })).rejects.toBeInstanceOf(McpResourceRequestError);
  });

  it('honors abort at entry and mid-flight with a dedicated error and never returns a result', async () => {
    const controller = new AbortController();
    controller.abort();
    const { core, projection } = resourceHarness();
    const aborted = readContext({ abortSignal: controller.signal });
    await expect(core.readResource(aborted, { uri: metadataUri })).rejects.toBeInstanceOf(McpReadRequestAbortedError);
    await expect(core.readResource(aborted, { uri: metadataUri })).rejects.toMatchObject({ code: 'request_aborted' });
    expect(projection.readResource).not.toHaveBeenCalled();

    let resolveRead!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolvePromise) => { resolveRead = resolvePromise; });
    const midflight = projectionPort({ readResource: vi.fn(() => pending) });
    const coreMid = createMcpStatelessReadCore({ projection: midflight, uriCodec: codec });
    const inflight = new AbortController();
    const operation = coreMid.readResource(readContext({ abortSignal: inflight.signal }), { uri: metadataUri });
    inflight.abort();
    resolveRead(readResult());
    await expect(operation).rejects.toBeInstanceOf(McpReadRequestAbortedError);
  });

  it('hides application exceptions, secrets, and malformed projections behind the generic resource error', async () => {
    const secret = 'Bearer resource-private-secret';
    const throwing = projectionPort({ readResource: vi.fn(async () => { throw new Error(`db failed ${secret}`); }) });
    const { core } = resourceHarness(throwing);
    const error = await captureRejection(() => core.readResource(readContext(), { uri: metadataUri }));
    expect(error).toBeInstanceOf(McpResourceRequestError);
    expect(error).toMatchObject({ name: 'McpResourceRequestError', code: 'resource_request_failed' });
    expect(serialized(error)).not.toContain(secret);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const malformed = projectionPort({ readResource: vi.fn(async () => cyclic) });
    const coreMalformed = createMcpStatelessReadCore({ projection: malformed, uriCodec: codec });
    await expect(coreMalformed.readResource(readContext(), { uri: metadataUri })).rejects.toBeInstanceOf(McpResourceRequestError);
  });

  it('keeps no retained context between requests and never mutates caller contexts', async () => {
    const { core } = resourceHarness();
    const alice = readContext({ binding: authenticatedBinding({ principalId: 'alice' }) });
    const bob = readContext({ binding: authenticatedBinding({ principalId: 'bob' }) });
    const first = await core.readResource(alice, { uri: metadataUri });
    const second = await core.readResource(bob, { uri: metadataUri });
    expect(first.contents[0]?.uri).toBe(metadataUri);
    expect(second.contents[0]?.uri).toBe(metadataUri);
    expect(Object.isFrozen(alice)).toBe(true);
    expect(Object.isFrozen(bob)).toBe(true);
    expect(Object.keys(core).sort()).toEqual(['listResources', 'readResource']);
  });

  it('accepts an own-data clock port and rejects hostile clocks at factory time', () => {
    const valid = resourceHarness(projectionPort(), { clock: { now: () => new Date() } });
    expect(Object.keys(valid.core)).toEqual(['listResources', 'readResource']);
    const accessor = Object.defineProperty({}, 'now', { enumerable: true, get: () => new Date() });
    expect(() => createMcpStatelessReadCore({ projection: projectionPort(), uriCodec: codec, clock: accessor as never }))
      .toThrow(TypeError);
  });

  it('keeps the Resource fake ports protocol-neutral (no wire, session, or transport types)', () => {
    const port = projectionPort();
    expect(Object.keys(port).sort()).toEqual(['listResources', 'readResource']);
    for (const name of ['headers', 'jsonRpc', 'request', 'transport', 'sessionId', 'subscribeResource'] as const) {
      expect((port as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
    const context = readContext();
    for (const name of ['headers', 'jsonRpcRequest', 'transport', 'sessionId'] as const) {
      expect((context as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

describe(`stateless Tool execution core ${evidence}`, () => {
  it('lists a deterministic frozen Tool surface without invoking any execution port', () => {
    const { core, registrations } = toolHarness();
    const listed = core.listTools();
    expect(listed.map(({ name }) => name)).toEqual(['collections.get']);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0])).toBe(true);
    expect((registrations[0]!.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(Object.isFrozen(core)).toBe(true);
  });

  it('dispatches valid input through the execution port with the per-request trusted context', async () => {
    const { core, registrations } = toolHarness();
    const context = readContext({ scope: Object.freeze(['collections:read']) });
    const result = await core.callTool(context, 'collections.get', { collectionId: 'collection-1' });
    expect(result).toMatchObject({ structuredContent: { id: 'collection-1' } });
    const [input, received] = (registrations[0]!.invoke as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(input).toEqual({ collectionId: 'collection-1' });
    expect(received).toMatchObject({
      binding: { kind: 'authenticated', principalId: 'principal-read' },
      scope: ['collections:read'],
    });
    expect(received.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('threads anonymous and authenticated bindings without conflating identities', async () => {
    const { core, registrations } = toolHarness();
    await core.callTool(anonymousReadContext(), 'collections.get', { collectionId: 'collection-1' });
    await core.callTool(readContext(), 'collections.get', { collectionId: 'collection-1' });
    const received = (registrations[0]!.invoke as ReturnType<typeof vi.fn>).mock.calls.map(([, context]) => context);
    expect(received[0].binding).toMatchObject({ kind: 'anonymous', principalId: 'public' });
    expect(received[1].binding).toMatchObject({ kind: 'authenticated', principalId: 'principal-read' });
  });

  it('rejects unknown and invalid Tool names before the execution port', async () => {
    const { core, registrations } = toolHarness();
    await expect(core.callTool(readContext(), 'collections.list', { collectionId: 'collection-1' }))
      .rejects.toBeInstanceOf(McpUnknownToolError);
    await expect(core.callTool(readContext(), 'bad name', {})).rejects.toBeInstanceOf(McpInvalidToolNameError);
    await expect(core.callTool(readContext(), '', {})).rejects.toBeInstanceOf(McpInvalidToolNameError);
    expect(registrations[0]!.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed contexts and honors abort at entry and mid-flight', async () => {
    const { core, registrations } = toolHarness();
    const malformed = Object.freeze({ binding: undefined, scope: [], budget: {}, abortSignal: new AbortController().signal, authorization: {} });
    await expect(core.callTool(malformed as never, 'collections.get', { collectionId: 'collection-1' }))
      .rejects.toBeInstanceOf(McpReadRequestContextError);

    const controller = new AbortController();
    controller.abort();
    await expect(core.callTool(readContext({ abortSignal: controller.signal }), 'collections.get', { collectionId: 'collection-1' }))
      .rejects.toBeInstanceOf(McpReadRequestAbortedError);
    expect(registrations[0]!.invoke).not.toHaveBeenCalled();

    let resolveInvoke!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolvePromise) => { resolveInvoke = resolvePromise; });
    const inflight = toolHarness(toolRegistrations({ invoke: vi.fn(() => pending) }));
    const inflightController = new AbortController();
    const operation = inflight.core.callTool(
      readContext({ abortSignal: inflightController.signal }),
      'collections.get',
      { collectionId: 'collection-1' },
    );
    inflightController.abort();
    resolveInvoke(Object.freeze({ structuredContent: Object.freeze({ id: 'collection-1' }) }));
    await expect(operation).rejects.toBeInstanceOf(McpReadRequestAbortedError);
  });

  it('hides application exceptions and secrets, and preserves schema input errors', async () => {
    const secret = 'Bearer tool-private-secret';
    const throwing = toolHarness(toolRegistrations({ invoke: vi.fn(async () => { throw new Error(`boom ${secret}`); }) }));
    const error = await captureRejection(() => throwing.core.callTool(readContext(), 'collections.get', { collectionId: 'collection-1' }));
    expect(error).toBeInstanceOf(McpToolOutputUnavailableError);
    expect(serialized(error)).not.toContain(secret);
    expect(serialized(error)).toContain('MCP Tool output is unavailable.');

    const { core } = toolHarness();
    const schemaError = await captureRejection(() => core.callTool(readContext(), 'collections.get', {}));
    expect(schemaError).toBeInstanceOf(McpToolInputError);
    expect(schemaError).toMatchObject({ code: 'invalid_tool_input' });
  });

  it('rejects oversized tool output against the per-request budget', async () => {
    // The budget must be large enough to snapshot the fixture trusted context
    // (scope + authorization residual ≈ 239 bytes under the 4x string cost model)
    // but small enough to reject the 10,000-byte tool output (≈ 40,000 bytes).
    const budget = resolveMcpResourceReadBudget({ maxBytes: 256, maxNodes: 8, maxDepth: 4 });
    const big = toolHarness(toolRegistrations({
      invoke: vi.fn(async () => ({ structuredContent: { value: 'x'.repeat(10_000) } })),
    }));
    await expect(big.core.callTool(readContext({ budget }), 'collections.get', { collectionId: 'collection-1' }))
      .rejects.toBeInstanceOf(McpToolOutputUnavailableError);
  });

  it('serves concurrent tool calls with isolated contexts on one shared core', async () => {
    const { core, registrations } = toolHarness();
    const alice = readContext({ binding: authenticatedBinding({ principalId: 'alice' }) });
    const bob = readContext({ binding: authenticatedBinding({ principalId: 'bob' }) });
    const results = await Promise.all([
      core.callTool(alice, 'collections.get', { collectionId: 'collection-1' }),
      core.callTool(bob, 'collections.get', { collectionId: 'collection-1' }),
    ]);
    expect(results[0]).toMatchObject({ structuredContent: { id: 'collection-1' } });
    expect(results[1]).toMatchObject({ structuredContent: { id: 'collection-1' } });
    const contexts = (registrations[0]!.invoke as ReturnType<typeof vi.fn>).mock.calls.map(([, context]) => context);
    expect(contexts.map((context: { binding: { principalId: string } }) => context.binding.principalId)).toEqual(['alice', 'bob']);
  });

  it('keeps no retained context across tool calls', async () => {
    const { core, registrations } = toolHarness();
    await core.callTool(readContext(), 'collections.get', { collectionId: 'collection-1' });
    await core.callTool(anonymousReadContext(), 'collections.get', { collectionId: 'collection-1' });
    expect(Object.keys(core).sort()).toEqual(['callTool', 'listTools']);
    expect((registrations[0]!.invoke as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it('keeps the Tool fake ports protocol-neutral (no wire, session, or transport types)', () => {
    const registration: McpToolRegistration = toolRegistrations()[0]!;
    expect(Object.keys(registration.definition).sort()).toEqual(['description', 'inputSchema', 'name']);
    for (const name of ['headers', 'jsonRpc', 'request', 'transport', 'sessionId', 'notifications'] as const) {
      expect((registration.definition as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

describe(`Sync Session non-collateral and removed API absence ${evidence}`, () => {
  it('keeps the COLP Sync Session module intact and separate from the stateless core', () => {
    expect(typeof assertVerifiedSyncSession).toBe('function');
    expect(typeof SyncSessionGateDeniedError).toBe('function');
    expect(() => assertVerifiedSyncSession({ state: 'not_found' } as never)).toThrow(SyncSessionGateDeniedError);

    const context = readContext();
    expect((context as unknown as Record<string, unknown>).sessionId).toBeUndefined();
    for (const file of ['resources.ts', 'tools.ts']) {
      const source = readFileSync(
        resolve(import.meta.dirname, '..', '..', 'src', 'mcp', 'shared', file),
        'utf8',
      );
      expect(source, file).not.toMatch(/\bsessionId\b/u);
      expect(source, file).not.toMatch(/\bsubscribeResource\b|\bunsubscribeResource\b/u);
      expect(source, file).not.toMatch(/@modelcontextprotocol|sdk-boundary/u);
    }
  });

  it('no longer exports the removed Session-oriented Resource Server API from the public boundary', () => {
    const surface = mcpBoundary as unknown as Record<string, unknown>;
    for (const name of [
      'createMcpReadResourceServer',
      'createMcpReadResourceGateway',
      'createMcpResourceServer',
      'McpReadResourceServerSession',
      'McpReadResourceServer',
      'McpResourceServerError',
      'McpReadResourceApplicationServicePort',
      'McpResourceNotificationSink',
      'McpSubscriptionAuthorization',
    ] as const) {
      expect(surface[name], name).toBeUndefined();
    }
  });
});
