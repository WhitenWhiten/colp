/**
 * Additive OpenAPI parameter stripping (EX-01).
 *
 * Extra required:false query/header parameters on an existing operation are
 * compatible with N-1 clients. These tests use in-memory mini documents so the
 * rule is proven before product-v1.yaml grows ExploreSort.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  findBreakingChanges,
} from '../../../scripts/check-openapi-breaking.mjs';

type ParameterObject = {
  name: string;
  in: string;
  required?: boolean;
  schema?: unknown;
};

type MiniDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: {
    '/api/v1/explore/collections': {
      get: {
        operationId: string;
        parameters: Array<{ $ref: string } | ParameterObject>;
        responses: { '200': { description: string } };
      };
    };
  };
  components: {
    parameters: Record<string, ParameterObject>;
    schemas: Record<string, never>;
  };
};

const EXPLORE_PATH = '/api/v1/explore/collections';

function baselineParameters(): Array<{ $ref: string }> {
  return [
    { $ref: '#/components/parameters/ExploreQuery' },
    { $ref: '#/components/parameters/ExploreTag' },
    { $ref: '#/components/parameters/ExploreLimit' },
    { $ref: '#/components/parameters/ExploreCursor' },
  ];
}

function baselineComponents(): MiniDocument['components']['parameters'] {
  return {
    ExploreQuery: { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
    ExploreTag: { name: 'tag', in: 'query', required: false, schema: { type: 'string' } },
    ExploreLimit: { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ExploreCursor: { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
  };
}

function miniExploreDocument(input: {
  readonly parameters?: MiniDocument['paths']['/api/v1/explore/collections']['get']['parameters'];
  readonly extraParameters?: Record<string, ParameterObject>;
}): MiniDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Explore additive parameters', version: '1.0.0' },
    paths: {
      [EXPLORE_PATH]: {
        get: {
          operationId: 'listExploreCollections',
          parameters: input.parameters ?? baselineParameters(),
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    components: {
      parameters: { ...baselineComponents(), ...(input.extraParameters ?? {}) },
      schemas: {},
    },
  };
}

function exploreSortParameter(required: boolean, location: string = 'query', name = 'sort'): ParameterObject {
  return {
    name,
    in: location,
    required,
    schema: { type: 'string', enum: ['updated', 'popular', 'links'] },
  };
}

test('adding required:false ExploreSort query parameter is additive', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({
    parameters: [...baselineParameters(), { $ref: '#/components/parameters/ExploreSort' }],
    extraParameters: { ExploreSort: exploreSortParameter(false) },
  });
  const failures = findBreakingChanges(baseline, candidate);
  assert.equal(failures.some((failure) => failure.includes('parameters changed')), false, failures.join('\n'));
  assert.deepEqual(failures, []);
});

test('deleting ExploreTag is still breaking', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({
    parameters: baselineParameters().filter((parameter) => parameter.$ref !== '#/components/parameters/ExploreTag'),
  });
  const failures = findBreakingChanges(baseline, candidate);
  assert.equal(failures.includes('GET /api/v1/explore/collections parameters changed'), true, failures.join('\n'));
});

test('adding required ExploreSort is still breaking', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({
    parameters: [...baselineParameters(), { $ref: '#/components/parameters/ExploreSort' }],
    extraParameters: { ExploreSort: exploreSortParameter(true) },
  });
  const failures = findBreakingChanges(baseline, candidate);
  assert.equal(failures.includes('GET /api/v1/explore/collections parameters changed'), true, failures.join('\n'));
});

test('adding extra path parameter is still breaking', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({
    parameters: [...baselineParameters(), { $ref: '#/components/parameters/ExploreSort' }],
    extraParameters: { ExploreSort: exploreSortParameter(false, 'path') },
  });
  const failures = findBreakingChanges(baseline, candidate);
  assert.equal(failures.includes('GET /api/v1/explore/collections parameters changed'), true, failures.join('\n'));
});

test('adding required:false header parameter is additive', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({
    parameters: [...baselineParameters(), { $ref: '#/components/parameters/ExploreSort' }],
    extraParameters: { ExploreSort: exploreSortParameter(false, 'header') },
  });
  const failures = findBreakingChanges(baseline, candidate);
  assert.deepEqual(failures, []);
});

test('changing an existing parameter name is still breaking', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({});
  candidate.components.parameters.ExploreQuery = {
    ...candidate.components.parameters.ExploreQuery!,
    name: 'query',
  };
  const failures = findBreakingChanges(baseline, candidate);
  assert.equal(failures.includes('GET /api/v1/explore/collections parameters changed'), true, failures.join('\n'));
});

test('changing an existing parameter in is still breaking', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({});
  candidate.components.parameters.ExploreTag = {
    ...candidate.components.parameters.ExploreTag!,
    in: 'header',
  };
  const failures = findBreakingChanges(baseline, candidate);
  assert.equal(failures.includes('GET /api/v1/explore/collections parameters changed'), true, failures.join('\n'));
});

test('$ref extra query parameters default required to false before the additive strip', () => {
  const baseline = miniExploreDocument({});
  const candidate = miniExploreDocument({
    parameters: [...baselineParameters(), { $ref: '#/components/parameters/ExploreSort' }],
    extraParameters: {
      ExploreSort: {
        name: 'sort',
        in: 'query',
        schema: { type: 'string', enum: ['updated', 'popular', 'links'] },
      },
    },
  });
  const failures = findBreakingChanges(baseline, candidate);
  assert.deepEqual(failures, []);
});
