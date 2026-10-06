/**
 * MCP coverage hardening — legacy mount, read client and shared-core gaps.
 *
 * Covers the remaining fail-closed branches in `src/mcp/write-mount.ts`,
 * `src/mcp/collections-get.ts`, `src/mcp/read-client.ts`, the shared
 * stateless cores (`shared/tools.ts`, `shared/resources.ts`) and small
 * defensive helpers (`safe-data.ts`, `shared/change-signal.ts`,
 * `tool-input.ts`, `shared/authorization.ts`). Each case asserts a stable
 * public observation so an inverted guard would fail the test.
 */
import { readFile } from 'node:fs/promises';

import { changePlanOptions } from './mcp-2026-07-28-write-adapter-fixture.js';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '../../src/types/index.js';
import {
  McpWriteMountConfigurationError,
  createMcpWriteMountAdapter,
  isMcpWriteToolName,
} from '../../src/mcp/write-mount.js';
import { createCollectionsGetTool, createMcpReadToolGateway } from '../../src/mcp/collections-get.js';
import {
  McpReadClientConfigurationError,
  McpReadClientError,
  createMcpReadClient,
  type McpReadClientOptions,
} from '../../src/mcp/read-client.js';
import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';
import { snapshotMcpData } from '../../src/mcp/safe-data.js';
import { snapshotMcpChangeSignal } from '../../src/mcp/shared/change-signal.js';
import { containsRawSecretMarker } from '../../src/mcp/shared/authorization.js';
import { createMcpToolInputValidator } from '../../src/mcp/tool-input.js';
import { McpToolOutputUnavailableError, createMcpStatelessToolCore } from '../../src/mcp/shared/tools.js';
import {
  McpReadRequestContextError,
  McpResourceRequestError,
  createMcpStatelessReadCore,
  resolveMcpResourceReadBudget,
} from '../../src/mcp/shared/resources.js';
import { readContext } from './read-trusted-context-fixture.js';

const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

async function fixture(): Promise<Manifest> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
}

function changePlanPorts() {
  return changePlanOptions();
}

describe('MCP write mount — fail-closed mount resolution', () => {
  it('classifies write tool names and non-string inputs', async () => {
    expect(isMcpWriteToolName('changes.plan')).toBe(true);
    expect(isMcpWriteToolName('collections.update')).toBe(true);
    expect(isMcpWriteToolName(42 as never)).toBe(false);
  });

  it('rejects non-object options and missing mountId', async () => {
    const manifest = await fixture();
    expect(() => createMcpWriteMountAdapter(manifest, null as never))
      .toThrowError(expect.objectContaining({ code: 'mcp_write_mount_not_found' }));
  });

  it('fails closed on missing profiles, disabled tools and mismatched capabilities', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    const withoutPublisher = {
      ...manifest,
      mounts: [{ ...mount, profiles: [...mount.profiles.filter((p) => p !== 'publisher')] }],
    } as unknown as Manifest;
    expect(() => createMcpWriteMountAdapter(withoutPublisher, { mountId: mount.id, writeTools: { changePlan: changePlanPorts() } }))
      .toThrowError(McpWriteMountConfigurationError);

    const toolsDisabled = {
      ...manifest,
      mounts: [{ ...mount, features: { ...mount.features, mcp: { ...mount.features.mcp, tools: false } } }],
    } as unknown as Manifest;
    expect(() => createMcpWriteMountAdapter(toolsDisabled, { mountId: mount.id, writeTools: { changePlan: changePlanPorts() } }))
      .toThrowError(McpWriteMountConfigurationError);

    const resourcesDisabled = {
      ...manifest,
      mounts: [{ ...mount, features: { ...mount.features, mcp: { ...mount.features.mcp, resources: false } } }],
    } as unknown as Manifest;
    expect(() => createMcpWriteMountAdapter(resourcesDisabled, { mountId: mount.id, writeTools: { changePlan: changePlanPorts() } }))
      .toThrowError(McpWriteMountConfigurationError);
  });
});

