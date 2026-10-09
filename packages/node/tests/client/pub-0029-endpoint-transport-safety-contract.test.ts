import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  expandPublicationEndpointTemplate,
  type PublicationEndpointKey,
} from '../../src/semantic/index.js';
import { createProtocolJsonResponse } from '../helpers/http-responses.js';

const evidence = 'http.endpoint-transport-safety';
const manifestUrl = 'https://manifest.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();

type JsonObject = Record<string, any>;

async function fixtureObject(name: string): Promise<JsonObject> {
  return JSON.parse(await readFile(resolve(fixturesRoot, name), 'utf8')) as JsonObject;
}

async function publicationManifest(): Promise<JsonObject> {
  const manifest = await fixtureObject('public-manifest.json');
  manifest.mounts[0].id = 'pub-0029';
  return manifest;
}

function variablesFor(endpoint: PublicationEndpointKey): Readonly<Record<string, string>> {
  return endpoint === 'directory' ? {} : { collectionId };
}

function requestHref(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

const protocolResponse = createProtocolJsonResponse('"pub-0029"');

const acceptedTemplates = [
  {
    name: 'HTTPS literal with an explicit port',
    endpoint: 'directory' as const,
    template: 'https://static.example.test:8443/catalog.json?fixed=a%2Fb',
    expected: 'https://static.example.test:8443/catalog.json?fixed=a%2Fb',
  },
  {
    name: 'HTTPS collection template',
    endpoint: 'collection' as const,
    template: 'https://objects.example.test:9443/by-id/{collectionId}.json',
    expected: `https://objects.example.test:9443/by-id/${collectionId}.json`,
  },
  {
    name: 'HTTPS snapshot template',
    endpoint: 'snapshot' as const,
    template: 'https://archive.example.test/export/{collectionId}/snapshot.json?mode=full',
    expected: `https://archive.example.test/export/${collectionId}/snapshot.json?mode=full`,
  },
  {
    name: 'localhost HTTP literal with a port',
    endpoint: 'directory' as const,
    template: 'http://localhost:4173/catalog.json',
    expected: 'http://localhost:4173/catalog.json',
  },
  {
    name: 'localhost HTTP template with a port',
    endpoint: 'collection' as const,
    template: 'http://localhost:4173/c/{collectionId}.json',
    expected: `http://localhost:4173/c/${collectionId}.json`,
  },
  {
    name: '127.0.0.1 HTTP literal with a port',
    endpoint: 'directory' as const,
    template: 'http://127.0.0.1:8787/catalog.json',
    expected: 'http://127.0.0.1:8787/catalog.json',
  },
  {
    name: '127.0.0.1 HTTP template with a port',
    endpoint: 'snapshot' as const,
    template: 'http://127.0.0.1:8787/c/{collectionId}/snapshot.json',
    expected: `http://127.0.0.1:8787/c/${collectionId}/snapshot.json`,
  },
  {
    name: '[::1] HTTP literal with a port',
    endpoint: 'directory' as const,
    template: 'http://[::1]:9090/catalog.json',
    expected: 'http://[::1]:9090/catalog.json',
  },
  {
    name: '[::1] HTTP template with a port',
    endpoint: 'collection' as const,
    template: 'http://[::1]:9090/c/{collectionId}.json',
    expected: `http://[::1]:9090/c/${collectionId}.json`,
  },
] as const;

const rejectedTemplates = [
  ['non-loopback HTTP', 'http://api.example.test/catalog.json'],
  ['localhost suffix', 'http://localhost.example:4173/catalog.json'],
  ['localhost prefix', 'http://evil-localhost:4173/catalog.json'],
  ['localhost trailing dot', 'http://localhost.:4173/catalog.json'],
  ['single-integer IPv4', 'http://2130706433:4173/catalog.json'],
  ['octal IPv4', 'http://0177.0.0.1:4173/catalog.json'],
  ['hexadecimal IPv4', 'http://0x7f000001:4173/catalog.json'],
  ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]:4173/catalog.json'],
  ['IPv4 link-local', 'http://169.254.1.2:4173/catalog.json'],
  ['IPv6 link-local', 'http://[fe80::1]:4173/catalog.json'],
  ['HTTP localhost user information', 'http://user:private@localhost:4173/catalog.json'],
  ['HTTPS user information', 'https://user:private@api.example.test/catalog.json'],
  ['relative reference', '/catalog/directory.json'],
  ['file URL', 'file:///private/catalog.json'],
  ['WebSocket URL', 'ws://localhost:4173/catalog.json'],
  ['secure WebSocket URL', 'wss://api.example.test/catalog.json'],
  ['oversized endpoint template', `https://api.example.test/${'x'.repeat(65_536)}`],
  ['variable host', 'https://{collectionId}.example.test/catalog.json'],
  ['Level 2 reserved expansion', 'https://api.example.test/{+collectionId}.json'],
  ['Level 2 fragment expansion', 'https://api.example.test/{#collectionId}'],
  ['Level 3 label expansion', 'https://api.example.test/{.collectionId}'],
  ['Level 3 path expansion', 'https://api.example.test{/collectionId}'],
  ['Level 3 path-parameter expansion', 'https://api.example.test{;collectionId}'],
  ['Level 3 query expansion', 'https://api.example.test{?collectionId}'],
  ['Level 3 query continuation', 'https://api.example.test{&collectionId}'],
  ['prefix modifier', 'https://api.example.test/{collectionId:3}.json'],
  ['explode modifier', 'https://api.example.test/{collectionId*}.json'],
  ['literal fragment', 'https://api.example.test/catalog.json#private'],
  ['literal fragment after a template', 'https://api.example.test/{collectionId}.json#private'],
  ['empty variable expression', 'https://api.example.test/{}.json'],
  ['invalid variable character', 'https://api.example.test/{collection-id}.json'],
  ['invalid percent-encoded variable', 'https://api.example.test/{collection%ZZId}.json'],
  ['missing closing brace', 'https://api.example.test/{collectionId.json'],
  ['nested expression braces', 'https://api.example.test/{{collectionId}}.json'],
  ['duplicate variables in one expression', 'https://api.example.test/{collectionId,collectionId}.json'],
  ['duplicate variables across expressions', 'https://api.example.test/{collectionId}/{collectionId}.json'],
] as const;

