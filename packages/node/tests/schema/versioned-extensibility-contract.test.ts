import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  type DefinitionName,
  validateWireDocument,
} from '../../src/schema/index.js';
import {
  type ServerWireDocumentValidationResult,
  validateServerWireDocument,
} from '../../src/server/index.js';

const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();
const evidence = '[evidence:core.versioned-extensibility]';

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as Record<string, any>;
}

function expectUnknownCoreField(
  definition: DefinitionName,
  value: unknown,
  instancePath: string,
  field = 'futureCoreField',
): void {
  const result = validators.validate(definition, value);
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({
      instancePath,
      keyword: 'additionalProperties',
      params: { additionalProperty: field },
    }),
  ]));
}

type JsonSchema = Record<string, any>;

const reviewedOpenObjects = {
  // Protocol-defined extension and embedded/user-defined JSON containers remain opaque by design.
  '#/$defs/extensions': 'namespaced extension values',
  '#/$defs/operationResult/properties/transform': 'server-defined operation transform',
  '#/$defs/auditEvent/properties/metadata': 'audit metadata',
  '#/$defs/mcpTool/properties/inputSchema': 'embedded JSON Schema',
  '#/$defs/mcpTool/properties/outputSchema': 'embedded JSON Schema',
  '#/$defs/mcpTool/properties/_meta': 'MCP implementation metadata',
  // These are keyed maps, not protocol objects whose property names are core fields.
  '#/$defs/problem/properties/links': 'relation-keyed HTTP links',
  '#/$defs/changePlan/properties/baseRevisions': 'resource-keyed revisions',
  // Open placeholders are closed by exhaustive discriminant branches below.
  '#/$defs/operation/properties/payload': 'operation discriminant slot',
  '#/$defs/feedEvent/properties/data': 'feed-event discriminant slot',
  // Constraint-only schemas compose with an already closed protocol object.
  '#/$defs/syncCollectionPush/properties/operations/not/contains': 'negative applicator',
  '#/$defs/syncInstanceCreatePush/properties/operations/items/allOf/1': 'allOf refinement',
  '#/$defs/activeReplicaLease/allOf/1': 'allOf refinement',
} as const;

function schemaObjectPaths(): { closed: string[]; open: string[]; rootClosed: string[]; rootOpen: string[] } {
  const closed: string[] = [];
  const open: string[] = [];
  const rootClosed: string[] = [];
  const rootOpen: string[] = [];

  function visit(value: unknown, path: string): void {
    if (value === null || typeof value !== 'object') return;
    const schema = value as JsonSchema;
    if (schema.type === 'object') {
      (schema.additionalProperties === false ? closed : open).push(path);
    }
    for (const [key, child] of Object.entries(schema)) visit(child, `${path}/${key}`);
  }

  for (const [name, definition] of Object.entries((collectionProtocolSchema as JsonSchema).$defs)) {
    const path = `#/$defs/${name}`;
    visit(definition, path);
    if ((definition as JsonSchema).type === 'object') {
      ((definition as JsonSchema).additionalProperties === false ? rootClosed : rootOpen).push(path);
    }
  }
  return { closed, open, rootClosed, rootOpen };
}