describe('MCP collections.get — gateway option and invocation hardening', () => {
  const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
  const codec = createMcpResourceUriCodec(Object.freeze({ serverUuid }));

  it('rejects malformed read gateway options', () => {
    expect(() => createMcpReadToolGateway('nope' as never)).toThrow(TypeError);
    expect(() => createMcpReadToolGateway({ snapshotLink: 'nope' } as never)).toThrow(TypeError);
    expect(() => createMcpReadToolGateway({ unexpected: 1 } as never)).toThrow(TypeError);
    expect(() => createMcpReadToolGateway({
      snapshotLink: { manifest: { serverUuid }, applicationService: {} },
    } as never)).toThrow(TypeError);
    expect(() => createMcpReadToolGateway({
      snapshotLink: { manifest: undefined, applicationService: {} },
    } as never)).toThrow(TypeError);
  });

  it('hides application failures behind McpToolOutputUnavailableError', async () => {
    const tool = createCollectionsGetTool({
      getCollection: vi.fn(async () => { throw new Error('boom'); }),
    });
    await expect(tool.invoke({ collectionId: 'collection-1' }, readContext()))
      .rejects.toBeInstanceOf(McpToolOutputUnavailableError);
  });
});

describe('MCP read client — configuration, timeout and result hardening', () => {
  const collectionId = 'collection-1';
  const input = Object.freeze({ collectionId });
  const result = Object.freeze({ structuredContent: Object.freeze({ id: collectionId }) });

  function harness(overrides: Partial<McpReadClientOptions> = {}) {
    const gateway = { callTool: vi.fn(async () => result) };
    const presenter = { displayToolCall: vi.fn(async () => undefined) };
    const recorder = { recordToolCall: vi.fn(async () => undefined) };
    const resultValidator = { validateToolResult: vi.fn((_n, value) => value) };
    const targetResolver = { resolveTargetCollection: vi.fn(() => collectionId) };
    const options: McpReadClientOptions = {
      gateway, presenter, recorder, resultValidator, targetResolver,
      timeoutMs: 1_000,
      maxResultBytes: 4_096,
      ...overrides,
    };
    return { client: createMcpReadClient(options), gateway, recorder, resultValidator, targetResolver, options };
  }

  it('rejects malformed client options and ports', () => {
    expect(() => createMcpReadClient(null as never)).toThrow(McpReadClientConfigurationError);
    expect(() => createMcpReadClient({} as never)).toThrow(McpReadClientConfigurationError);
    const { options } = harness();
    expect(() => createMcpReadClient({ ...options, gateway: { callTool: 'nope' } } as never))
      .toThrow(McpReadClientConfigurationError);
    expect(() => createMcpReadClient({ ...options, extra: 1 } as never)).toThrow(McpReadClientConfigurationError);
  });

  it('rejects a wrong-prototype input and a non-object validated result', async () => {
    const { client } = harness();
    class HostileInput { collectionId = collectionId; }
    await expect(client.callTool('collections.get', new HostileInput())).rejects.toBeInstanceOf(McpReadClientError);

    const badValidator = harness({ resultValidator: { validateToolResult: vi.fn(() => 'nope') } });
    await expect(badValidator.client.callTool('collections.get', input)).rejects.toBeInstanceOf(McpReadClientError);
  });

  it('records a timed-out gateway call', async () => {
    const { client, recorder } = harness({
      timeoutMs: 20,
      gateway: { callTool: vi.fn(() => new Promise(() => undefined)) },
    });
    await expect(client.callTool('collections.get', input)).rejects.toBeInstanceOf(McpReadClientError);
    expect(recorder.recordToolCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'timed_out' }));
  });
});

