import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import { createValidatorRegistry, type DefinitionName } from '../../src/schema/index.js';
import {
  composePublicationHttpReadFromRequest,
  createPublicationHttpReadRepresentation,
  MAX_ACCEPT_LENGTH,
  MAX_ACCEPT_RANGES,
  negotiatePublicationVersion,
  PUBLICATION_HTTP_READ_MEDIA_TYPES,
  PUBLICATION_MANIFEST_MEDIA_TYPE,
  type PublicationHttpReadEndpoint,
  type PublicationHttpReadRequestInput,
} from '../../src/server/index.js';
import type { CollectionMetadata, Manifest, NodeDetail, Snapshot } from '../../src/types/index.js';

const examples = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const example = <Value>(name: string): Value => JSON.parse(readFileSync(resolve(examples, name), 'utf8')) as Value;
const lastModified = new Date('2026-07-16T06:30:00Z');

const manifest = example<Manifest>('public-manifest.json');
const directory = example<Record<string, unknown>>('collection-directory.json');
const metadata = example<CollectionMetadata>('collection-metadata.json');
const snapshot = example<Snapshot>('collection-snapshot.json');
const nodeDetail = example<NodeDetail>('node-detail.json');

describe('PUBLICATION_HTTP_READ_MEDIA_TYPES', () => {
  it('names the registered vendor media type of every read endpoint', () => {
    expect(PUBLICATION_HTTP_READ_MEDIA_TYPES).toEqual({
      manifest: 'application/vnd.collection-protocol.manifest+json;version=0.1',
      directory: 'application/vnd.collection-protocol.catalog+json;version=0.1',
      metadata: 'application/vnd.collection-protocol.collection+json;version=0.1',
      snapshot: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
      node: 'application/vnd.collection-protocol.node+json;version=0.1',
    });
    expect(PUBLICATION_HTTP_READ_MEDIA_TYPES.manifest).toBe(PUBLICATION_MANIFEST_MEDIA_TYPE);
    expect(Object.isFrozen(PUBLICATION_HTTP_READ_MEDIA_TYPES)).toBe(true);
  });
});

