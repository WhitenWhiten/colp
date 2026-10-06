import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import {
  declarePublicationEndpoints,
  validateServerEndpointVariables,
} from '../../src/server/index.js';
import type { ManifestMount } from '../../src/types/index.js';

const evidence = 'http.endpoint-driven';
const validators = createValidatorRegistry();
const fixturePath = resolve(
  import.meta.dirname,
  '..',
  '..',
  'fixtures',
  'protocol',
  'examples',
  'public-manifest.json',
);

async function customMount(): Promise<ManifestMount> {
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as { mounts: ManifestMount[] };
  const mount = structuredClone(manifest.mounts[0]!);
  mount.baseUrl = 'https://trap.example/conventional/' as ManifestMount['baseUrl'];
  const endpoints = mount.endpoints as unknown as Record<string, string | undefined>;
  endpoints.directory = 'https://static.example/pub/directory.json';
  endpoints.collection = 'https://objects.example/metadata/{collectionId}.json';
  endpoints.snapshot = 'https://archive.example/snapshots/{collectionId}.json';
  return mount;
}

describe(`PUB-0002 declarative server endpoint contract [evidence:${evidence}]`, () => {
  it.each([
    ['directory', 'https://static.example/pub/directory.json', [], 'directoryQuery', 'collectionDirectory'],
    ['collection', 'https://objects.example/metadata/{collectionId}.json', ['collectionId'], undefined, 'collectionMetadata'],
    ['snapshot', 'https://archive.example/snapshots/{collectionId}.json', ['collectionId'], 'snapshotQuery', 'snapshot'],
  ] as const)(
    'declares publication GET routing for %s instead of a conventional object path [evidence:http.endpoint-driven]',
    async (endpointKey, template, variables, query, response) => {
      const declaration = declarePublicationEndpoints(await customMount())
        .find((candidate) => candidate.endpoint === endpointKey)!;

      expect(declaration.template).toBe(template);
      expect(declaration.template).not.toContain('trap.example/conventional');
      expect(declaration.variables).toEqual(variables);
      expect(declaration.operation).toMatchObject({
        method: 'GET',
        profile: 'publication',
        response,
        successStatuses: [200, 304],
        requiredResponseHeaders: ['ETag'],
        ...(query === undefined ? {} : { query }),
      });
    },
  );

  it.each([
    ['directory', {}],
    ['collection', { collectionId: 'custom-static-object' }],
    ['snapshot', { collectionId: 'custom-static-object' }],
  ] as const)(
    'accepts the exact declared variable binding for the %s server route [evidence:http.endpoint-driven]',
    (endpointKey, variables) => {
      expect(validateServerEndpointVariables(endpointKey, variables, validators)).toEqual({
        valid: true,
        value: variables,
      });
    },
  );

  it.each([
    ['directory', { collectionId: 'guessed-from-path' }],
    ['collection', {}],
    ['snapshot', { snapshotId: 'guessed-from-path' }],
  ] as const)(
    'rejects guessed or mismatched variable bindings for the %s server route [evidence:http.endpoint-driven]',
    (endpointKey, variables) => {
      expect(validateServerEndpointVariables(endpointKey, variables, validators)).toMatchObject({
        valid: false,
        code: 'invalid_path_variables',
      });
    },
  );
});