describe(`PUB-0029 declared Endpoint transport safety [evidence:${evidence}]`, () => {
  it.each(acceptedTemplates)(
    'accepts and expands $name exactly [evidence:http.endpoint-transport-safety]',
    ({ endpoint, template, expected }) => {
      expect(
        expandPublicationEndpointTemplate(endpoint, template, variablesFor(endpoint), validators).href,
      ).toBe(expected);
    },
  );

  it.each(rejectedTemplates)(
    'rejects %s at the declared template boundary [evidence:http.endpoint-transport-safety]',
    (_name, template) => {
      expect(() => expandPublicationEndpointTemplate(
        template.includes('collectionId') ? 'collection' : 'directory',
        template,
        template.includes('collectionId') ? { collectionId } : {},
        validators,
      )).toThrow(TypeError);
    },
  );

  it.each([
    ['localhost', 'http://localhost:4173/display/', 'http://localhost:4173/catalog.json'],
    ['127.0.0.1', 'http://127.0.0.1:8787/display/', 'http://127.0.0.1:8787/catalog.json'],
    ['[::1]', 'http://[::1]:9090/display/', 'http://[::1]:9090/catalog.json'],
  ])(
    'issues the exact declared %s loopback HTTP request [evidence:http.endpoint-transport-safety]',
    async (_name, baseUrl, endpoint) => {
      // Local development is authorized by the caller-selected Manifest origin.
      const localManifestUrl = new URL('/.well-known/collection-protocol', baseUrl).href;
      const manifest = await publicationManifest();
      manifest.mounts[0].baseUrl = baseUrl;
      manifest.mounts[0].endpoints.directory = endpoint;
      const directory = await fixtureObject('collection-directory.json');
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = requestHref(input);
        requested.push(url);
        if (url === localManifestUrl) return Response.json(manifest);
        if (url === endpoint) return protocolResponse(directory);
        throw new Error(`Unexpected request: ${url}`);
      });

      await new ColpClient({ manifestUrl: localManifestUrl, fetch: fetch as typeof globalThis.fetch }).getDirectory();

      expect(requested).toEqual([localManifestUrl, endpoint]);
    },
  );

  it.each([
    ['non-loopback HTTP', 'http://api.example.test/private/catalog.json'],
    ['localhost suffix confusion', 'http://localhost.example:4173/private/catalog.json'],
    ['alternate numeric IPv4', 'http://2130706433:4173/private/catalog.json'],
    ['relative reference', '/private/catalog.json'],
    ['Level 2 operator', 'https://api.example.test/{+collectionId}.json'],
    ['discarded fragment', 'https://api.example.test/catalog.json#private'],
  ])(
    'blocks %s before endpoint I/O [evidence:http.endpoint-transport-safety]',
    async (_name, endpoint) => {
      const manifest = await publicationManifest();
      manifest.mounts[0].baseUrl = 'http://localhost:4173/display/';
      manifest.mounts[0].endpoints.directory = endpoint;
      const requested: string[] = [];
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = requestHref(input);
        requested.push(url);
        if (url === manifestUrl) return Response.json(manifest);
        throw new Error(`Unsafe endpoint reached fetch: ${url}`);
      });

      await expect(
        new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }).getDirectory(),
      ).rejects.toThrow();

      expect(requested).toEqual([manifestUrl]);
    },
  );

  it('preserves an explicit cross-origin HTTPS Endpoint through the actual request [evidence:http.endpoint-transport-safety]', async () => {
    const manifest = await publicationManifest();
    const endpoint = 'https://cdn.example.test:8443/opaque/%2Fcatalog.json?tag=a%2Fb';
    manifest.mounts[0].baseUrl = 'https://display.example.test/deep/path/';
    manifest.mounts[0].endpoints.directory = endpoint;
    const directory = await fixtureObject('collection-directory.json');
    const requested: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = requestHref(input);
      requested.push(url);
      if (url === manifestUrl) return Response.json(manifest);
      if (url === endpoint) return protocolResponse(directory);
      throw new Error(`Declared Endpoint was rewritten: ${url}`);
    });

    await new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }).getDirectory();

    expect(requested).toEqual([manifestUrl, endpoint]);
  });

  it('caps Manifest response bytes before cloning or semantic validation [evidence:http.endpoint-transport-safety]', async () => {
    const manifest = await publicationManifest();
    manifest.title = 'x'.repeat(70_000);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(requestHref(input)).toBe(manifestUrl);
      return Response.json(manifest);
    });

    await expect(
      new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch }).discover(),
    ).rejects.toThrow(/response byte limit/iu);
  });

  it.each([
    ['userinfo secret', 'https://user:super-secret@api.example.test/catalog.json', 'super-secret'],
    ['HTTP target secret', 'http://attacker.example/private/catalog.json?token=super-secret', 'super-secret'],
  ])(
    'keeps %s out of validation errors [evidence:http.endpoint-transport-safety]',
    (_name, template, secret) => {
      let thrown: unknown;
      try {
        expandPublicationEndpointTemplate('directory', template, {}, validators);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TypeError);
      expect(String(thrown)).not.toContain(template);
      expect(String(thrown)).not.toContain(secret);
      expect(String(thrown)).not.toContain('private');
    },
  );

});
