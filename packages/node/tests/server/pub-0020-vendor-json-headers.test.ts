import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createPublicationManifestDiscoveryHandler } from '../../src/server/publication-manifest-discovery.js';
import { mergePublicationDiscoveryHeaders } from '../../src/server/publication-discovery-links.js';

const evidence = '[evidence:http.vendor-json]';
const fixturePath = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples', 'public-manifest.json');

describe(`PUB-0020 vendor response header contract ${evidence}`, () => {
  it(`preserves cross-Origin and Vary while adding discovery metadata ${evidence}`, () => {
    const preserved = mergePublicationDiscoveryHeaders({
      Origin: 'https://consumer.example',
      Vary: 'Origin, Accept',
    });
    expect(preserved).toMatchObject({
      Origin: 'https://consumer.example',
      Vary: 'Origin, Accept',
    });

    const manifest = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const handler = createPublicationManifestDiscoveryHandler(manifest);
    const response = handler({ method: 'GET', path: '/.well-known/collection-protocol' });
    expect(response?.headers['content-type']).toBe(
      'application/vnd.collection-protocol.manifest+json;version=0.1',
    );
    expect(response?.headers.Link).toContain('collection-protocol');
    const merged = response?.headers;
    expect(merged).toBeDefined();
    expect(Object.keys(merged ?? {})).toEqual(expect.arrayContaining([
      'cache-control',
      'content-type',
      'content-length',
      'etag',
      'Link',
    ]));
  });

  it(`keeps discovery headers identical for HEAD while omitting the body ${evidence}`, () => {
    const manifest = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
    const handler = createPublicationManifestDiscoveryHandler(manifest);
    const get = handler({ method: 'GET', path: '/.well-known/collection-protocol' });
    const head = handler({ method: 'HEAD', path: '/.well-known/collection-protocol' });
    expect(head?.headers).toEqual(get?.headers);
    expect(head?.body).toBeNull();
  });
});