describe('createPublicationHttpReadRepresentation', () => {
  it('derives the revision and identities of a Snapshot page', () => {
    expect(createPublicationHttpReadRepresentation('snapshot', snapshot, { lastModified })).toEqual({
      value: snapshot,
      revision: snapshot.revision,
      projectionKey: 'public',
      protocolVersion: '0.1',
      lastModified,
      negotiatedMediaType: PUBLICATION_HTTP_READ_MEDIA_TYPES.snapshot,
      snapshotIdentity: { snapshotId: snapshot.snapshotId, sequence: 1 },
      pageIdentity: { pageNumber: 1 },
    });
    expect(createPublicationHttpReadRepresentation('snapshot', snapshot, {
      lastModified,
      pageIdentity: { pageCursor: 'page-2', pageNumber: 2 },
    }).pageIdentity).toEqual({ pageCursor: 'page-2', pageNumber: 2 });
  });

  it('adds the Collection Metadata Link headers to any caller headers', () => {
    const representation = createPublicationHttpReadRepresentation('metadata', metadata, {
      lastModified,
      headers: { 'x-host': 'kept' },
    });
    expect(representation.revision).toBe(metadata.collection.revision);
    const headers = new Headers(representation.headers);
    expect(headers.get('x-host')).toBe('kept');
    expect(headers.get('link')).toContain(`<${metadata.links.snapshot}>`);
  });

  it('derives the revision of a Node', () => {
    expect(createPublicationHttpReadRepresentation('node', nodeDetail, { lastModified }).revision)
      .toBe(nodeDetail.node.revision);
  });

  it.each(['manifest', 'directory'] as const)('requires an explicit revision for %s', (endpoint) => {
    expect(() => createPublicationHttpReadRepresentation(endpoint, {}, { lastModified }))
      .toThrow('Publication ' + endpoint + ' representations need options.revision.');
    expect(createPublicationHttpReadRepresentation(endpoint, {}, {
      lastModified,
      revision: 'r1',
      projectionKey: 'members',
      protocolVersion: '0.1',
      negotiatedMediaType: 'application/json',
      cacheControl: 'public, max-age=60',
      vary: ['Accept-Language'],
    })).toEqual({
      value: {},
      revision: 'r1',
      projectionKey: 'members',
      protocolVersion: '0.1',
      lastModified,
      negotiatedMediaType: 'application/json',
      cacheControl: 'public, max-age=60',
      vary: ['Accept-Language'],
    });
  });

  it('carries the principal scope of an authorized read', () => {
    expect(createPublicationHttpReadRepresentation('directory', directory, {
      lastModified,
      revision: 'r1',
      principalScope: 'principal:alice',
    }).principalScope).toBe('principal:alice');
  });

  it('rejects input it cannot read safely', () => {
    expect(() => createPublicationHttpReadRepresentation('feed' as PublicationHttpReadEndpoint, snapshot, { lastModified }))
      .toThrow('Publication HTTP read endpoint is invalid.');
    expect(() => createPublicationHttpReadRepresentation('snapshot', snapshot, {} as { lastModified: Date }))
      .toThrow('lastModified Date');
    expect(() => createPublicationHttpReadRepresentation('snapshot', snapshot, new Proxy({ lastModified }, {})))
      .toThrow('must be an object');
    expect(() => createPublicationHttpReadRepresentation('snapshot', snapshot, null as unknown as { lastModified: Date }))
      .toThrow('must be an object');
    expect(() => createPublicationHttpReadRepresentation('snapshot', snapshot, {
      lastModified,
      cacheControll: 'no-store',
    } as { lastModified: Date })).toThrow('Unknown Publication HTTP read representation option: cacheControll.');
    const accessor = Object.defineProperty({}, 'lastModified', { enumerable: true, get: () => lastModified });
    expect(() => createPublicationHttpReadRepresentation('snapshot', snapshot, accessor as { lastModified: Date }))
      .toThrow('enumerable data properties');
    expect(() => createPublicationHttpReadRepresentation('snapshot', { ...snapshot, page: undefined }, {
      lastModified,
    })).toThrow('need a snapshotId and page.sequence');
    expect(() => createPublicationHttpReadRepresentation('snapshot', new Proxy(snapshot, {}), { lastModified }))
      .toThrow('representations need options.revision');
    expect(() => createPublicationHttpReadRepresentation('metadata', null, { lastModified }))
      .toThrow('representations need options.revision');
  });
});