describe('shared stateless cores — context, output and option hardening', () => {
  const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
  const codec = createMcpResourceUriCodec(Object.freeze({ serverUuid }));
  const metadataUri = codec.collectionMetadata('collection-1');

  function listResult(uris: readonly string[] = [metadataUri]) {
    return {
      resources: uris.map((uri) => ({
        uri, name: 'Collection', mimeType: 'application/json', provenance: { origin: 'internal' as const },
      })),
    };
  }

  it('rejects class-prototype options and accessor budget limits', () => {
    class Projection {}
    expect(() => createMcpStatelessReadCore({ projection: new Projection(), uriCodec: codec } as never))
      .toThrow(TypeError);
    expect(() => createMcpStatelessToolCore({ tools: new (class {})() } as never)).toThrow(TypeError);
    expect(() => resolveMcpResourceReadBudget(Object.defineProperty({}, 'maxListItems', { get: () => 5 })))
      .not.toThrow();
    expect(() => resolveMcpResourceReadBudget(Object.freeze({ maxListItems: 0 }))).toThrow(TypeError);
  });

  it('rejects invalid trusted contexts, list provenance and result shapes', async () => {
    const contexts: unknown[] = [
      { binding: {}, scope: [123], budget: undefined, abortSignal: new AbortController().signal, authorization: {} },
      { binding: {}, scope: [], budget: undefined, abortSignal: 'nope', authorization: {} },
      Object.defineProperty({ binding: {}, scope: [], budget: undefined, authorization: {} }, 'abortSignal', {
        enumerable: true, get() { throw new Error('accessor'); },
      }),
    ];
    for (const candidate of contexts) {
      const badCore = createMcpStatelessReadCore({ projection: { listResources: vi.fn(), readResource: vi.fn() }, uriCodec: codec } as never);
      await expect(badCore.listResources(candidate as never, {})).rejects.toBeInstanceOf(McpReadRequestContextError);
    }

    const badProvenance = createMcpStatelessReadCore({
      projection: { listResources: vi.fn(async () => ({ resources: [{ uri: metadataUri, name: 'x', mimeType: 'm', provenance: 'nope' }] })), readResource: vi.fn() },
      uriCodec: codec,
    } as never);
    await expect(badProvenance.listResources(readContext(), {})).rejects.toBeInstanceOf(McpResourceRequestError);

    const badName = createMcpStatelessReadCore({
      projection: { listResources: vi.fn(async () => ({ resources: [{ uri: metadataUri, name: 42, mimeType: 'm', provenance: { origin: 'internal' } }] })), readResource: vi.fn() },
      uriCodec: codec,
    } as never);
    await expect(badName.listResources(readContext(), {})).rejects.toBeInstanceOf(McpResourceRequestError);

    const badReadShape = createMcpStatelessReadCore({
      projection: { listResources: vi.fn(async () => listResult()), readResource: vi.fn(async () => 'nope') },
      uriCodec: codec,
    } as never);
    await expect(badReadShape.readResource(readContext(), { uri: metadataUri })).rejects.toBeInstanceOf(McpResourceRequestError);
  });
});

describe('small MCP defensive helpers', () => {
  it('rejects over-budget snapshot data, symbols and non-JSON values', () => {
    expect(() => snapshotMcpData({ a: { b: 1 } }, Object.freeze({ maxNodes: 1 }))).toThrow(TypeError);
    expect(() => snapshotMcpData([1, Symbol('x')] as never)).toThrow(TypeError);
    expect(() => snapshotMcpData({ a: 1 }, Object.freeze({ maxBytes: 1 }))).toThrow(TypeError);
    expect(() => snapshotMcpData({ a: 1 })).not.toThrow();
  });

  it('rejects malformed change signals', () => {
    expect(() => snapshotMcpChangeSignal({ type: 'bogus', sequence: 1, timestamp: 1 })).toThrow(TypeError);
    expect(() => snapshotMcpChangeSignal({ type: 'resource-updated', sequence: 1, timestamp: 1 })).toThrow(TypeError);
    expect(() => snapshotMcpChangeSignal(Object.defineProperty(
      { type: 'tool-list-changed', sequence: 1, timestamp: 1 }, 'sequence', { get: () => 1 },
    ))).toThrow(TypeError);
    expect(() => snapshotMcpChangeSignal({ type: 'tool-list-changed', sequence: 1, timestamp: 1 })).not.toThrow();
  });

  it('rejects Proxy/accessor tool inputs and detects secret markers with symbol keys', () => {
    const validator = createMcpToolInputValidator(Object.freeze({
      type: 'object', additionalProperties: false, properties: {}, required: [],
    }));
    const withSymbol: Record<string | symbol, unknown> = {};
    withSymbol[Symbol('k')] = 1;
    expect(() => validator(withSymbol)).not.toThrow();
    expect(() => validator(new Proxy({}, {}) as never)).toThrow(TypeError);
    expect(containsRawSecretMarker({ [Symbol('k')]: 'x' } as never)).toBe(false);
    expect(containsRawSecretMarker({ apiKey: 'colp_sk_live_x' })).toBe(true);
  });
});
