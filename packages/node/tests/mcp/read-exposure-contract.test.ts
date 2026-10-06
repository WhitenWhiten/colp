import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '../../src/types/index.js';
import { createMcpReadExposure } from '../../src/mcp/read-mount.js';
import { readContext } from './read-trusted-context-fixture.js';

interface CollectionReadApplicationService {
  readonly getCollection: (input: Readonly<{ collectionId: string }>) => unknown | PromiseLike<unknown>;
}

interface SnapshotLinkApplicationService {
  readonly getCollectionSnapshotLinkMetadata: (
    input: Readonly<{ collectionId: string }>,
  ) => unknown | PromiseLike<unknown>;
}

interface McpReadToolGateway {
  readonly listTools: () => readonly Readonly<{ name: string }>[];
  readonly callTool: (name: string, input: unknown, context: import('../../src/mcp/shared/resources.js').McpTrustedReadRequestContext) => Promise<Readonly<Record<string, unknown>>>;
}

interface McpReadExposure {
  readonly endpoint: string;
  readonly resources: true;
  readonly tools?: McpReadToolGateway;
}

interface McpReadExposureApi {
  readonly createMcpReadExposure?: (
    manifest: Manifest,
    options: Readonly<{
      mountId: string;
      applicationService?: CollectionReadApplicationService;
      snapshotLinkService?: SnapshotLinkApplicationService;
    }>,
  ) => McpReadExposure;
}

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

function requireExposureApi(): (
  manifest: Manifest,
  options: Readonly<{ mountId: string; [field: string]: unknown }>,
) => McpReadExposure {
  expect(typeof createMcpReadExposure, 'MCP-0006 needs a read Mount exposure adapter').toBe('function');
  return createMcpReadExposure as unknown as (
    manifest: Manifest,
    options: Readonly<{ mountId: string; [field: string]: unknown }>,
  ) => McpReadExposure;
}

function makeReadOnly(mount: Manifest['mounts'][number], tools = false): void {
  mount.profiles = ['core', 'mcp-read'];
  mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools };
}

function addMount(manifest: Manifest, id: string, endpoint: string): Manifest['mounts'][number] {
  const mount = structuredClone(manifest.mounts[0]!);
  mount.id = id;
  (mount.endpoints as unknown as { mcp: unknown }).mcp = endpoint;
  makeReadOnly(mount);
  manifest.mounts.push(mount);
  return mount;
}

function readService(result: unknown = Object.freeze({ id: 'collection-1' })) {
  return {
    getCollection: vi.fn(async () => result),
  };
}

