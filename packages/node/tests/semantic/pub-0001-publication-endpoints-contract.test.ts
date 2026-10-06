import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateManifestSemantics } from '../../src/semantic/index.js';
import type { Manifest } from '../../src/types/index.js';

const evidence = 'manifest.publication-endpoints';
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);
const publicationEndpoints = ['directory', 'collection', 'snapshot'] as const;

async function manifestFixture(): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as Manifest;
  manifest.mounts[0]!.profiles = ['core', 'publication'];
  return manifest;
}

describe(`PUB-0001 publication Mount semantic contract [evidence:${evidence}]`, () => {
  it(`accepts a publication Mount declaring directory, collection, and snapshot [evidence:${evidence}]`, async () => {
    const manifest = await manifestFixture();

    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });
  });

  it.each(publicationEndpoints)(
    `rejects a publication Mount missing %s [evidence:${evidence}]`,
    async (missingEndpoint) => {
      const manifest = await manifestFixture();
      delete manifest.mounts[0]!.endpoints[missingEndpoint];

      const result = validateManifestSemantics(manifest);

      expect(result).toEqual({
        valid: false,
        issues: [
          {
            code: 'missing_profile_endpoint',
            path: '/mounts/0/endpoints',
            message: `Profile publication requires endpoint ${missingEndpoint}.`,
          },
        ],
      });
    },
  );

  it(`does not require publication endpoints from a non-publication Mount [evidence:${evidence}]`, async () => {
    const manifest = await manifestFixture();
    manifest.mounts[0]!.profiles = ['core'];
    for (const endpoint of publicationEndpoints) {
      delete manifest.mounts[0]!.endpoints[endpoint];
    }

    expect(validateManifestSemantics(manifest)).toEqual({ valid: true, issues: [] });
  });
});
