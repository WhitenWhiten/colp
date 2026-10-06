import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodePublicationQuery,
  parseProtocolQuery,
  validatePublicationEndpointDto,
  validatePublicationEndpointQuery,
  validatePublicationEndpointRequest,
  validatePublicationEndpointResponse,
} from '../../src/server/index.js';
import {
  createValidatorRegistry,
  type DefinitionName,
  type ValidatorRegistry,
} from '../../src/schema/index.js';
import { endpointContracts } from '../../src/semantic/index.js';

const evidence = 'http.endpoint-dto';
const validators = createValidatorRegistry();
const fixtureRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');

const publicationOperations = [
  { endpoint: 'directory', method: 'GET', query: 'directoryQuery', response: 'collectionDirectory' },
  { endpoint: 'collection', method: 'GET', response: 'collectionMetadata' },
  { endpoint: 'snapshot', method: 'GET', query: 'snapshotQuery', response: 'snapshot' },
  { endpoint: 'node', method: 'GET', query: 'nodeDetailQuery', response: 'nodeDetail' },
] as const;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtureRoot, name), 'utf8')) as unknown;
}

function trackingRegistry(selected: DefinitionName[]): ValidatorRegistry {
  return {
    definitionNames: validators.definitionNames,
    get: (name) => validators.get(name),
    validate(name, value) {
      selected.push(name);
      return validators.validate(name, value);
    },
  };
}

