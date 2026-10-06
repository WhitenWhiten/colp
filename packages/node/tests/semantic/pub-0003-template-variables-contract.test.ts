import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import { validateManifestSemantics } from '../../src/semantic/index.js';
import type { Manifest, ManifestMount } from '../../src/types/index.js';

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
const registry = createValidatorRegistry();

async function publicationManifest(): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
  const mount = manifest.mounts[0]!;
  mount.profiles = ['core', 'publication'];
  mount.endpoints = {
    directory: 'https://static.example.test/catalog/directory.json',
    collection: 'https://api.example.test/c/{collectionId}.json',
    snapshot: 'http://127.0.0.1:4173/c/{collectionId}/snapshot.json',
  } as ManifestMount['endpoints'];
  mount.features = {};
  return manifest;
}

const missingEndpoints = ['directory', 'collection', 'snapshot'] as const;

const invalidVariableSets = [
  ['directory wrong variable', 'directory', 'https://api.example.test/d/{nodeId}.json', '[nodeId]', '[]'],
  ['collection missing variable', 'collection', 'https://api.example.test/c/current.json', '[]', '[collectionId]'],
  ['collection wrong variable', 'collection', 'https://api.example.test/c/{nodeId}.json', '[nodeId]', '[collectionId]'],
  ['collection extra variable', 'collection', 'https://api.example.test/c/{collectionId}/{nodeId}.json', '[collectionId, nodeId]', '[collectionId]'],
  ['snapshot missing variable', 'snapshot', 'https://api.example.test/snapshot/current.json', '[]', '[collectionId]'],
  ['snapshot wrong variable', 'snapshot', 'https://api.example.test/s/{snapshotId}.json', '[snapshotId]', '[collectionId]'],
  ['snapshot extra variable', 'snapshot', 'https://api.example.test/c/{collectionId}/s/{snapshotId}.json', '[collectionId, snapshotId]', '[collectionId]'],
  ['directory extra variable', 'directory', 'https://api.example.test/d/{collectionId}.json', '[collectionId]', '[]'],
] as const;

describe(`PUB-0003 publication endpoint variable semantic contract [evidence:${evidence}]`, () => {
  it(`accepts exact registered variables and static JSON endpoints [evidence:${evidence}]`, async () => {
    const manifest = await publicationManifest();

    expect(registry.validate('manifest', manifest)).toEqual({ valid: true, errors: [] });
    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });
  });

  it(`treats repeated occurrences as one variable-set member [evidence:${evidence}]`, async () => {
    const manifest = await publicationManifest();
    manifest.mounts[0]!.endpoints.snapshot =
      'https://api.example.test/c/{collectionId}/copies/{collectionId}/snapshot.json' as never;

    expect(registry.validate('manifest', manifest)).toEqual({ valid: true, errors: [] });
    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });
  });

  it.each(missingEndpoints)(
    `reports missing publication endpoint %s exactly [evidence:${evidence}]`,
    async (endpoint) => {
      const manifest = await publicationManifest();
      delete manifest.mounts[0]!.endpoints[endpoint];

      const structural = registry.validate('manifest', manifest);
      expect(structural.valid).toBe(false);
      if (!structural.valid) {
        expect(structural.errors.filter((error) => error.keyword === 'required')).toEqual([
          expect.objectContaining({
            instancePath: '/mounts/0/endpoints',
            params: { missingProperty: endpoint },
          }),
        ]);
      }
      expect(validateManifestSemantics(manifest)).toEqual({
        valid: false,
        issues: [
          {
            code: 'missing_profile_endpoint',
            path: '/mounts/0/endpoints',
            message: `Profile publication requires endpoint ${endpoint}.`,
          },
        ],
      });
    },
  );

  it.each(invalidVariableSets)(
    `reports %s exactly [evidence:${evidence}]`,
    async (_caseName, endpoint, template, actualVariables, expectedVariables) => {
      const manifest = await publicationManifest();
      manifest.mounts[0]!.endpoints[endpoint] = template as never;

      expect(registry.validate('manifest', manifest)).toEqual({ valid: true, errors: [] });
      expect(validateManifestSemantics(manifest)).toEqual({
        valid: false,
        issues: [
          {
            code: 'invalid_endpoint_variables',
            path: `/mounts/0/endpoints/${endpoint}`,
            message: `Endpoint ${endpoint} uses ${actualVariables}, expected ${expectedVariables}.`,
          },
        ],
      });
    },
  );

  it(`does not require publication endpoints on a core-only Mount [evidence:${evidence}]`, async () => {
    const manifest = await publicationManifest();
    manifest.mounts[0]!.profiles = ['core'];
    manifest.mounts[0]!.endpoints = {};

    expect(registry.validate('manifest', manifest)).toEqual({ valid: true, errors: [] });
    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });
  });

  it(`still validates a declared endpoint on a core-only Mount [evidence:${evidence}]`, async () => {
    const manifest = await publicationManifest();
    manifest.mounts[0]!.profiles = ['core'];
    manifest.mounts[0]!.endpoints = {
      collection: 'https://api.example.test/c/{nodeId}.json',
    } as ManifestMount['endpoints'];

    expect(registry.validate('manifest', manifest)).toEqual({ valid: true, errors: [] });
    expect(validateManifestSemantics(manifest)).toEqual({
      valid: false,
      issues: [
        {
          code: 'invalid_endpoint_variables',
          path: '/mounts/0/endpoints/collection',
          message: 'Endpoint collection uses [nodeId], expected [collectionId].',
        },
      ],
    });
  });
});
