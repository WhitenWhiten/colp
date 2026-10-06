import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '../../src/types/index.js';
import {
  McpAnonymousResourceUnavailableError,
  createAnonymousMcpReadExposure,
} from '../../src/mcp/read-mount.js';
import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';

type PublicResourceIdentity =
  | Readonly<{ kind: 'collection-metadata'; collectionId: string }>
  | Readonly<{ kind: 'collection-snapshot'; collectionId: string }>
  | Readonly<{ kind: 'collection-node'; collectionId: string; nodeId: string }>;

interface PublicResourceAccessPort {
  readonly readPublicResource: (
    input: Readonly<{ resource: PublicResourceIdentity }>,
  ) => unknown | PromiseLike<unknown>;
}

interface AnonymousMcpReadExposure {
  readonly endpoint: string;
  readonly resources: true;
  readonly readResource: (uri: string) => Promise<unknown>;
}

interface AnonymousMcpReadApi {
  readonly createAnonymousMcpReadExposure?: (
    manifest: Manifest,
    options: Readonly<{
      mountId: string;
      publicAccess: PublicResourceAccessPort;
    }>,
  ) => AnonymousMcpReadExposure;
  readonly createMcpResourceUriCodec?: (manifest: Pick<Manifest, 'serverUuid'>) => {
    readonly collectionMetadata: (collectionId: string) => string;
    readonly collectionSnapshot: (collectionId: string) => string;
    readonly collectionNode: (collectionId: string, nodeId: string) => string;
  };
  readonly McpAnonymousResourceUnavailableError?: new () => Error & {
    readonly code: 'anonymous_resource_unavailable';
  };
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
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
  const mount = manifest.mounts[0]!;
  mount.profiles = ['core', 'mcp-read'];
  mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };
  return manifest;
}

function requireAnonymousApi(): typeof createAnonymousMcpReadExposure {
  expect(typeof createAnonymousMcpReadExposure, 'MCP-0009 needs an anonymous public-Resource exposure adapter').toBe('function');
  return createAnonymousMcpReadExposure;
}

function requireUriCodec(): typeof createMcpResourceUriCodec {
  expect(typeof createMcpResourceUriCodec).toBe('function');
  return createMcpResourceUriCodec;
}

function publicAccess(result: unknown = Object.freeze({ id: 'collection-1', title: 'Public' })) {
  return {
    readPublicResource: vi.fn(async (
      _input: Readonly<{ resource: PublicResourceIdentity }>,
    ) => result),
  };
}

function addReadMount(
  manifest: Manifest,
  id: string,
  endpoint: string,
): Manifest['mounts'][number] {
  const mount = structuredClone(manifest.mounts[0]!);
  mount.id = id;
  mount.endpoints.mcp = endpoint as NonNullable<typeof mount.endpoints.mcp>;
  mount.profiles = ['core', 'mcp-read'];
  mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: false };
  manifest.mounts.push(mount);
  return mount;
}

async function rejection(operation: () => unknown | PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
}

async function expectAnonymousResourceUnavailable(
  operation: () => unknown | PromiseLike<unknown>,
): Promise<unknown> {
  expect(typeof McpAnonymousResourceUnavailableError).toBe('function');
  const error = await rejection(operation);
  expect(error).toBeInstanceOf(McpAnonymousResourceUnavailableError);
  expect(error).toMatchObject({
    name: 'McpAnonymousResourceUnavailableError',
    code: 'anonymous_resource_unavailable',
    message: 'Anonymous MCP Resource is unavailable.',
  });
  return error;
}

