import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { collectionProtocolSchema, createAjv } from '../../src/schema/index.js';
import {
  collectionsGetToolDefinition,
  createMcpReadToolGateway,
} from '../../src/mcp/collections-get.js';
import {
  createAnonymousMcpReadExposure,
  createMcpReadExposure,
} from '../../src/mcp/read-mount.js';
import { McpToolInputError, createMcpToolInputValidator } from '../../src/mcp/tool-input.js';
import type { Manifest } from '../../src/types/index.js';
import { readContext } from './read-trusted-context-fixture.js';

interface ToolInputSchema {
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly required?: unknown;
  readonly additionalProperties?: unknown;
  readonly [keyword: string]: unknown;
}

interface ToolDefinition {
  readonly name: string;
  readonly inputSchema: ToolInputSchema;
  readonly [field: string]: unknown;
}

interface ToolGateway {
  readonly listTools: () => readonly ToolDefinition[];
  readonly callTool: (
    name: string,
    input: unknown,
    context: import('../../src/mcp/shared/resources.js').McpTrustedReadRequestContext,
  ) => Promise<Readonly<{ structuredContent: unknown }>>;
}

interface CollectionReadPort {
  readonly getCollection: (
    input: Readonly<{ collectionId: string }>,
  ) => unknown | PromiseLike<unknown>;
}

interface ReadExposure {
  readonly endpoint: string;
  readonly resources: true;
  readonly tools?: ToolGateway;
}

interface AnonymousReadExposure {
  readonly endpoint: string;
  readonly resources: true;
  readonly readResource: (uri: string) => Promise<unknown>;
}

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

interface SnapshotLinkPort {
  readonly getCollectionSnapshotLinkMetadata: (
    input: Readonly<{ collectionId: string }>,
  ) => unknown | PromiseLike<unknown>;
}

interface PublicMcpApi {
  readonly collectionsGetToolDefinition?: ToolDefinition;
  readonly createMcpReadToolGateway?: (
    port: CollectionReadPort,
    options?: Readonly<{
      snapshotLink?: Readonly<{
        manifest: Readonly<{ serverUuid: string }>;
        applicationService: SnapshotLinkPort;
      }>;
    }>,
  ) => ToolGateway;
  readonly createMcpReadExposure?: (
    manifest: Manifest,
    options: Readonly<{
      mountId: string;
      applicationService?: CollectionReadPort;
      snapshotLinkService?: SnapshotLinkPort;
      [field: string]: unknown;
    }>,
  ) => ReadExposure;
  readonly createAnonymousMcpReadExposure?: (
    manifest: Manifest,
    options: Readonly<{
      mountId: string;
      publicAccess: Readonly<{
        readPublicResource: (input: unknown) => unknown | PromiseLike<unknown>;
      }>;
    }>,
  ) => AnonymousReadExposure;
  readonly createMcpToolInputValidator?: unknown;
}

interface ToolCase {
  readonly valid: Readonly<Record<string, unknown>>;
  readonly missing: Readonly<Record<string, unknown>>;
  readonly invalid: Readonly<Record<string, unknown>>;
  readonly extra: Readonly<Record<string, unknown>>;
}

const evidence = '[evidence:mcp.all-tool-input-schemas]';
const collectionId = 'collection-1';
const toolNamePattern = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/u;
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

// This table is deliberately exhaustive for the currently published read Tool API.
// Adding a Tool to listTools() must also add its positive and negative black-box inputs here.
const toolCases = Object.freeze({
  'collections.get': Object.freeze({
    valid: Object.freeze({ collectionId }),
    missing: Object.freeze({}),
    invalid: Object.freeze({ collectionId: null }),
    extra: Object.freeze({ collectionId, unexpected: 'not-accepted' }),
  }),
} as const satisfies Readonly<Record<string, ToolCase>>);

function readPort(result: unknown = Object.freeze({ id: collectionId })) {
  return {
    getCollection: vi.fn(async (_input: Readonly<{ collectionId: string }>) => result),
  };
}

function gateway(port = readPort()): {
  readonly gateway: ToolGateway;
  readonly port: typeof port;
} {
  expect(
    typeof createMcpReadToolGateway,
    'MCP-0011 needs a public read Tool gateway whose complete list can be inspected',
  ).toBe('function');
  return {
    gateway: createMcpReadToolGateway(port) as unknown as ToolGateway,
    port,
  };
}

function definitions(gatewayUnderTest: ToolGateway): readonly ToolDefinition[] {
  const listed = gatewayUnderTest.listTools();
  expect(listed.length, 'the current read gateway must publish at least one Tool').toBeGreaterThan(0);
  return listed;
}

function toolCase(name: string): ToolCase {
  expect(
    Object.hasOwn(toolCases, name),
    `published Tool ${name} needs an exhaustive valid/missing/invalid/extra input case`,
  ).toBe(true);
  return toolCases[name as keyof typeof toolCases];
}

