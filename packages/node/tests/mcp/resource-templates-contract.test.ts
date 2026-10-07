import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createMcpResourceTemplates } from '../../src/mcp/resource-templates.js';
import { createMcpResourceUriCodec } from '../../src/mcp/resource-uri.js';

import { describe, expect, it, vi } from 'vitest';

import type { Manifest } from '../../src/types/index.js';

interface McpResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title: string;
  readonly mimeType: string;
}

type McpResourceTemplates = readonly McpResourceTemplate[];

interface McpResourceTemplateApi {
  readonly createMcpResourceTemplates?: (
    manifest: Pick<Manifest, 'serverUuid'>,
  ) => McpResourceTemplates;
  readonly createMcpResourceUriCodec?: (manifest: Pick<Manifest, 'serverUuid'>) => {
    readonly collectionMetadata: (collectionId: string) => string;
    readonly collectionNode: (collectionId: string, nodeId: string) => string;
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
const serverUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const otherServerUuid = '019b3c67-a03c-7f02-9c7e-1ee8d50a77df';

const expectedTemplates = [
  {
    uriTemplate: `colp://${serverUuid}/collections/{collectionId}`,
    name: 'collection',
    title: 'Collection metadata',
    mimeType: 'application/vnd.collection-protocol.collection+json',
  },
  {
    uriTemplate: `colp://${serverUuid}/collections/{collectionId}/nodes/{nodeId}`,
    name: 'collection-node',
    title: 'Collection node',
    mimeType: 'application/vnd.collection-protocol.node+json',
  },
] as const;

async function fixture(): Promise<Manifest> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
}

function requireUriCodec(): typeof createMcpResourceUriCodec {
  expect(typeof createMcpResourceUriCodec).toBe('function');
  return createMcpResourceUriCodec;
}

function createTemplates(actualServerUuid = serverUuid): McpResourceTemplates {
  return createMcpResourceTemplates({ serverUuid: actualServerUuid });
}

function variables(template: string): readonly string[] {
  return [...template.matchAll(/\{([^{}]+)\}/gu)].map((match) => match[1]!);
}

function expand(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([^{}]+)\}/gu, (_expression, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing template variable ${name}.`);
    return value;
  });
}

describe('MCP-0010 Resource Templates [evidence:mcp.resource-templates]', () => {
  it('returns exactly two implemented descriptors in the specified order [evidence:mcp.resource-templates]', () => {
    expect(createTemplates()).toEqual(expectedTemplates);
  });

  it('keeps every descriptor to the exact protocol field surface [evidence:mcp.resource-templates]', () => {
    const templates = createTemplates();

    expect(templates).toHaveLength(2);
    for (const template of templates) {
      expect(Object.keys(template)).toEqual(['uriTemplate', 'name', 'title', 'mimeType']);
    }
  });

  it('fixes the actual serverUuid in every authority and exposes no authority variable [evidence:mcp.resource-templates]', () => {
    const templates = createTemplates();

    for (const template of templates) {
      expect(template.uriTemplate).toMatch(new RegExp(`^colp://${serverUuid}/collections/`, 'u'));
      expect(template.uriTemplate).not.toContain('{serverUuid}');
    }
  });

  it('declares only the exact variable set for each ordered template [evidence:mcp.resource-templates]', () => {
    expect(createTemplates().map(({ uriTemplate }) => variables(uriTemplate))).toEqual([
      ['collectionId'],
      ['collectionId', 'nodeId'],
    ]);
  });

  it('does not advertise a feed URI, query, or cursor [evidence:mcp.resource-templates]', () => {
    const exposed = JSON.stringify(createTemplates());

    expect(createTemplates().some((template) => template.name === 'collection-feed')).toBe(false);
    expect(exposed).not.toMatch(/feed|cursor|changes/iu);
  });

  it('accepts the complete protocol Manifest fixture [evidence:mcp.resource-templates]', async () => {
    const manifest = await fixture();

    expect(createMcpResourceTemplates(manifest)).toEqual(expectedTemplates);
  });

  it('binds different server identities to stable isolated template sets [evidence:mcp.resource-templates]', () => {
    const first = createTemplates(serverUuid);
    const second = createTemplates(otherServerUuid);

    expect(first).toEqual(createTemplates(serverUuid));
    expect(second).toEqual(createTemplates(otherServerUuid));
    expect(JSON.stringify(first)).not.toContain(otherServerUuid);
    expect(JSON.stringify(second)).not.toContain(serverUuid);
    expect(second.map(({ uriTemplate }) => uriTemplate)).toEqual(
      expectedTemplates.map(({ uriTemplate }) => uriTemplate.replace(serverUuid, otherServerUuid)),
    );
  });

  it('is deterministic across repeated calls [evidence:mcp.resource-templates]', () => {
    expect(createTemplates()).toEqual(createTemplates());
  });

  it('returns deeply frozen fresh values or an equivalently safe shared value [evidence:mcp.resource-templates]', () => {
    const first = createTemplates();
    const second = createTemplates();

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
    first.forEach((template, index) => {
      expect(Object.isFrozen(template)).toBe(true);
      expect(Object.isFrozen(second[index])).toBe(true);
      if (template === second[index]) expect(Object.isFrozen(template)).toBe(true);
      else expect(template).not.toBe(second[index]);
    });
  });

  it('does not mutate the supplied Manifest identity [evidence:mcp.resource-templates]', () => {
    const manifest = Object.freeze({ serverUuid });

    createMcpResourceTemplates(manifest);

    expect(manifest).toEqual({ serverUuid });
  });

  it('does not copy secrets or unrelated Manifest fields into output [evidence:mcp.resource-templates]', () => {
    const secret = 'mcp-api-key-secret';
    const manifest = { serverUuid, title: 'Private title', apiKey: secret, opaqueExtra: { secret } };
    const output = createMcpResourceTemplates(manifest);
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('Private title');
    expect(serialized).not.toContain('opaqueExtra');
  });

  it('does not inspect unrelated Manifest accessors [evidence:mcp.resource-templates]', () => {
    const extraGetter = vi.fn(() => ({ apiKey: 'secret' }));
    const manifest = { serverUuid } as Pick<Manifest, 'serverUuid'> & { readonly extensions?: unknown };
    Object.defineProperty(manifest, 'extensions', { enumerable: true, get: extraGetter });

    expect(createMcpResourceTemplates(manifest)).toEqual(expectedTemplates);
    expect(extraGetter).not.toHaveBeenCalled();
  });

  it('advertises no write, admin, sync, approval, key, or OAuth template [evidence:mcp.resource-templates]', () => {
    const exposed = JSON.stringify(createTemplates());

    expect(exposed).not.toMatch(/write|create|update|delete|move|admin|sync|approv|key|oauth|secret/iu);
  });

  it('expands collection metadata to the existing codec URI [evidence:mcp.resource-templates]', () => {
    const templates = createTemplates();
    const codec = requireUriCodec()({ serverUuid });

    expect(expand(templates[0]!.uriTemplate, { collectionId: 'collection-1' })).toBe(
      codec.collectionMetadata('collection-1'),
    );
  });

  it('expands a collection node to the existing codec URI [evidence:mcp.resource-templates]', () => {
    const templates = createTemplates();
    const codec = requireUriCodec()({ serverUuid });

    expect(
      expand(templates[1]!.uriTemplate, { collectionId: 'collection-1', nodeId: 'node-1' }),
    ).toBe(codec.collectionNode('collection-1', 'node-1'));
  });

  it('does not call a supplied feed business accessor while declaring implemented URIs [evidence:mcp.resource-templates]', () => {
    const feedGetter = vi.fn(() => vi.fn());
    const manifest = { serverUuid } as Pick<Manifest, 'serverUuid'> & { readonly feed?: unknown };
    Object.defineProperty(manifest, 'feed', { enumerable: true, get: feedGetter });

    expect(createMcpResourceTemplates(manifest)).toEqual(expectedTemplates);
    expect(feedGetter).not.toHaveBeenCalled();
  });

  it('rejects a client-fillable or forged serverUuid authority [evidence:mcp.resource-templates]', () => {
    expect(() => createTemplates('{serverUuid}')).toThrow();
  });

  it.each(['', '.', '..', 'server/forged', 'server?query', 'x'.repeat(129)])(
    'rejects invalid serverUuid %j [evidence:mcp.resource-templates]',
    (invalidServerUuid) => {
      expect(() => createTemplates(invalidServerUuid)).toThrow();
    },
  );

  it.each([
    ['missing Manifest', undefined],
    ['null Manifest', null],
    ['primitive Manifest', serverUuid],
    ['missing serverUuid', {}],
    ['null serverUuid', { serverUuid: null }],
  ] as const)(
    'fails closed for %s [evidence:mcp.resource-templates]',
    (_label, manifest) => {
      expect(() => createMcpResourceTemplates(
        manifest as unknown as Pick<Manifest, 'serverUuid'>,
      )).toThrow();
    },
  );

  it('rejects an inherited serverUuid [evidence:mcp.resource-templates]', () => {
    const inherited = Object.create({ serverUuid }) as Pick<Manifest, 'serverUuid'>;

    expect(() => createMcpResourceTemplates(inherited)).toThrow();
  });

  it('rejects a serverUuid getter without invoking it [evidence:mcp.resource-templates]', () => {
    const getter = vi.fn(() => serverUuid);
    const manifest = {} as Pick<Manifest, 'serverUuid'>;
    Object.defineProperty(manifest, 'serverUuid', { enumerable: true, get: getter });

    expect(() => createMcpResourceTemplates(manifest)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects missing and extra factory arguments [evidence:mcp.resource-templates]', () => {
    const factory = createMcpResourceTemplates as (...args: unknown[]) => McpResourceTemplates;

    expect(() => factory()).toThrow();
    expect(() => factory({ serverUuid }, { serverUuid: otherServerUuid })).toThrow();
    expect(() => factory({ serverUuid }, { validate: () => true })).toThrow();
  });
});