describe('composePublicationHttpReadFromRequest', () => {
  const read = (overrides: Partial<PublicationHttpReadRequestInput> = {}): PublicationHttpReadRequestInput => ({
    endpoint: 'snapshot',
    access: 'anonymous-public',
    resolveRepresentation: () => createPublicationHttpReadRepresentation('snapshot', snapshot, {
      lastModified,
      cacheControl: 'public, max-age=60',
    }),
    ...overrides,
  } as PublicationHttpReadRequestInput);
  const url = 'https://alice.example/collections/c/collection-1/snapshot';

  it('serves GET with the vendor media type, an ETag, and the body', async () => {
    const response = await composePublicationHttpReadFromRequest(new Request(url), read());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(PUBLICATION_HTTP_READ_MEDIA_TYPES.snapshot);
    expect(response.headers.get('etag')).toMatch(/^"/u);
    expect(await response.json()).toMatchObject({ snapshotId: snapshot.snapshotId });
  });

  it('answers HEAD without a body and a matching If-None-Match with 304', async () => {
    const first = await composePublicationHttpReadFromRequest(new Request(url), read());
    const head = await composePublicationHttpReadFromRequest(new Request(url, { method: 'HEAD' }), read());
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const conditional = await composePublicationHttpReadFromRequest(
      new Request(url, { headers: { 'If-None-Match': first.headers.get('etag')! } }),
      read(),
    );
    expect(conditional.status).toBe(304);
  });

  it('decodes the query string from the request URL, including a path-only URL', async () => {
    const resolveRepresentation = vi.fn(() => createPublicationHttpReadRepresentation('directory', directory, {
      lastModified,
      revision: 'directory-r1',
    }));
    const input = read({ endpoint: 'directory', resolveRepresentation });
    const ok = await composePublicationHttpReadFromRequest(
      { method: 'GET', url: '/collections?limit=10', headers: new Headers() },
      input,
    );
    expect(ok.status).toBe(200);
    expect(resolveRepresentation).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    const invalid = await composePublicationHttpReadFromRequest(new Request(`${url}?limit=many`), input);
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('content-type')).toBe('application/problem+json');
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('answers %s with a 405 Problem', async (method) => {
    const resolveRepresentation = vi.fn();
    const response = await composePublicationHttpReadFromRequest(
      new Request(url, { method }),
      read({ resolveRepresentation }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toMatchObject({ code: 'method_not_allowed', status: 405 });
    expect(resolveRepresentation).not.toHaveBeenCalled();
  });

  it('uses caller validators and runs authorized reads through the authorizer', async () => {
    const canonical = createValidatorRegistry();
    const validate = vi.fn((name: DefinitionName, value: unknown) => canonical.validate(name, value));
    const response = await composePublicationHttpReadFromRequest(new Request(url), {
      endpoint: 'snapshot',
      access: 'authorized-private',
      validators: { definitionNames: canonical.definitionNames, get: canonical.get, validate },
      authorize: () => ({ allowed: true, context: 'alice' }),
      resolveRepresentation: (_query, principal) => createPublicationHttpReadRepresentation('snapshot', snapshot, {
        lastModified,
        principalScope: `principal:${principal}`,
      }),
    });
    expect(response.status).toBe(200);
    expect(validate).toHaveBeenCalledWith('snapshot', expect.anything());
  });

  describe('SPECIFICATION §12 version negotiation (PUB-0041) [evidence:http.version-negotiation]', () => {
    const vendor = 'application/vnd.collection-protocol.snapshot+json';
    const expect406 = async (response: Response, supportedVersions = ['0.1']) => {
      expect(response.status).toBe(406);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'unsupported_version', status: 406, supportedVersions });
    };

    it('answers an unsupported Collection-Protocol-Version header with 406 before the resolver runs', async () => {
      const resolveRepresentation = vi.fn();
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { 'Collection-Protocol-Version': '9.9' } }),
        read({ resolveRepresentation }),
      );
      await expect406(response);
      expect(resolveRepresentation).not.toHaveBeenCalled();
    });

    it('answers HEAD with the 406 status and no body', async () => {
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { method: 'HEAD', headers: { 'Collection-Protocol-Version': '9.9' } }),
        read(),
      );
      expect(response.status).toBe(406);
      expect(response.body).toBeNull();
    });

    it.each(['0.1', ' 0.1 ', ''])('admits header %j', async (value) => {
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { 'Collection-Protocol-Version': value } }),
        read(),
      );
      expect(response.status).toBe(200);
    });

    it.each(['0.1, 9.9', '0.10', '0.1;q=1', 'v0.1', '0'])('compares the header exactly, so %j is unsupported', async (value) => {
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { 'Collection-Protocol-Version': value } }),
        read(),
      );
      await expect406(response);
    });

    it.each([
      `${vendor};version=9.9`,
      `${vendor};version="9.9"`,
      `${vendor}; version=9.9; q=0.8`,
      `${vendor};version=9.9, text/html`,
      `application/json;version=9.9`,
      `${vendor};version=0.1;q=0, ${vendor};version=9.9`,
    ])('answers Accept %j with 406 when only unsupported versions are acceptable', async (accept) => {
      const resolveRepresentation = vi.fn();
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { Accept: accept } }),
        read({ resolveRepresentation }),
      );
      await expect406(response);
      expect(resolveRepresentation).not.toHaveBeenCalled();
    });

    it.each([
      `${vendor};version=0.1`,
      `${vendor};version="0.1"`,
      `${vendor}`,
      `${vendor};version=9.9, ${vendor};version=0.1;q=0.5`,
      `${vendor};version=9.9, */*;q=0.1`,
      `${vendor};version=9.9, application/*`,
      `${vendor};version=9.9;q=0, ${vendor}`,
      `${vendor};version=9.9;q=0`,
      'text/html',
      'text/html;version=9.9',
      '*/*',
      'application/json',
      'not a media range ;; version=9.9',
      'text/html;q=abc',
      `${vendor};q=abc, application/json`,
      `${vendor};version=9.9;version=0.1, */*`,
    ])('admits Accept %j', async (accept) => {
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { Accept: accept } }),
        read(),
      );
      expect(response.status).toBe(200);
    });

    it.each([
      `${vendor};version=9.9;version=0.1`,
      `${vendor};version="unbalanced`,
      `${vendor};q=abc`,
      `${vendor};q="1"`,
      'application/json;version="9.9',
      'text/html;version="unbalanced, application/json',
      `${vendor};version=9.9, text/html;version=0.1`,
    ])('fails closed on malformed Collection Protocol range %j', async (accept) => {
      const resolveRepresentation = vi.fn();
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { Accept: accept } }),
        read({ resolveRepresentation }),
      );
      await expect406(response);
      expect(resolveRepresentation).not.toHaveBeenCalled();
    });

    describe('bounded Accept examination fails closed past its budgets', () => {
      // Long unrelated ranges keep the length-budget cases under the range budget.
      const filler = `text/html;q=0.9;x=${'a'.repeat(200)}`;
      const padTo = (length: number, tail: string, head = '') => {
        const parts = head === '' ? [] : [head];
        const joined = () => [...parts, tail].join(', ');
        while (joined().length < length) parts.push(filler);
        while (joined().length > length && parts.length > (head === '' ? 0 : 1)) parts.pop();
        return joined();
      };
      const negotiate = (accept: string) => negotiatePublicationVersion({ accept }).supported;

      it('reads an unsupported version that sits exactly within the length budget', () => {
        const accept = padTo(MAX_ACCEPT_LENGTH, `${vendor};version=9.9`);
        expect(accept.length).toBeLessThanOrEqual(MAX_ACCEPT_LENGTH);
        expect(accept.split(',').length).toBeLessThanOrEqual(MAX_ACCEPT_RANGES);
        expect(negotiate(accept)).toBe(false);
        expect(negotiate(padTo(MAX_ACCEPT_LENGTH, `${vendor};version=0.1`))).toBe(true);
      });

      it('does not admit an unsupported version hidden past the length budget', async () => {
        const accept = padTo(MAX_ACCEPT_LENGTH + 64, `${vendor};version=9.9`);
        expect(accept.length).toBeGreaterThan(MAX_ACCEPT_LENGTH);
        expect(accept.split(',').length).toBeLessThanOrEqual(MAX_ACCEPT_RANGES);
        expect(negotiate(accept)).toBe(false);
        const response = await composePublicationHttpReadFromRequest(
          new Request(url, { headers: { Accept: accept } }),
          read(),
        );
        await expect406(response);
      });

      it('still admits an over-length header once an acceptable range was seen inside the budget', () => {
        expect(negotiate(padTo(MAX_ACCEPT_LENGTH + 64, `${vendor};version=9.9`, '*/*;q=0.1'))).toBe(true);
        expect(negotiate(padTo(MAX_ACCEPT_LENGTH + 64, `${vendor};version=9.9`, `${vendor};version=0.1`))).toBe(true);
      });

      it('does not admit an unsupported version hidden past the range budget', () => {
        const unrelated = Array.from({ length: MAX_ACCEPT_RANGES }, () => 'text/html;q=0.9');
        expect(negotiate(unrelated.join(','))).toBe(true);
        expect(negotiate([...unrelated.slice(1), `${vendor};version=0.1`].join(','))).toBe(true);
        expect(negotiate([...unrelated.slice(1), `${vendor};version=9.9`].join(','))).toBe(false);
        // Past the range budget nothing is read, so a trailing supported
        // version cannot rescue the request either: the assertion is unreadable.
        expect(negotiate([...unrelated, `${vendor};version=0.1`].join(','))).toBe(false);
        expect(negotiate([...unrelated, `${vendor};version=9.9`].join(','))).toBe(false);
        expect(negotiate([...unrelated, 'text/html'].join(','))).toBe(false);
        expect(negotiate(['application/json', ...unrelated, `${vendor};version=9.9`].join(','))).toBe(true);
      });

      it('rejects a truncated trailing fragment rather than guessing its version', () => {
        const head = padTo(MAX_ACCEPT_LENGTH - 10, 'text/html');
        const accept = `${head}, ${vendor};version=0.1`;
        expect(accept.length).toBeGreaterThan(MAX_ACCEPT_LENGTH);
        expect(accept.slice(0, MAX_ACCEPT_LENGTH)).toContain(vendor.slice(0, 8));
        expect(negotiate(accept)).toBe(false);
      });
    });

    it('lets the host declare more versions and lists them in the Problem', async () => {
      const input = read({ supportedVersions: ['0.2', '0.1'] });
      for (const version of ['0.1', '0.2']) {
        const ok = await composePublicationHttpReadFromRequest(
          new Request(url, { headers: { 'Collection-Protocol-Version': version, Accept: `${vendor};version=${version}` } }),
          input,
        );
        expect(ok.status).toBe(200);
      }
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { 'Collection-Protocol-Version': '0.3' } }),
        input,
      );
      await expect406(response, ['0.2', '0.1']);
    });

    it('rejects a malformed supportedVersions declaration at composition time', async () => {
      const accessor: string[] = [];
      Object.defineProperty(accessor, 0, { enumerable: true, get: () => '0.1' });
      for (const supportedVersions of [
        [], ['0.1', '0.1'], ['v1'], ['0.1 '], 'x', [1], accessor, new Proxy(['0.1'], {}),
        Array.from({ length: 17 }, (_, index) => `0.${index}`),
      ]) {
        await expect(composePublicationHttpReadFromRequest(new Request(url), read({
          supportedVersions: supportedVersions as unknown as readonly string[],
        }))).rejects.toThrow(/supportedVersions/u);
      }
    });

    it('reads supportedVersions by descriptor without running iterators or getters', async () => {
      const declared = ['0.1'];
      const iterator = vi.fn(function* () { yield '9.9'; });
      Object.defineProperty(declared, Symbol.iterator, { value: iterator });
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { 'Collection-Protocol-Version': '9.9' } }),
        read({ supportedVersions: declared }),
      );
      await expect406(response);
      expect(iterator).not.toHaveBeenCalled();
    });

    it('rejects supportedVersions that are array-like but not arrays', () => {
      expect(() => negotiatePublicationVersion({ supportedVersions: { length: 1, 0: '0.1' } as unknown as readonly string[] }))
        .toThrow(/non-Proxy array/u);
    });

    it('decodes quoted-pair escapes inside quoted Accept parameters', () => {
      const negotiate = (accept: string) => negotiatePublicationVersion({ accept }).supported;
      expect(negotiate(`${vendor};version="0\\.1"`)).toBe(true);
      expect(negotiate(`${vendor};version="9\\.9"`)).toBe(false);
      // An escaped comma or quote inside the quoted value does not split the list.
      expect(negotiate(`${vendor};version="9\\,9", application/json`)).toBe(true);
      expect(negotiate(`${vendor};version="9\\"9"`)).toBe(false);
      // A trailing backslash is kept literally and the value is still unsupported.
      expect(negotiate(`${vendor};version="0.1\\"`)).toBe(false);
    });

    it.each([
      `${vendor};version`,
      `${vendor};=0.1`,
      `${vendor};ver sion=0.1`,
      `${vendor};version="`,
      `${vendor};version=0.1 beta`,
      `${vendor};q=1.5`,
      `${vendor};;version=9.9`,
    ])('treats the malformed participating parameter list %j as an unreadable assertion', (accept) => {
      expect(negotiatePublicationVersion({ accept }).supported).toBe(false);
    });

    it('ignores empty list items and non-string header values', () => {
      expect(negotiatePublicationVersion({ accept: `, ,${vendor};version=0.1,` }).supported).toBe(true);
      expect(negotiatePublicationVersion({ accept: '   ', protocolVersionHeader: null }).supported).toBe(true);
      expect(negotiatePublicationVersion({ accept: null, protocolVersionHeader: undefined }).supported).toBe(true);
      expect(negotiatePublicationVersion({ accept: 'application/*;q=0.5;version=0.1' }).supported).toBe(true);
    });

    it('keeps 405 ahead of version negotiation', async () => {
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { method: 'POST', headers: { 'Collection-Protocol-Version': '9.9' } }),
        read(),
      );
      expect(response.status).toBe(405);
    });

    it('does not consult the authorizer for an unsupported version', async () => {
      const authorize = vi.fn(() => ({ allowed: true as const, context: 'alice' }));
      const response = await composePublicationHttpReadFromRequest(
        new Request(url, { headers: { 'Collection-Protocol-Version': '9.9' } }),
        {
          endpoint: 'snapshot',
          access: 'authorized-private',
          authorize,
          resolveRepresentation: () => createPublicationHttpReadRepresentation('snapshot', snapshot, {
            lastModified,
            principalScope: 'principal:alice',
          }),
        },
      );
      await expect406(response);
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  it.each(['method', 'rawSearch', 'ifNoneMatch', 'protocolVersionHeader', 'accept'])('rejects input that sets %s itself', async (key) => {
    await expect(composePublicationHttpReadFromRequest(new Request(url), {
      ...read(),
      [key]: 'GET',
    } as PublicationHttpReadRequestInput)).rejects.toThrow(`must not set ${key}`);
  });

  it('keeps the strict input checks of composePublicationHttpRead', async () => {
    await expect(composePublicationHttpReadFromRequest(new Request(url), {
      ...read(),
      unexpected: true,
    } as unknown as PublicationHttpReadRequestInput)).rejects.toThrow('unsupported field');
  });
});