describe(`PUB-0018 publication endpoint DTOs [evidence:${evidence}]`, () => {
  it(`matches every Publication operation and named DTO in the Endpoint Contract Registry [evidence:${evidence}]`, () => {
    const actual = Object.entries(endpointContracts).flatMap(([endpoint, contract]) =>
      contract.operations
        .filter((operation) => operation.profile === 'publication')
        .map((operation) => ({
          endpoint,
          method: operation.method,
          ...('query' in operation ? { query: operation.query } : {}),
          ...('request' in operation ? { request: operation.request } : {}),
          ...('response' in operation ? { response: operation.response } : {}),
        })),
    );
    expect(actual).toEqual(publicationOperations);

    const names = publicationOperations.flatMap((operation) =>
      'query' in operation ? [operation.query, operation.response] : [operation.response],
    );
    expect(names).toEqual([
      'directoryQuery',
      'collectionDirectory',
      'collectionMetadata',
      'snapshotQuery',
      'snapshot',
      'nodeDetailQuery',
      'nodeDetail',
    ]);
    expect(names.every((name) => validators.definitionNames.includes(name))).toBe(true);
  });

  it.each([
    ['directory', 'query', { limit: 1 }, 'directoryQuery'],
    ['directory', 'response', 'collection-directory.json', 'collectionDirectory'],
    ['collection', 'response', 'collection-metadata.json', 'collectionMetadata'],
    ['snapshot', 'query', { limit: 1 }, 'snapshotQuery'],
    ['snapshot', 'response', 'collection-snapshot.json', 'snapshot'],
    ['node', 'query', { include: ['relations'] }, 'nodeDetailQuery'],
    ['node', 'response', 'node-detail.json', 'nodeDetail'],
  ] as const)(
    `selects the exact named $defs for %s GET %s [evidence:${evidence}]`,
    async (endpoint, kind, input, definition) => {
      const value = typeof input === 'string' ? await fixture(input) : input;
      const selected: DefinitionName[] = [];
      const result = validatePublicationEndpointDto(endpoint, 'GET', kind, value, {
        validators: trackingRegistry(selected),
      });
      expect(result.valid).toBe(true);
      expect(selected).toEqual([definition]);
    },
  );

  it.each([
    ['directory', {}],
    // Non-empty q is the filled directory boundary; empty q is rejected below and in PUB-0010 (`?q=`).
    ['directory', { cursor: 'cursor-1', limit: 1, kind: 'mixed', updatedSince: '2026-07-18T00:00:00Z', q: 'notes' }],
    ['snapshot', {}],
    ['snapshot', { pageCursor: 'cursor-1', limit: 1, depth: 0, root: 'root-1', include: [] }],
    ['node', {}],
    ['node', { include: ['annotations', 'attachments', 'relations'] }],
  ] as const)(`accepts normal and boundary %s query DTOs [evidence:${evidence}]`, (endpoint, value) => {
    expect(validatePublicationEndpointQuery(endpoint, value)).toEqual({ valid: true, value });
  });

  it.each([
    ['directory', { limit: 0 }],
    ['directory', { updatedSince: '2026-07-18' }],
    ['directory', { unknown: true }],
    // Empty scalar q must fail the endpoint DTO path (F-06); codec peer: PUB-0010 rejects `?q=`.
    ['directory', { q: '' }],
    ['snapshot', { depth: -1 }],
    ['snapshot', { include: ['relations', 'relations'] }],
    ['snapshot', { anyOf: [{ root: 'impostor' }] }],
    ['node', { include: ['unknown'] }],
    ['node', { include: ['relations', 'relations'] }],
    ['node', { anyOf: [{ node: 'impostor' }] }],
  ] as const)(`rejects negative, malformed, and root-anyOf-impostor %s queries [evidence:${evidence}]`, (endpoint, value) => {
    const result = validatePublicationEndpointQuery(endpoint, value);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.stage).toBe('structural');
  });

  it(`rejects empty directory q consistently with decodePublicationQuery and parseProtocolQuery [evidence:${evidence}]`, () => {
    // Cross-layer F-06: DTO structural validation, raw codec decode, and named-contract parse
    // must all conclude empty `q` is invalid (see also PUB-0010 `?q=` / client empty-q cases).
    const emptyQ = { q: '' };
    const dto = validatePublicationEndpointQuery('directory', emptyQ);
    expect(dto).toMatchObject({ valid: false, stage: 'structural' });
    if (!dto.valid && dto.stage === 'structural') {
      expect(Array.isArray(dto.errors)).toBe(true);
      expect(dto.errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(dto)).not.toContain('secret');
    }

    const decoded = decodePublicationQuery('directory', '?q=', validators);
    expect(decoded).toMatchObject({ valid: false, status: 400, code: 'invalid_query' });
    if (!decoded.valid) {
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.errors)).toBe(true);
      expect(decoded.errors.length).toBeGreaterThan(0);
    }

    const parsed = parseProtocolQuery('directoryQuery', new URLSearchParams('q='), validators);
    expect(parsed).toMatchObject({ valid: false, code: 'invalid_query' });
    if (!parsed.valid) {
      expect(Object.isFrozen(parsed.errors)).toBe(true);
      expect(parsed.errors.some((error) => /empty/iu.test(error))).toBe(true);
    }

    expect(dto.valid).toBe(false);
    expect(decoded.valid).toBe(false);
    expect(parsed.valid).toBe(false);
  });

  it.each([
    ['directory', 'collection-directory.json'],
    ['collection', 'collection-metadata.json'],
    ['snapshot', 'collection-snapshot.json'],
    ['node', 'node-detail.json'],
  ] as const)(`accepts the valid %s response boundary [evidence:${evidence}]`, async (endpoint, file) => {
    const value = await fixture(file);
    expect(validatePublicationEndpointResponse(endpoint, 'GET', value)).toEqual({ valid: true, value });
  });

  it.each([
    ['directory', 'collection-metadata.json'],
    ['collection', 'collection-directory.json'],
    ['snapshot', 'node-detail.json'],
    ['node', 'collection-metadata.json'],
  ] as const)(`rejects a root-schema-valid %s response impostor from another endpoint [evidence:${evidence}]`, async (endpoint, file) => {
    const result = validatePublicationEndpointResponse(endpoint, 'GET', await fixture(file));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.stage).toBe('structural');
  });

  it.each(['directory', 'collection', 'snapshot', 'node'] as const)(
    `rejects undefined %s GET request bodies without reflecting input [evidence:${evidence}]`,
    (endpoint) => {
      const sensitive = 'https://cross-origin.example/private/secret-token';
      expect(() => validatePublicationEndpointRequest(endpoint, 'GET', { sensitive })).toThrowError(
        `Publication request is not defined for GET ${endpoint}.`,
      );
      try {
        validatePublicationEndpointRequest(endpoint, 'GET', { sensitive });
      } catch (error) {
        expect(String(error)).not.toContain(sensitive);
      }
    },
  );

  it(`rejects the undefined Collection query and missing Publication methods non-reflectively [evidence:${evidence}]`, () => {
    const sensitive = 'https://cross-origin.example/private/secret-token';
    const calls = [
      () => validatePublicationEndpointDto('collection', 'GET', 'query', { sensitive }),
      () => validatePublicationEndpointDto('snapshot', 'POST', 'response', { sensitive }),
    ];
    for (const call of calls) {
      expect(call).toThrow();
      try {
        call();
      } catch (error) {
        expect(String(error)).not.toContain(sensitive);
      }
    }
  });

  it.each([
    ['directory', 'POST', 'request'],
    ['collection', 'PATCH', 'request'],
    ['collection', 'DELETE', 'response'],
    ['node', 'PATCH', 'request'],
    ['node', 'DELETE', 'query'],
  ] as const)(
    `does not expose publisher %s %s %s DTOs through the Publication boundary [evidence:${evidence}]`,
    (endpoint, method, kind) => {
      expect(() => validatePublicationEndpointDto(endpoint, method, kind, {})).toThrowError(
        `Endpoint Contract Registry has no Publication ${method} contract for ${endpoint}.`,
      );
    },
  );

  it.each(['directory', 'collection', 'snapshot', 'node'] as const)(
    `returns non-reflecting structural errors for invalid %s responses [evidence:${evidence}]`,
    (endpoint) => {
      const sensitive = 'https://cross-origin.example/private/secret-token';
      const result = validatePublicationEndpointResponse(endpoint, 'GET', {
        anyOf: [{ links: { self: sensitive } }],
      });
      expect(result.valid).toBe(false);
      expect(JSON.stringify(result)).not.toContain(sensitive);
    },
  );
});