describe('MCP-0009 anonymous public Resources [evidence:mcp.anonymous-public-resources]', () => {
  it('mounts the canonical anonymous Resource exposure and public package export [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    const access = publicAccess();

    const exposure = requireAnonymousApi()(manifest, { mountId: mount.id, publicAccess: access });

    expect(typeof createAnonymousMcpReadExposure).toBe('function');
    expect(exposure.endpoint).toBe(mount.endpoints.mcp);
    expect(exposure.resources).toBe(true);
    expect(Object.keys(exposure).sort()).toEqual(['endpoint', 'readResource', 'resources']);
  });

  it.each([
    ['collection metadata', 'metadata'],
    ['collection snapshot', 'snapshot'],
    ['collection node', 'node'],
  ] as const)(
    'delegates a canonical public %s URI to the application-service port [evidence:mcp.anonymous-public-resources]',
    async (_label, resourceKind) => {
      const manifest = await fixture();
      const mount = manifest.mounts[0]!;
      const codec = requireUriCodec()(manifest);
      const access = publicAccess();
      const exposure = requireAnonymousApi()(manifest, { mountId: mount.id, publicAccess: access });
      const uri = resourceKind === 'metadata'
        ? codec.collectionMetadata('collection-1')
        : resourceKind === 'snapshot'
          ? codec.collectionSnapshot('collection-1')
          : codec.collectionNode('collection-1', 'node-1');

      await expect(exposure.readResource(uri)).resolves.toEqual({
        id: 'collection-1',
        title: 'Public',
      });
      expect(access.readPublicResource).toHaveBeenCalledTimes(1);
      expect(access.readPublicResource).toHaveBeenCalledWith({
        resource: resourceKind === 'metadata'
          ? { kind: 'collection-metadata', collectionId: 'collection-1' }
          : resourceKind === 'snapshot'
            ? { kind: 'collection-snapshot', collectionId: 'collection-1' }
            : { kind: 'collection-node', collectionId: 'collection-1', nodeId: 'node-1' },
      });
    },
  );

  it('exposes zero Tools even when the canonical read Mount advertises Tools [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;
    mount.features.mcp = { protocolVersion: '2026-07-28', resources: true, tools: true };

    const exposure = requireAnonymousApi()(manifest, {
      mountId: mount.id,
      publicAccess: publicAccess(),
    });

    expect(exposure).not.toHaveProperty('tools');
    expect(Object.keys(exposure).join(' ')).not.toMatch(/tool/iu);
  });

  it.each([
    ['private', 'private-collection'],
    ['unknown', 'unknown-collection'],
  ] as const)(
    'fails closed when the public access port rejects a %s Resource [evidence:mcp.anonymous-public-resources]',
    async (_label, collectionId) => {
      const manifest = await fixture();
      const portError = Object.freeze({ code: 'public_resource_not_found' });
      const access = publicAccess();
      access.readPublicResource.mockRejectedValueOnce(portError);
      const exposure = requireAnonymousApi()(manifest, {
        mountId: manifest.mounts[0]!.id,
        publicAccess: access,
      });
      const uri = requireUriCodec()(manifest).collectionMetadata(collectionId);

      await expectAnonymousResourceUnavailable(() => exposure.readResource(uri));
      expect(access.readPublicResource).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['throws synchronously', (): never => { throw new Error('lookup failed'); }],
    ['rejects asynchronously', async (): Promise<never> => { throw new Error('lookup failed'); }],
    ['returns no public projection', async (): Promise<undefined> => undefined],
  ] as const)(
    'fails closed when the application-service port %s [evidence:mcp.anonymous-public-resources]',
    async (_label, readPublicResource) => {
      const manifest = await fixture();
      const exposure = requireAnonymousApi()(manifest, {
        mountId: manifest.mounts[0]!.id,
        publicAccess: { readPublicResource },
      });
      const uri = requireUriCodec()(manifest).collectionMetadata('collection-1');

      await expectAnonymousResourceUnavailable(() => exposure.readResource(uri));
    },
  );

  it.each([
    ['false', false],
    ['missing', undefined],
    ['a string lookalike', 'true'],
    ['a numeric lookalike', 1],
    ['an object lookalike', { enabled: true }],
  ] as const)(
    'rejects a selected Mount whose anonymousRead is %s [evidence:mcp.anonymous-public-resources]',
    async (_label, anonymousRead) => {
      const manifest = await fixture();
      const mount = manifest.mounts[0]!;
      if (anonymousRead === undefined) {
        delete (mount.auth as { anonymousRead?: unknown }).anonymousRead;
      } else {
        (mount.auth as { anonymousRead: unknown }).anonymousRead = anonymousRead;
      }

      expect(() => requireAnonymousApi()(manifest, {
        mountId: mount.id,
        publicAccess: publicAccess(),
      })).toThrow();
    },
  );

  it.each([
    ['an unknown Mount ID', 'missing'],
    ['an empty Mount ID', ''],
    ['a non-read profile', 'wrong-profile'],
    ['a missing MCP endpoint', 'missing-endpoint'],
    ['disabled Resources', 'disabled-resources'],
  ] as const)(
    'rejects %s without creating an anonymous exposure [evidence:mcp.anonymous-public-resources]',
    async (_label, scenario) => {
      const manifest = await fixture();
      const mount = manifest.mounts[0]!;
      let mountId: unknown = mount.id;
      if (scenario === 'missing') mountId = 'missing';
      if (scenario === '') mountId = '';
      if (scenario === 'wrong-profile') mount.profiles = ['core'];
      if (scenario === 'missing-endpoint') delete mount.endpoints.mcp;
      if (scenario === 'disabled-resources') mount.features.mcp!.resources = false;

      expect(() => requireAnonymousApi()(manifest, {
        mountId,
        publicAccess: publicAccess(),
      } as never)).toThrow();
    },
  );

  it('does not borrow anonymous authorization from another Mount [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    selected.auth.anonymousRead = false;
    const other = addReadMount(manifest, 'public-mount', 'https://public.example/mcp');
    other.auth.anonymousRead = true;

    expect(() => requireAnonymousApi()(manifest, {
      mountId: selected.id,
      publicAccess: publicAccess(),
    })).toThrow();
  });

  it('does not borrow MCP capability or endpoint from another Mount [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    selected.features.mcp!.resources = false;
    delete selected.endpoints.mcp;
    addReadMount(manifest, 'capable-mount', 'https://capable.example/mcp');

    expect(() => requireAnonymousApi()(manifest, {
      mountId: selected.id,
      publicAccess: publicAccess(),
    })).toThrow();
  });

  it('rejects duplicate Mount IDs as ambiguous without calling the public port [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const selected = manifest.mounts[0]!;
    addReadMount(manifest, selected.id, 'https://ambiguous.example/mcp');
    const access = publicAccess();

    expect(() => requireAnonymousApi()(manifest, {
      mountId: selected.id,
      publicAccess: access,
    })).toThrow();
    expect(access.readPublicResource).not.toHaveBeenCalled();
  });

  it('requires an owned public access port and never falls back to authenticated Tools [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const mount = manifest.mounts[0]!;

    expect(() => requireAnonymousApi()(manifest, { mountId: mount.id } as never)).toThrow();
  });

  it.each([
    ['an extra option', 'extra'],
    ['an inherited mountId', 'inherited'],
    ['a mountId getter', 'getter'],
  ] as const)(
    'rejects configuration with %s [evidence:mcp.anonymous-public-resources]',
    async (_label, scenario) => {
      const manifest = await fixture();
      const mount = manifest.mounts[0]!;
      const access = publicAccess();
      const getter = vi.fn(() => mount.id);
      let options: unknown;
      if (scenario === 'extra') {
        options = { mountId: mount.id, publicAccess: access, authorization: 'Bearer secret' };
      } else if (scenario === 'inherited') {
        options = Object.assign(Object.create({ mountId: mount.id }), { publicAccess: access });
      } else {
        options = { publicAccess: access };
        Object.defineProperty(options, 'mountId', { enumerable: true, get: getter });
      }

      expect(() => requireAnonymousApi()(manifest, options as never)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(access.readPublicResource).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['an inherited readPublicResource method', 'inherited'],
    ['a readPublicResource getter', 'getter'],
    ['an extra credential property', 'extra'],
  ] as const)(
    'rejects a public access port with %s [evidence:mcp.anonymous-public-resources]',
    async (_label, scenario) => {
      const manifest = await fixture();
      const read = vi.fn();
      const getter = vi.fn(() => read);
      let port: unknown;
      if (scenario === 'inherited') port = Object.create({ readPublicResource: read });
      else if (scenario === 'extra') port = { readPublicResource: read, apiKey: 'secret' };
      else {
        port = {};
        Object.defineProperty(port, 'readPublicResource', { enumerable: true, get: getter });
      }

      expect(() => requireAnonymousApi()(manifest, {
        mountId: manifest.mounts[0]!.id,
        publicAccess: port,
      } as never)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a forged authority', 'forged-authority'],
    ['userinfo authority ambiguity', 'userinfo'],
    ['an encoded path separator', 'encoded'],
    ['a query suffix', 'query'],
    ['a write-like path', 'write'],
  ] as const)(
    'rejects %s before invoking the public access port [evidence:mcp.anonymous-public-resources]',
    async (_label, scenario) => {
      const manifest = await fixture();
      const codec = requireUriCodec()(manifest);
      const canonical = codec.collectionMetadata('collection-1');
      const uri = scenario === 'forged-authority'
        ? canonical.replace(manifest.serverUuid, '019b3c67-a03c-7f02-9c7e-1ee8d50a77df')
        : scenario === 'userinfo'
          ? canonical.replace('colp://', 'colp://public@')
          : scenario === 'encoded'
            ? `${canonical}%2Fsnapshot`
            : scenario === 'query'
              ? `${canonical}?visibility=public`
              : `${canonical}/delete`;
      const access = publicAccess();
      const exposure = requireAnonymousApi()(manifest, {
        mountId: manifest.mounts[0]!.id,
        publicAccess: access,
      });

      await expectAnonymousResourceUnavailable(() => exposure.readResource(uri));
      expect(access.readPublicResource).not.toHaveBeenCalled();
    },
  );

  it('returns a frozen independent snapshot of own-data projections [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const projection = { id: 'collection-1', title: 'Public', nested: { values: ['stable'] } };
    const access = publicAccess(projection);
    const exposure = requireAnonymousApi()(manifest, {
      mountId: manifest.mounts[0]!.id,
      publicAccess: access,
    });
    const uri = requireUriCodec()(manifest).collectionMetadata('collection-1');

    const returned = await exposure.readResource(uri) as {
      readonly id: string;
      readonly title: string;
      readonly nested: Readonly<{ values: readonly string[] }>;
    };
    expect(returned).toEqual(projection);
    expect(returned).not.toBe(projection);
    expect(returned.nested).not.toBe(projection.nested);
    expect(returned.nested.values).not.toBe(projection.nested.values);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.nested)).toBe(true);
    expect(Object.isFrozen(returned.nested.values)).toBe(true);
    projection.title = 'mutated';
    projection.nested.values[0] = 'mutated';
    expect(returned).toEqual({
      id: 'collection-1',
      title: 'Public',
      nested: { values: ['stable'] },
    });
  });

  it('rejects accessor-backed projections without executing getters [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const visibilityGetter = vi.fn(() => 'public');
    const aclGetter = vi.fn(() => [{ principal: 'public', scopes: ['collections:read'] }]);
    const projection = { id: 'collection-1' } as Record<string, unknown>;
    Object.defineProperty(projection, 'visibility', { enumerable: true, get: visibilityGetter });
    Object.defineProperty(projection, 'acl', { enumerable: true, get: aclGetter });
    const access = publicAccess(projection);
    const exposure = requireAnonymousApi()(manifest, {
      mountId: manifest.mounts[0]!.id,
      publicAccess: access,
    });
    const uri = requireUriCodec()(manifest).collectionMetadata('collection-1');

    // Visibility/ACL remain application decisions; the adapter never peeks via getters and
    // fail-closes on non own-data projections instead of returning a live alias.
    await expectAnonymousResourceUnavailable(() => exposure.readResource(uri));
    expect(visibilityGetter).not.toHaveBeenCalled();
    expect(aclGetter).not.toHaveBeenCalled();
  });

  it('freezes the anonymous surface and its parsed port input [evidence:mcp.anonymous-public-resources]', async () => {
    const manifest = await fixture();
    const access = publicAccess();
    const exposure = requireAnonymousApi()(manifest, {
      mountId: manifest.mounts[0]!.id,
      publicAccess: access,
    });
    const uri = requireUriCodec()(manifest).collectionNode('collection-1', 'node-1');

    await exposure.readResource(uri);
    const input = access.readPublicResource.mock.calls[0]![0] as {
      readonly resource: PublicResourceIdentity;
    };
    expect(Object.isFrozen(exposure)).toBe(true);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.resource)).toBe(true);
  });

  it('redacts application-service exception secrets from errors and JSON [evidence:mcp.anonymous-public-resources]', async () => {
    const secret = 'Bearer mcp-private-token';
    const manifest = await fixture();
    const access = {
      readPublicResource: vi.fn(async () => {
        throw new Error(`database failed while using ${secret}`);
      }),
    };
    const exposure = requireAnonymousApi()(manifest, {
      mountId: manifest.mounts[0]!.id,
      publicAccess: access,
    });
    const uri = requireUriCodec()(manifest).collectionMetadata('collection-1');

    const error = await rejection(() => exposure.readResource(uri));
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('keeps secrets and all write, Plan, approval, key, and OAuth surfaces absent [evidence:mcp.anonymous-public-resources]', async () => {
    const secret = 'api-key-secret-value';
    const manifest = await fixture();
    const result = Object.freeze({ id: 'collection-1', title: 'Public projection' });
    const exposure = requireAnonymousApi()(manifest, {
      mountId: manifest.mounts[0]!.id,
      publicAccess: publicAccess(result),
    });
    const uri = requireUriCodec()(manifest).collectionMetadata('collection-1');
    const returned = await exposure.readResource(uri);
    const surface = Object.keys(exposure).join(' ');

    expect(JSON.stringify(returned)).not.toContain(secret);
    expect(JSON.stringify(exposure)).not.toContain(secret);
    expect(surface).not.toMatch(/write|create|update|delete|move|plan|commit|approv|key|oauth/iu);
  });
});
