import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import type { ManifestMount } from '../../src/types/index.js';

const evidence = 'manifest.template-variables';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

async function publicationMount(): Promise<ManifestMount> {
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    mounts: ManifestMount[];
  };
  const mount = structuredClone(manifest.mounts[0]!);
  mount.profiles = ['core', 'publication'];
  mount.endpoints = {
    directory: 'https://static.example.test/catalog/directory.json',
    collection: 'https://api.example.test/c/{collectionId}',
    snapshot: 'https://api.example.test/c/{collectionId}/snapshot.json',
  } as ManifestMount['endpoints'];
  mount.features = {};
  return mount;
}

const acceptedPublicationTemplates = [
  ['directory static HTTPS JSON', 'directory', 'https://static.example.test/catalog/directory.json'],
  ['directory loopback HTTP JSON', 'directory', 'http://127.0.0.1:4173/directory.json'],
  ['collection exact variable over HTTPS', 'collection', 'https://api.example.test/c/{collectionId}.json'],
  ['collection exact variable over loopback HTTP', 'collection', 'http://localhost:4173/c/{collectionId}.json'],
  ['snapshot exact variable over HTTPS', 'snapshot', 'https://api.example.test/c/{collectionId}/snapshot.json'],
  ['snapshot exact variable over IPv6 loopback HTTP', 'snapshot', 'http://[::1]:4173/c/{collectionId}/snapshot.json'],
  ['snapshot repeated exact variable', 'snapshot', 'https://api.example.test/c/{collectionId}/copies/{collectionId}.json'],
] as const;

const rejectedPublicationTemplates = [
  ['relative template', 'collection', '/c/{collectionId}.json'],
  ['non-loopback HTTP template', 'snapshot', 'http://api.example.test/c/{collectionId}/snapshot.json'],
  ['userinfo template', 'collection', 'https://user:secret@api.example.test/c/{collectionId}.json'],
  ['Level 2 reserved expansion', 'collection', 'https://api.example.test/c/{+collectionId}.json'],
  ['Level 2 fragment expansion', 'snapshot', 'https://api.example.test/c/{#collectionId}.json'],
  ['Level 3 path prefix modifier', 'collection', 'https://api.example.test/c/{collectionId:3}.json'],
  ['Level 3 query expansion', 'snapshot', 'https://api.example.test/snapshot{?collectionId}'],
  ['missing closing brace', 'collection', 'https://api.example.test/c/{collectionId.json'],
  ['unexpected closing brace', 'snapshot', 'https://api.example.test/c/collectionId}/snapshot.json'],
  ['nested malformed braces', 'collection', 'https://api.example.test/c/{{collectionId}}.json'],
] as const;

describe(`PUB-0003 publication endpoint template schema contract [evidence:${evidence}]`, () => {
  const registry = createValidatorRegistry();

  it.each(acceptedPublicationTemplates)(
    `%s is an absolute Level 1 template [evidence:${evidence}]`,
    async (_caseName, endpoint, template) => {
      const mount = await publicationMount();
      mount.endpoints[endpoint] = template as never;

      expect(registry.validate('manifestMount', mount)).toEqual({ valid: true, errors: [] });
    },
  );

  it.each(rejectedPublicationTemplates)(
    `rejects %s [evidence:${evidence}]`,
    async (_caseName, endpoint, template) => {
      const mount = await publicationMount();
      mount.endpoints[endpoint] = template as never;

      const result = registry.validate('manifestMount', mount);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              instancePath: `/endpoints/${endpoint}`,
              keyword: 'format',
              params: { format: 'uri-template' },
            }),
          ]),
        );
      }
    },
  );
});
