import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient, createLoopbackEgressPolicy, type ClientEgressPolicyContext } from '../../src/client/index.js';

const fixtures = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const fixture = (name: string) => readFile(resolve(fixtures, name), 'utf8');
const context = {} as ClientEgressPolicyContext;

describe('createLoopbackEgressPolicy', () => {
  it('allows exactly the listed loopback origins', () => {
    const policy = createLoopbackEgressPolicy(['http://127.0.0.1:8080', new URL('https://localhost:8443/path'), 'http://[::1]:3000']);
    expect(policy(new URL('http://127.0.0.1:8080/collections?cursor=2'), context)).toBe(true);
    expect(policy(new URL('https://localhost:8443/.well-known/collection-protocol'), context)).toBe(true);
    expect(policy(new URL('http://[::1]:3000/'), context)).toBe(true);
    expect(policy(new URL('http://127.0.0.1:8081/'), context)).toBe(false);
    expect(policy(new URL('http://localhost:8080/'), context)).toBe(false);
    expect(policy(new URL('https://alice.example/'), context)).toBe(false);
  });

  it.each([
    [[]],
    [['https://alice.example']],
    [['http://10.0.0.1:8080']],
    [['http://app.localhost:8080']],
    [['ftp://127.0.0.1']],
  ])('rejects %j', (origins) => {
    expect(() => createLoopbackEgressPolicy(origins)).toThrow(RangeError);
  });

  it('lets ColpClient follow a local Manifest to endpoints on another local port', async () => {
    const manifestUrl = 'https://127.0.0.1:7443/.well-known/collection-protocol';
    const manifest = (await fixture('public-manifest.json')).replaceAll('https://alice.example', 'https://127.0.0.1:7444');
    const directory = await fixture('collection-directory.json');
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return new Response(url.href === manifestUrl ? manifest : directory, {
        headers: { 'Content-Type': 'application/json', ETag: '"loopback-fixture"' },
      });
    });
    const clientFor = (origins: readonly string[]) => new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
      egressPolicy: createLoopbackEgressPolicy(origins),
    });

    await expect(clientFor(['https://127.0.0.1:7443']).getDirectory()).rejects.toThrow(/Egress policy denied/);
    await expect(clientFor(['https://127.0.0.1:7443', 'https://127.0.0.1:7444']).getDirectory())
      .resolves.toMatchObject({ collections: expect.any(Array) });
  });
});
