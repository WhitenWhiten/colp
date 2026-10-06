import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import type { ManifestMount } from '../../src/types/index.js';

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

async function mountFixture(): Promise<ManifestMount> {
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    mounts: ManifestMount[];
  };
  const mount = structuredClone(manifest.mounts[0]!);
  mount.profiles = ['core', 'publication'];
  return mount;
}

describe(`PUB-0001 publication Mount schema contract [evidence:${evidence}]`, () => {
  const registry = createValidatorRegistry();

  it(`accepts a publication Mount declaring directory, collection, and snapshot [evidence:${evidence}]`, async () => {
    const mount = await mountFixture();

    expect(registry.validate('manifestMount', mount)).toEqual({ valid: true, errors: [] });
  });

  it.each(publicationEndpoints)(
    `rejects a publication Mount missing %s [evidence:${evidence}]`,
    async (missingEndpoint) => {
      const mount = await mountFixture();
      delete mount.endpoints[missingEndpoint];

      const result = registry.validate('manifestMount', mount);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              instancePath: '/endpoints',
              keyword: 'required',
              params: { missingProperty: missingEndpoint },
            }),
          ]),
        );
      }
    },
  );

  it(`does not require publication endpoints from a non-publication Mount [evidence:${evidence}]`, async () => {
    const mount = await mountFixture();
    mount.profiles = ['core'];
    for (const endpoint of publicationEndpoints) delete mount.endpoints[endpoint];

    expect(registry.validate('manifestMount', mount)).toEqual({ valid: true, errors: [] });
  });
});