describe('MCP-0006 runtime read exposure [evidence:schema.mcp-read-resource-only]', () => {
  it('exposes only the selected Resource-only endpoint and Resources capability [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount);

    const exposure = requireExposureApi()(manifest, { mountId: mount.id });

    expect(typeof createMcpReadExposure).toBe('function');
    expect(exposure).toEqual({ endpoint: mount.endpoints.mcp, resources: true });
    expect(Object.keys(exposure).sort()).toEqual(['endpoint', 'resources']);
    expect(exposure).not.toHaveProperty('tools');
  });

  it('exposes only collections.get when the selected read Mount enables Tools [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount, true);
    const applicationService = readService();

    const exposure = requireExposureApi()(manifest, { mountId: mount.id, applicationService });

    expect(exposure.tools?.listTools().map(({ name }) => name)).toEqual(['collections.get']);
    await expect(
      exposure.tools?.callTool('collections.get', { collectionId: 'collection-1' }, readContext()),
    ).resolves.toEqual({ structuredContent: { id: 'collection-1' } });
    expect(applicationService.getCollection).toHaveBeenCalledWith({ collectionId: 'collection-1' }, expect.any(Object));
  });

  it('optionally publishes collections.get_snapshot when snapshotLinkService is supplied [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount, true);
    const applicationService = readService();
    const getCollectionSnapshotLinkMetadata = vi.fn(async () => Object.freeze({
      name: 'Public Snapshot',
      lastModified: '2026-07-16T06:30:00Z',
    }));

    const exposure = requireExposureApi()(manifest, {
      mountId: mount.id,
      applicationService,
      snapshotLinkService: { getCollectionSnapshotLinkMetadata },
    });

    expect(exposure.tools?.listTools().map(({ name }) => name)).toEqual([
      'collections.get',
      'collections.get_snapshot',
    ]);
    await expect(
      exposure.tools?.callTool('collections.get_snapshot', { collectionId: 'collection-1' }, readContext()),
    ).resolves.toMatchObject({
      content: [{ type: 'resource_link', name: 'Public Snapshot' }],
    });
    expect(getCollectionSnapshotLinkMetadata).toHaveBeenCalledWith({ collectionId: 'collection-1' }, expect.any(Object));
    expect(applicationService.getCollection).not.toHaveBeenCalled();
  });

  it('does not inspect or retain a Tool service for a Resource-only Mount [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount);
    const getCollection = vi.fn();
    const options = { mountId: mount.id } as {
      mountId: string;
      applicationService?: CollectionReadApplicationService;
    };
    const serviceGetter = vi.fn(() => ({ getCollection }));
    Object.defineProperty(options, 'applicationService', { enumerable: true, get: serviceGetter });

    const exposure = requireExposureApi()(manifest, options);

    expect(exposure).not.toHaveProperty('tools');
    expect(serviceGetter).not.toHaveBeenCalled();
    expect(getCollection).not.toHaveBeenCalled();
  });

  it('requires a read application service only when Tools are enabled [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount, true);

    expect(() => requireExposureApi()(manifest, { mountId: mount.id })).toThrow();
  });

  it.each([
    ['false', false],
    ['missing', undefined],
    ['a string lookalike', 'true'],
    ['a numeric lookalike', 1],
    ['an object lookalike', { enabled: true }],
  ] as const)(
    'fails closed when the selected read Mount has %s Resources capability [evidence:schema.mcp-read-resource-only]',
    async (_label, resources) => {
      const manifest = await fixture();
      const mount = manifest.mounts[0]!;
      makeReadOnly(mount);
      if (resources === undefined) {
        delete (mount.features.mcp as { resources?: unknown }).resources;
      } else {
        (mount.features.mcp as { resources: unknown }).resources = resources;
      }

      expect(() => requireExposureApi()(manifest, { mountId: mount.id })).toThrow();
    },
  );

  it.each([
    ['missing', undefined],
    ['an empty string', ''],
    ['a relative URL', '/mcp'],
    ['an HTTP URL', 'http://alice.example/mcp'],
    ['a template with a variable', 'https://alice.example/mcp/{collectionId}'],
  ] as const)(
    'fails closed when the selected read Mount has %s MCP endpoint [evidence:schema.mcp-read-resource-only]',
    async (_label, endpoint) => {
      const manifest = await fixture();
      const mount = manifest.mounts[0]!;
      makeReadOnly(mount);
      if (endpoint === undefined) delete mount.endpoints.mcp;
      else (mount.endpoints as unknown as { mcp: unknown }).mcp = endpoint;

      expect(() => requireExposureApi()(manifest, { mountId: mount.id })).toThrow();
    },
  );

  it('rejects a non-mcp-read Mount even when it advertises an MCP-shaped endpoint and capabilities [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    mount.profiles = ['core'];
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };

    expect(() => requireExposureApi()(manifest, { mountId: mount.id })).toThrow();
  });

  it.each([
    ['an unknown ID', 'missing'],
    ['an empty ID', ''],
    ['a non-string ID', 1],
    ['no owned ID', undefined],
  ] as const)(
    'fails closed for %s instead of selecting an implicit Mount [evidence:schema.mcp-read-resource-only]',
    async (_label, mountId) => {
      const manifest = await fixture();
      makeReadOnly(manifest.mounts[0]!);

      expect(() => requireExposureApi()(manifest, { mountId } as never)).toThrow();
    },
  );

  it('rejects duplicate IDs as ambiguous instead of taking the first matching Mount [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    makeReadOnly(selected);
    addMount(manifest, selected.id, 'https://mirror.example/mcp');

    expect(() => requireExposureApi()(manifest, { mountId: selected.id })).toThrow();
  });

  it('requires mountId to be an own data property [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount);
    const inherited = Object.create({ mountId: mount.id }) as { mountId: string };

    expect(() => requireExposureApi()(manifest, inherited)).toThrow();
  });

  it('rejects a mountId accessor without invoking it [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount);
    const options = {} as { mountId: string };
    const mountIdGetter = vi.fn(() => mount.id);
    Object.defineProperty(options, 'mountId', { enumerable: true, get: mountIdGetter });

    expect(() => requireExposureApi()(manifest, options)).toThrow();
    expect(mountIdGetter).not.toHaveBeenCalled();
  });

  it('selects one exact Mount from multiple eligible read Mounts [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    makeReadOnly(manifest.mounts[0]!);
    const selected = addMount(manifest, 'secondary', 'https://secondary.example/mcp');

    const exposure = requireExposureApi()(manifest, { mountId: selected.id });

    expect(exposure.endpoint).toBe(selected.endpoints.mcp);
  });

  it('does not borrow Resources capability from another Mount [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    makeReadOnly(selected);
    selected.features.mcp!.resources = false;
    addMount(manifest, 'capable', 'https://capable.example/mcp');

    expect(() => requireExposureApi()(manifest, { mountId: selected.id })).toThrow();
  });

  it('does not borrow an MCP endpoint from another Mount [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    makeReadOnly(selected);
    delete selected.endpoints.mcp;
    addMount(manifest, 'endpoint-owner', 'https://endpoint-owner.example/mcp');

    expect(() => requireExposureApi()(manifest, { mountId: selected.id })).toThrow();
  });

  it('does not borrow the Tools capability or service from another Mount [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    makeReadOnly(selected);
    const other = addMount(manifest, 'tools-enabled', 'https://tools.example/mcp');
    other.features.mcp!.tools = true;
    const applicationService = readService();

    const exposure = requireExposureApi()(manifest, { mountId: selected.id, applicationService });

    expect(exposure).not.toHaveProperty('tools');
    expect(applicationService.getCollection).not.toHaveBeenCalled();
  });

  it('returns a frozen exposure and frozen optional Tool surface [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount, true);

    const exposure = requireExposureApi()(manifest, {
      mountId: mount.id,
      applicationService: readService(),
    });

    expect(Object.isFrozen(exposure)).toBe(true);
    expect(Object.isFrozen(exposure.tools)).toBe(true);
    expect(Object.isFrozen(exposure.tools?.listTools())).toBe(true);
  });

  it('keeps write, Plan, approval, key, and secret surfaces outside the read adapter [evidence:schema.mcp-read-resource-only]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    makeReadOnly(mount, true);
    const exposure = requireExposureApi()(manifest, {
      mountId: mount.id,
      applicationService: readService(),
    });
    const exposedSurface = [
      ...Object.keys(exposure),
      ...Object.keys(exposure.tools ?? {}),
      ...(exposure.tools?.listTools().map(({ name }) => name) ?? []),
    ].join(' ');

    expect(exposedSurface).not.toMatch(/create|update|delete|move|write|plan|commit|approv|key|secret/iu);
  });
});