function compileInputSchema(definition: ToolDefinition) {
  const ajv = createAjv({ allErrors: true, ownProperties: true });
  ajv.addSchema(collectionProtocolSchema, collectionProtocolSchema.$id);
  return ajv.compile(definition.inputSchema);
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) expectDeeplyFrozen(descriptor.value, seen);
  }
}

async function fixture(): Promise<Manifest> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
}

function makeReadMount(manifest: Manifest, tools: boolean): Manifest['mounts'][number] {
  const mount = manifest.mounts[0]!;
  mount.profiles = ['core', 'mcp-read'];
  mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools };
  return mount;
}

function requireReadExposure(): (
  manifest: Manifest,
  options: Readonly<{ mountId: string; [field: string]: unknown }>,
) => ReadExposure {
  expect(typeof createMcpReadExposure).toBe('function');
  return createMcpReadExposure as unknown as (
    manifest: Manifest,
    options: Readonly<{ mountId: string; [field: string]: unknown }>,
  ) => ReadExposure;
}

function requireAnonymousExposure(): (
  manifest: Manifest,
  options: Readonly<{ mountId: string; [field: string]: unknown }>,
) => AnonymousReadExposure {
  expect(typeof createAnonymousMcpReadExposure).toBe('function');
  return createAnonymousMcpReadExposure as unknown as (
    manifest: Manifest,
    options: Readonly<{ mountId: string; [field: string]: unknown }>,
  ) => AnonymousReadExposure;
}

async function rejection(operation: () => unknown | PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}