describe(`exact-version extensibility ${evidence}`, () => {
  it('audits every definition and permits only reviewed opaque, map, dispatch, or applicator objects', () => {
    const definitions = (collectionProtocolSchema as JsonSchema).$defs as Record<string, JsonSchema>;
    const paths = schemaObjectPaths();

    expect(Object.keys(definitions)).toHaveLength(191);
    expect(definitions.globalResourceIdentity).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['serverUuid', 'resourceType', 'id'],
    });
    expect(paths.rootClosed).toHaveLength(160);
    expect(paths.rootOpen).toEqual(['#/$defs/extensions']);
    // CORE-0027 adds one closed Snapshot-only Node projection without opening core fields.
    // F2 adds five closed MCP node-tool objects (search input, hit, result, move, delete subtree).
    expect(paths.closed).toHaveLength(169);
    expect(paths.open).toHaveLength(13);
    expect(paths.open.sort()).toEqual(Object.keys(reviewedOpenObjects).sort());
  });

  it('keeps operation and feed open slots behind exhaustive discriminant dispatch', () => {
    const definitions = (collectionProtocolSchema as JsonSchema).$defs as Record<string, JsonSchema>;
    const operation = definitions.operation!;
    const operationTypes = operation.properties.type.enum as string[];
    const dispatchedOperationTypes = operation.allOf.flatMap((branch: JsonSchema) => {
      if (branch.then?.properties?.payload?.$ref === undefined) return [];
      const selector = branch.if.properties.type;
      return selector.const === undefined ? selector.enum : [selector.const];
    });
    expect(new Set(dispatchedOperationTypes)).toEqual(new Set(operationTypes));

    const feedEvent = definitions.feedEvent!;
    const coreFeedTypes = feedEvent.properties.type.oneOf[0].enum as string[];
    const dispatchedCoreFeedTypes = feedEvent.allOf.flatMap((branch: JsonSchema) => {
      if (branch.then?.properties?.data?.$ref === '#/$defs/extensionFeedEventData') return [];
      const selector = branch.if.properties.type;
      return selector.const === undefined ? selector.enum : [selector.const];
    });
    expect(new Set(dispatchedCoreFeedTypes)).toEqual(new Set(coreFeedTypes));
    expect(feedEvent.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({
        if: { properties: { type: { pattern: '^[Hh][Tt][Tt][Pp][Ss]://' } }, required: ['type'] },
        then: { properties: { data: { $ref: '#/$defs/extensionFeedEventData' } } },
      }),
    ]));
  });

  it('rejects future core fields across top-level, nested, union, create, and patch contracts', () => {
    const snapshot = fixture('collection-snapshot.json');
    snapshot.futureCoreField = true;
    expectUnknownCoreField('snapshot', snapshot, '');

    const nested = fixture('collection-snapshot.json');
    nested.collection.publication.futureCoreField = true;
    expectUnknownCoreField('snapshot', nested, '/collection/publication');

    const node = fixture('local-bookmark-node.json');
    node.futureCoreField = true;
    expectUnknownCoreField('node', node, '');

    const create = fixture('publisher-collection-create.json');
    create.collection.futureCoreField = true;
    expectUnknownCoreField('collectionCreateRequest', create, '/collection');

    const patch = { title: 'Updated', futureCoreField: true };
    expectUnknownCoreField('collectionMergePatch', patch, '');
  });

  it('rejects future core fields through allOf and if/then operation, sync, and feed boundaries', () => {
    const operation = fixture('sync-update-operation.json');
    operation.payload.futureCoreField = true;
    expectUnknownCoreField('operation', operation, '/payload');

    const push = fixture('sync-push.json');
    push.operations[0].payload.futureCoreField = true;
    expectUnknownCoreField('syncPush', push, '/operations/0/payload');

    const syncWrapper = fixture('sync-push.json');
    syncWrapper.futureCoreField = true;
    expectUnknownCoreField('syncPush', syncWrapper, '');

    const feed = fixture('public-feed.json');
    feed.events[0].data.futureCoreField = true;
    expectUnknownCoreField('feed', feed, '/events/0/data');

    const feedWrapper = fixture('public-feed.json');
    feedWrapper.events[0].futureCoreField = true;
    expectUnknownCoreField('feed', feedWrapper, '/events/0');
  });

  it('requires exact protocol versions instead of accepting a future-version core shape', () => {
    const snapshot = fixture('collection-snapshot.json');
    snapshot.protocolVersion = '0.2';
    const result = validators.validate('snapshot', snapshot);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ instancePath: '/protocolVersion', keyword: 'const' }),
    ]));

    const syncSession = fixture('sync-session-request.json');
    syncSession.protocolVersion = '0.2';
    expect(validators.validate('syncSessionRequest', syncSession).valid).toBe(false);
  });

  it('accepts arbitrary nested data only under a valid namespaced extensions member', () => {
    const namespace = 'https://vendor.example/collection-protocol/future/v1';
    const payload = { futureCoreField: { nested: [null, true, 7, { arbitrary: 'value' }] } };
    expect(validators.validate('extensions', { [namespace]: payload })).toEqual({ valid: true, errors: [] });

    const create = fixture('publisher-collection-create.json');
    create.collection.extensions = { [namespace]: payload };
    create.root.extensions = { [namespace]: { anotherUnknownShape: payload } };
    expect(validators.validate('collectionCreateRequest', create)).toEqual({ valid: true, errors: [] });

    const besideExtensions = fixture('publisher-collection-create.json');
    besideExtensions.collection.futureCoreField = payload;
    expectUnknownCoreField('collectionCreateRequest', besideExtensions, '/collection');
  });

  it('keeps extension feed data inside namespaced extensions without opening either wrapper', () => {
    const feed = fixture('public-feed.json');
    const collectionId = feed.events[0].data.collectionId;
    feed.events[0].type = 'https://vendor.example/events/future.v1';
    feed.events[0].data = {
      collectionId,
      extensions: {
        'https://vendor.example/events/future/v1': {
          arbitrary: { nested: [true, null, { future: 1 }] },
        },
      },
    };
    expect(validators.validate('feed', feed)).toEqual({ valid: true, errors: [] });

    feed.events[0].data.futureCoreField = true;
    expectUnknownCoreField('feed', feed, '/events/0/data');
    delete feed.events[0].data.futureCoreField;
    feed.events[0].futureCoreField = true;
    expectUnknownCoreField('feed', feed, '/events/0');
  });

  it('stops at structural validation before semantic processing or server dispatch', () => {
    const semantics = vi.fn((_value: unknown) => ({ valid: true as const, issues: [] as const }));
    const dispatch = vi.fn();
    const snapshot = fixture('collection-snapshot.json');
    snapshot.futureCoreField = true;

    const result = validateWireDocument(validators, 'snapshot', snapshot, (value) => {
      semantics(value);
      dispatch(value);
      return { valid: true as const, issues: [] as const };
    });

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('makes the exported server boundary stop before semantics on parse and structural failures', () => {
    const semantics = vi.fn((_value: Record<string, unknown>) => ({
      valid: true as const,
      issues: [] as const,
    }));

    const parseFailure = validateServerWireDocument(
      validators,
      'snapshot',
      '{"duplicate":1,"duplicate":2}',
      semantics,
    );
    expect(parseFailure).toMatchObject({ valid: false, stage: 'parse' });
    expect(semantics).not.toHaveBeenCalled();

    const snapshot = fixture('collection-snapshot.json');
    snapshot.futureCoreField = true;
    const structuralFailure = validateServerWireDocument(
      validators,
      'snapshot',
      JSON.stringify(snapshot),
      semantics,
    );
    expect(structuralFailure).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();
    expectTypeOf(structuralFailure).toMatchTypeOf<
      ServerWireDocumentValidationResult<Record<string, unknown>, never>
    >();
  });

  it('runs server semantics exactly once only after parsing and structural validation succeed', () => {
    const snapshot = fixture('collection-snapshot.json');
    const issue = { code: 'semantic-test' } as const;
    const semantics = vi.fn((_value: Record<string, unknown>) => ({
      valid: false as const,
      issues: [issue] as const,
    }));

    const result = validateServerWireDocument(
      validators,
      'snapshot',
      JSON.stringify(snapshot),
      semantics,
    );
    expect(result).toEqual({ valid: false, stage: 'semantic', issues: [issue] });
    expect(semantics).toHaveBeenCalledOnce();
  });

  it('makes the public client reject an unknown response field before returning it', async () => {
    const manifest = fixture('public-manifest.json');
    const snapshot = fixture('collection-snapshot.json');
    snapshot.futureCoreField = true;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
      return Response.json(snapshot, { headers: { ETag: '"snapshot-1"' } });
    });
    const client = new ColpClient({
      manifestUrl: 'https://alice.example/.well-known/collection-protocol',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.getSnapshot('019b3ca2-8424-7cc2-9a61-4bf44c23f07a')).rejects.toThrow(
      'Response does not satisfy snapshot',
    );
  });
});