describe('a server built from the helpers', () => {
  it('is readable end to end by ColpClient', async () => {
    const origin = 'https://alice.example';
    const routes: Record<string, () => Promise<Response> | Response> = {};
    const handler = (request: Request): Promise<Response> | Response => {
      const route = routes[new URL(request.url).pathname];
      return route === undefined ? new Response(null, { status: 404 }) : route();
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      handler(new Request(input, init)));
    const serve = (endpoint: PublicationHttpReadEndpoint, value: unknown, revision?: string) =>
      (request: Request) => composePublicationHttpReadFromRequest(request, {
        endpoint,
        access: 'anonymous-public',
        resolveRepresentation: () => createPublicationHttpReadRepresentation(endpoint, value, {
          lastModified,
          ...(revision === undefined ? {} : { revision }),
        }),
      });
    const at = (path: string, route: (request: Request) => Promise<Response>) => {
      routes[path] = () => route(new Request(origin + path));
    };
    const collectionPath = `/collections/c/${snapshot.collection.id}`;
    const served = {
      collection: snapshot.collection,
      links: {
        self: origin + collectionPath,
        canonical: snapshot.collection.canonicalUrl,
        snapshot: `${origin}${collectionPath}/snapshot`,
      },
    };
    at('/.well-known/collection-protocol', serve('manifest', manifest, 'manifest-r1'));
    at('/collections', serve('directory', directory, 'directory-r1'));
    at(collectionPath, serve('metadata', served));
    at(`${collectionPath}/snapshot`, serve('snapshot', snapshot));

    const client = new ColpClient({ manifestUrl: `${origin}/.well-known/collection-protocol`, fetch });
    await expect(client.discover()).resolves.toMatchObject({ title: manifest.title });
    await expect(client.getDirectory()).resolves.toMatchObject({ collections: expect.any(Array) });
    await expect(client.getCollection(snapshot.collection.id)).resolves.toMatchObject({
      collection: { id: snapshot.collection.id },
    });
    await expect(client.getSnapshot(snapshot.collection.id)).resolves.toMatchObject({
      snapshotId: snapshot.snapshotId,
    });
  });
});