describe(`MCP-0011 all Tool input schemas ${evidence}`, () => {
  it(`keeps the root and MCP gateway exports identical ${evidence}`, () => {
    expect(createMcpReadToolGateway).toBe(createMcpReadToolGateway);
    expect(collectionsGetToolDefinition).toBeDefined();
    expect(typeof createMcpToolInputValidator).toBe('function');
  });

  it(`enumerates the complete expected current read Tool API ${evidence}`, () => {
    const listed = definitions(gateway().gateway);
    const names = listed.map(({ name }) => name);

    expect(names).toEqual(Object.keys(toolCases));
    expect(listed).toHaveLength(1);
    expect(names).toEqual(['collections.get']);
  });

  it(`optionally publishes collections.get_snapshot when snapshotLink is configured ${evidence}`, async () => {
    const manifest = await fixture();
    const getCollectionSnapshotLinkMetadata = vi.fn(async () => Object.freeze({
      name: 'Interface Systems',
      lastModified: '2026-07-16T06:30:00Z',
    }));
    const created = {
      gateway: createMcpReadToolGateway(readPort(), {
        snapshotLink: {
          manifest: { serverUuid: manifest.serverUuid },
          applicationService: { getCollectionSnapshotLinkMetadata },
        },
      }),
    };
    const names = created.gateway.listTools().map(({ name }) => name);

    expect(names).toEqual(['collections.get', 'collections.get_snapshot']);
    await expect(
      created.gateway.callTool('collections.get_snapshot', { collectionId }, readContext()),
    ).resolves.toMatchObject({
      content: [{
        type: 'resource_link',
        name: 'Interface Systems',
        mimeType: 'application/vnd.collection-protocol.snapshot+json',
      }],
    });
    expect(getCollectionSnapshotLinkMetadata).toHaveBeenCalledWith({ collectionId }, expect.any(Object));
  });

  it(`optionally wires collections.get_snapshot through mount snapshotLinkService ${evidence}`, async () => {
    const manifest = await fixture();
    const mount = makeReadMount(manifest, true);
    const getCollectionSnapshotLinkMetadata = vi.fn(async () => Object.freeze({
      name: 'Mounted Snapshot',
      lastModified: '2026-07-16T06:30:00Z',
    }));
    const exposure = requireReadExposure()(manifest, {
      mountId: mount.id,
      applicationService: readPort(),
      snapshotLinkService: { getCollectionSnapshotLinkMetadata },
    });

    expect(exposure.tools?.listTools().map(({ name }) => name)).toEqual([
      'collections.get',
      'collections.get_snapshot',
    ]);
    await expect(
      exposure.tools?.callTool('collections.get_snapshot', { collectionId }, readContext()),
    ).resolves.toMatchObject({
      content: [{ type: 'resource_link', name: 'Mounted Snapshot' }],
    });
  });

  it(`gives every definition an own inputSchema and a unique legal name ${evidence}`, () => {
    const listed = definitions(gateway().gateway);
    const names = listed.map(({ name }) => name);

    for (const definition of listed) {
      const inputSchemaDescriptor = Object.getOwnPropertyDescriptor(definition, 'inputSchema');
      expect(inputSchemaDescriptor).toBeDefined();
      expect(inputSchemaDescriptor && 'value' in inputSchemaDescriptor).toBe(true);
      expect(typeof definition.inputSchema).toBe('object');
      expect(definition.inputSchema).not.toBeNull();
      expect(definition.name.length).toBeLessThanOrEqual(128);
      expect(definition.name).toMatch(toolNamePattern);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it(`compiles every published inputSchema with the project Ajv and canonical schema ${evidence}`, () => {
    for (const definition of definitions(gateway().gateway)) {
      expect(() => compileInputSchema(definition)).not.toThrow();
    }
  });

  it(`accepts at least one schema-valid input for every published Tool ${evidence}`, () => {
    for (const definition of definitions(gateway().gateway)) {
      const validate = compileInputSchema(definition);
      expect(validate(toolCase(definition.name).valid), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it(`dispatches every Tool's valid input through the read service ${evidence}`, async () => {
    const created = gateway();
    const listed = definitions(created.gateway);

    for (const definition of listed) {
      await expect(
        created.gateway.callTool(definition.name, toolCase(definition.name).valid, readContext()),
      ).resolves.toHaveProperty('structuredContent');
    }
    expect(created.port.getCollection).toHaveBeenCalledTimes(listed.length);
  });

  it(`keeps published-schema and runtime acceptance in parity for every case ${evidence}`, async () => {
    for (const definition of definitions(gateway().gateway)) {
      const cases = toolCase(definition.name);
      for (const candidate of [cases.valid, cases.missing, cases.invalid, cases.extra]) {
        const created = gateway();
        const publishedAccepts = compileInputSchema(definition)(candidate);
        let runtimeAccepts = true;
        try {
          await created.gateway.callTool(definition.name, candidate, readContext());
        } catch {
          runtimeAccepts = false;
        }

        expect(runtimeAccepts).toBe(publishedAccepts);
      }
    }
  });

  it(`rejects every Tool's missing required input before its service ${evidence}`, async () => {
    for (const definition of definitions(gateway().gateway)) {
      const created = gateway();
      await expectToolInputError(
        created.gateway.callTool(definition.name, toolCase(definition.name).missing, readContext()),
      );
      expect(created.port.getCollection).not.toHaveBeenCalled();
    }
  });

  it(`rejects every Tool's invalid typed input before its service ${evidence}`, async () => {
    for (const definition of definitions(gateway().gateway)) {
      const created = gateway();
      await expectToolInputError(
        created.gateway.callTool(definition.name, toolCase(definition.name).invalid, readContext()),
      );
      expect(created.port.getCollection).not.toHaveBeenCalled();
    }
  });

  it(`rejects every Tool's additional input before its service ${evidence}`, async () => {
    for (const definition of definitions(gateway().gateway)) {
      const created = gateway();
      await expectToolInputError(
        created.gateway.callTool(definition.name, toolCase(definition.name).extra, readContext()),
      );
      expect(created.port.getCollection).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, null, [], 'collection-1', 1] as const)(
    `rejects non-object boundary input %j before every Tool service ${evidence}`,
    async (input) => {
      for (const definition of definitions(gateway().gateway)) {
        const created = gateway();
        await expectToolInputError(created.gateway.callTool(definition.name, input, readContext()));
        expect(created.port.getCollection).not.toHaveBeenCalled();
      }
    },
  );

  it(`rejects inherited Tool input before every service ${evidence}`, async () => {
    for (const definition of definitions(gateway().gateway)) {
      const created = gateway();
      const inherited = Object.create(toolCase(definition.name).valid) as Record<string, unknown>;

      await expectToolInputError(created.gateway.callTool(definition.name, inherited, readContext()));
      expect(created.port.getCollection).not.toHaveBeenCalled();
    }
  });

  it(`rejects accessor Tool input without invoking it or the service ${evidence}`, async () => {
    for (const definition of definitions(gateway().gateway)) {
      const created = gateway();
      const getter = vi.fn(() => collectionId);
      const accessor = Object.defineProperty({}, 'collectionId', {
        enumerable: true,
        get: getter,
      });

      await expectToolInputError(created.gateway.callTool(definition.name, accessor, readContext()));
      expect(getter).not.toHaveBeenCalled();
      expect(created.port.getCollection).not.toHaveBeenCalled();
    }
  });

  it(`deep-freezes the list, definitions, and every inputSchema ${evidence}`, () => {
    const listed = definitions(gateway().gateway);

    expectDeeplyFrozen(listed);
    for (const definition of listed) {
      expectDeeplyFrozen(definition);
      expectDeeplyFrozen(definition.inputSchema);
    }
  });

  it(`returns a stable detached list unaffected by caller mutation attempts ${evidence}`, () => {
    const created = gateway();
    const first = created.gateway.listTools();
    const detachedCopy = structuredClone(first) as unknown as Array<Record<string, unknown>>;
    detachedCopy.push({ name: 'nodes.create' });
    detachedCopy[0]!.name = 'collections.delete';
    (detachedCopy[0]!.inputSchema as Record<string, unknown>).additionalProperties = true;

    expect(created.gateway.listTools()).toBe(first);
    expect(created.gateway.listTools().map(({ name }) => name)).toEqual(['collections.get']);
    expect(created.gateway.listTools()[0]!.inputSchema.additionalProperties).toBe(false);
  });

  it(`does not accept an extra or schema-less Tool injected through the service port ${evidence}`, () => {
    const injectedDefinition = { name: 'nodes.create' };
    const port = Object.assign(readPort(), {
      tools: [injectedDefinition],
      toolDefinitions: [injectedDefinition],
      listTools: () => [injectedDefinition],
    });
    const created = gateway(port);

    expect(created.gateway.listTools().map(({ name }) => name)).toEqual(['collections.get']);
    expect(JSON.stringify(created.gateway.listTools())).not.toContain('nodes.create');
  });

  it(`does not accept an extra or schema-less Tool injected through mount configuration ${evidence}`, async () => {
    const manifest = await fixture();
    const mount = makeReadMount(manifest, true);
    const injectedDefinition = { name: 'nodes.create' };
    const exposure = requireReadExposure()(manifest, {
      mountId: mount.id,
      applicationService: Object.assign(readPort(), { tools: [injectedDefinition] }),
      tools: [injectedDefinition],
      toolDefinitions: [injectedDefinition],
    });

    expect(exposure.tools?.listTools().map(({ name }) => name)).toEqual(['collections.get']);
  });

  it(`keeps a Resource-only mount free of Tools despite supplied Tool configuration ${evidence}`, async () => {
    const manifest = await fixture();
    const mount = makeReadMount(manifest, false);
    const injectedDefinition = { name: 'nodes.create' };
    const exposure = requireReadExposure()(manifest, {
      mountId: mount.id,
      applicationService: Object.assign(readPort(), { tools: [injectedDefinition] }),
      tools: [injectedDefinition],
    });

    expect(Object.keys(exposure).sort()).toEqual(['endpoint', 'resources']);
    expect(exposure).not.toHaveProperty('tools');
  });

  it(`keeps anonymous exposure Resource-only even when its mount advertises Tools ${evidence}`, async () => {
    const manifest = await fixture();
    const mount = makeReadMount(manifest, true);
    mount.auth.anonymousRead = true;
    const exposure = requireAnonymousExposure()(manifest, {
      mountId: mount.id,
      publicAccess: { readPublicResource: vi.fn(async () => ({ id: collectionId })) },
    });

    expect(Object.keys(exposure).sort()).toEqual(['endpoint', 'readResource', 'resources']);
    expect(exposure).not.toHaveProperty('tools');
  });

  it(`exposes no write Tool, outputSchema, Plan, approval, key, or OAuth surface ${evidence}`, () => {
    const created = gateway();
    const exposed = [
      ...Reflect.ownKeys(created.gateway).map(String),
      ...definitions(created.gateway).flatMap((definition) => [
        ...Reflect.ownKeys(definition).map(String),
        definition.name,
      ]),
    ].join(' ');

    for (const definition of definitions(created.gateway)) {
      expect(definition).not.toHaveProperty('outputSchema');
    }
    expect(exposed).not.toMatch(
      /(?:^|[. _-])(create|update|delete|move|write|plan|commit|approv|key|oauth)(?:$|[. _-])/iu,
    );
    // MCP-0011 only recommends outputSchema for write Tools; this read-only suite does not require one.
  });

  it(`rejects an unknown secret input without echoing its name or value ${evidence}`, async () => {
    const secretName = 'oauthClientSecret';
    const secretValue = 'mcp-secret-value-that-must-not-be-echoed';
    const created = gateway();
    const input = { collectionId, [secretName]: secretValue };

    const error = await rejection(() => created.gateway.callTool('collections.get', input, readContext()));

    expect(created.port.getCollection).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(secretName);
    expect(String(error)).not.toContain(secretValue);
    expect(JSON.stringify(error)).not.toContain(secretName);
    expect(JSON.stringify(error)).not.toContain(secretValue);
  });

  it.each(['collections.list', 'nodes.create', 'access.plan_change'] as const)(
    `rejects unlisted read or write Tool %j before the service ${evidence}`,
    async (name) => {
      const created = gateway();
      await expect(created.gateway.callTool(name, { collectionId }, readContext())).rejects.toMatchObject({
        name: 'McpUnknownToolError',
        code: 'unknown_tool',
      });
      expect(created.port.getCollection).not.toHaveBeenCalled();
    },
  );
});
