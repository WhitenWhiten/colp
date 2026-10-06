import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ColpClient } from '../../src/client/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  validateWireDocument,
} from '../../src/schema/index.js';
import { endpointContracts } from '../../src/semantic/index.js';
import { validateServerWireDocument } from '../../src/server/index.js';
import { validateServerEndpointVariables } from '../../src/server/index.js';

const evidence = '[evidence:core.wire-id-syntax]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const manifestUrl = 'https://alice.example/.well-known/collection-protocol';
const collectionId = '019b3ca2-8424-7cc2-9a61-4bf44c23f07a';
const opaqueIdRef = '#/$defs/opaqueId';

type JsonRecord = Record<string, any>;

function fixture(name: string): JsonRecord {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonRecord;
}

function constrainsEveryStringBranch(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value !== 'object' || value === null) return false;
  const schema = value as Record<string, unknown>;
  if (schema.$ref === opaqueIdRef) return true;
  if (schema.type === 'null') return true;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes('array')) return constrainsEveryStringBranch(schema.items);
  if (types.includes('object') && schema.additionalProperties !== undefined) {
    return constrainsEveryStringBranch(schema.additionalProperties);
  }
  if (Array.isArray(schema.type) && !schema.type.includes('string')) return true;
  if (Array.isArray(schema.allOf) && schema.allOf.some(constrainsEveryStringBranch)) return true;
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches) && branches.every(constrainsEveryStringBranch)) return true;
  }
  return false;
}

function forbidsIdValue(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as Record<string, unknown>).type;
  return type === 'null' || (Array.isArray(type) && !type.includes('string'));
}

interface SchemaAudit {
  readonly referencePaths: readonly string[];
  readonly referencesBySlot: Readonly<Record<string, number>>;
  readonly nonOpaqueIdSlots: readonly string[];
  readonly forbiddenIdSlots: readonly string[];
}

function auditWireIdSchema(): SchemaAudit {
  const referencePaths: string[] = [];
  const referencesBySlot: Record<string, number> = {};
  const nonOpaqueIdSlots: string[] = [];
  const forbiddenIdSlots: string[] = [];

  function walk(value: unknown, path: readonly string[]): void {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;

    if (record.$ref === opaqueIdRef) {
      referencePaths.push(path.join('/'));
      const propertyIndex = path.lastIndexOf('properties');
      const slot = propertyIndex < 0 ? path.at(-1) ?? '<unknown>' : path[propertyIndex + 1]!;
      referencesBySlot[slot] = (referencesBySlot[slot] ?? 0) + 1;
    }

    const properties = record.properties;
    if (typeof properties === 'object' && properties !== null) {
      for (const [name, propertySchema] of Object.entries(properties)) {
        if (/ids?$/iu.test(name)) {
          const propertyPath = [...path, 'properties', name].join('/');
          if (forbidsIdValue(propertySchema)) forbiddenIdSlots.push(propertyPath);
          else if (!constrainsEveryStringBranch(propertySchema)) nonOpaqueIdSlots.push(propertyPath);
        }
      }
    }

    for (const [key, child] of Object.entries(record)) {
      if (Array.isArray(child)) {
        child.forEach((item, index) => walk(item, [...path, key, String(index)]));
      } else {
        walk(child, [...path, key]);
      }
    }
  }

  walk(collectionProtocolSchema.$defs, ['$defs']);
  return {
    referencePaths: referencePaths.sort(),
    referencesBySlot: Object.fromEntries(Object.entries(referencesBySlot).sort()),
    nonOpaqueIdSlots: nonOpaqueIdSlots.sort(),
    forbiddenIdSlots: forbiddenIdSlots.sort(),
  };
}

describe(`CORE-0015 Wire ID grammar ${evidence}`, () => {
  const validators = createValidatorRegistry();

  it.each(['A', 'z', '0', '-', '.', '_', '~'])(
    'accepts the one-character boundary %j',
    (value) => {
      expect(validators.validate('opaqueId', value)).toEqual({ valid: true, errors: [] });
    },
  );

  it.each([
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~',
    'a'.repeat(128),
    '019b3de2-7f76-7b8b-8ffc-941d6e6318de',
    'legacy-id_1~local',
  ])('accepts exact unreserved ASCII and opaque legacy forms: %s', (value) => {
    expect(validators.validate('opaqueId', value)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['', 'empty'],
    ['a'.repeat(129), '129 characters'],
    ['%41', 'percent encoding'],
    ['legacy/id', 'slash'],
    ['legacy\\id', 'backslash'],
    [' space', 'leading space'],
    ['space ', 'trailing space'],
    ['a\tb', 'tab'],
    ['a\nb', 'newline'],
    ['a\n', 'terminal newline'],
    ['a\rb', 'carriage return'],
    ['a\r\n', 'terminal CRLF'],
    ['a\u0000b', 'NUL control'],
    ['\u00e9', 'non-ASCII composed character'],
    ['e\u0301', 'combining normalization form'],
    ['\uff21', 'fullwidth confusable'],
    ['\u212a', 'compatibility confusable'],
    ['\ud83d\ude00', 'emoji surrogate pair'],
    ['\ud800', 'lone surrogate'],
  ])('rejects $label', (value) => {
    expect(validators.validate('opaqueId', value).valid).toBe(false);
  });

  it.each([...':/?#[]@!$&\'()*+,;='])('rejects URI reserved delimiter %j', (delimiter) => {
    expect(validators.validate('opaqueId', delimiter).valid).toBe(false);
  });

  it('keeps valid non-UUID IDs byte-for-byte opaque', () => {
    const legacyId = 'Legacy.ID_1~local';
    const result = validateWireDocument(
      validators,
      'opaqueId',
      legacyId,
      () => ({ valid: true as const, issues: [] as const }),
    );

    expect(result).toEqual({ valid: true, value: legacyId });
  });
});

describe(`CORE-0015 complete schema wiring ${evidence}`, () => {
  it('binds opaqueId to the exact contract', () => {
    expect(collectionProtocolSchema.$defs.opaqueId).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._~-]+$',
      not: { pattern: '[^A-Za-z0-9._~-]' },
    });
  });

  it('audits every property, item, nullable branch, conditional branch, and map reference', () => {
    const audit = auditWireIdSchema();

    expect(Object.keys(collectionProtocolSchema.$defs)).toHaveLength(186);
    expect(collectionProtocolSchema.$defs.globalResourceType.enum).toHaveLength(7);
    expect(collectionProtocolSchema.$defs.globalResourceIdentity.required).toEqual([
      'serverUuid',
      'resourceType',
      'id',
    ]);
    expect(collectionProtocolSchema.$defs.canonicalResourceUri.pattern).toContain('^colp:/resources/');
    expect(collectionProtocolSchema.$defs.globalResourceReference.oneOf).toEqual([
      { $ref: '#/$defs/opaqueId' },
      { $ref: '#/$defs/canonicalResourceUri' },
    ]);
    // CORE-0027 adds the reviewed Snapshot-only Node projection's nine ID references.
    expect(audit.referencePaths).toHaveLength(200);
    expect(audit.referencesBySlot).toEqual({
      0: 1,
      ackedCursor: 1,
      acknowledgedCursor: 1,
      afterId: 3,
      baseChildrenRevision: 1,
      baseConflictRevision: 1,
      baseRevision: 18,
      baseRevisions: 1,
      baseSourceParentRevision: 1,
      baseTargetParentRevision: 1,
      batchId: 3,
      beforeId: 3,
      browserProfileId: 1,
      childIds: 1,
      collectionId: 25,
      collectionRevision: 1,
      collections: 2,
      conflictId: 2,
      currentRevision: 1,
      cursor: 9,
      deleteCursor: 1,
      deleteRevision: 2,
      dependencies: 1,
      eventCursor: 1,
      fromNodeId: 2,
      generation: 2,
      id: 16,
      incomingOpId: 1,
      lastCursor: 1,
      lastRevision: 1,
      leaseId: 1,
      newParentId: 2,
      nextCursor: 9,
      nodeId: 2,
      opId: 2,
      operationId: 2,
      pageCursor: 2,
      parentId: 12,
      planId: 3,
      profileId: 1,
      releaseId: 1,
      replicaId: 5,
      recoveryCapability: 2,
      revision: 17,
      root: 1,
      rootNodeId: 1,
      serverCursor: 2,
      serverRevision: 1,
      serverUuid: 2,
      sessionId: 7,
      snapshotId: 1,
      sourceNodeIds: 1,
      sourceParentRevision: 1,
      syncCursor: 1,
      targetId: 8,
      targetNodeId: 5,
      targetParentRevision: 1,
      toNodeId: 2,
    });
  });

  it('keeps a reviewed exception list for non-wire and conditionally forbidden *Id slots', () => {
    const exceptions = {
      '$defs/actor/properties/id': 'absolute URI actor identity',
      '$defs/auditActor/properties/clientId': 'absolute URI OAuth client identity',
      '$defs/auditActor/properties/principalId': 'principal identity',
      '$defs/manifest/properties/serverId': 'service URL identity',
      '$defs/mcpToolsList/properties/id': 'JSON-RPC correlation identity',
      '$defs/principalRef/properties/id': 'principal identity',
      '$defs/rateLimitPolicy/properties/id': 'principal identity',
      '$defs/rateLimitPolicyUpdateRequest/properties/id': 'principal identity',
      '$defs/replicaBinding/allOf/0/then/properties/mountNativeId': 'native adapter identity',
      '$defs/replicaBinding/properties/mountNativeId': 'native adapter identity',
      '$defs/setRateLimitPlanOperation/properties/targetId': 'principal identity',
      '$defs/sourceRef/properties/nativeId': 'native adapter identity',
      '$defs/sourceRef/properties/nativeParentId': 'native adapter identity',
    } as const;
    expect(auditWireIdSchema().nonOpaqueIdSlots).toEqual(Object.keys(exceptions).sort());
    expect(auditWireIdSchema().forbiddenIdSlots).toEqual([
      '$defs/node/allOf/0/then/properties/parentId',
      '$defs/operation/allOf/0/then/properties/collectionId',
      '$defs/operation/allOf/0/then/properties/targetId',
      '$defs/operation/allOf/1/then/properties/targetId',
      '$defs/operationResult/allOf/0/then/properties/conflictId',
      '$defs/operationResult/allOf/2/then/properties/conflictId',
      '$defs/operationResult/allOf/3/then/properties/conflictId',
      '$defs/operationResult/allOf/4/then/properties/conflictId',
      '$defs/snapshot/properties/nodes/items/oneOf/1/allOf/0/then/properties/parentId',
    ]);
    expect(new Set(Object.values(exceptions))).toEqual(new Set([
      'absolute URI actor identity',
      'absolute URI OAuth client identity',
      'JSON-RPC correlation identity',
      'native adapter identity',
      'principal identity',
      'service URL identity',
    ]));
  });

  it('covers every canonical endpoint and classifies only ID template variables', () => {
    const canonicalEndpoints = Object.keys(
      collectionProtocolSchema.$defs.manifestEndpoints.properties,
    ).sort();
    const registeredEndpoints = Object.keys(endpointContracts).sort();

    expect(canonicalEndpoints).toHaveLength(32);
    expect(registeredEndpoints).toEqual(canonicalEndpoints);
    for (const contract of Object.values(endpointContracts)) {
      expect(contract.variables.every((name) => /Id$/u.test(name))).toBe(true);
    }
  });
});

describe(`CORE-0015 representative wire documents ${evidence}`, () => {
  const validators = createValidatorRegistry();
  const invalidId = 'not/a-wire-id';

  it.each([
    ['Snapshot collection', 'snapshot', 'collection-snapshot.json', (value: JsonRecord) => { value.collection.id = invalidId; }],
    ['Snapshot node', 'snapshot', 'collection-snapshot.json', (value: JsonRecord) => { value.nodes[1].parentId = invalidId; }],
    ['Snapshot sidecar', 'snapshot', 'collection-snapshot.json', (value: JsonRecord) => { value.annotations[0].subject.id = invalidId; }],
    ['Node', 'node', 'local-bookmark-node.json', (value: JsonRecord) => { value.id = invalidId; }],
    ['Create', 'annotationCreate', 'publisher-annotation-create.json', (value: JsonRecord) => { value.subject.id = invalidId; }],
    ['Operation', 'operation', 'sync-update-operation.json', (value: JsonRecord) => { value.targetId = invalidId; }],
    ['Sync', 'syncPush', 'sync-push.json', (value: JsonRecord) => { value.sessionId = invalidId; }],
    ['Feed event', 'feed', 'public-feed.json', (value: JsonRecord) => { value.events[0].id = invalidId; }],
  ] as const)('rejects an invalid ID in %s', (_label, definition, fixtureName, mutate) => {
    const value = fixture(fixtureName);
    mutate(value);
    expect(validators.validate(definition, value).valid).toBe(false);
  });

  it.each([
    ['nodeCreate', { kind: 'alias', title: 'Alias', targetNodeId: invalidId }],
    ['nodeMergePatch', { targetNodeId: invalidId }],
  ] as const)('rejects invalid IDs in the %s contract', (definition, value) => {
    expect(validators.validate(definition, value).valid).toBe(false);
  });

  it('stops a server request before semantics and dispatch', () => {
    const request = fixture('sync-push.json');
    request.operations[0].opId = invalidId;
    const semantics = vi.fn((_value: JsonRecord) => ({
      valid: true as const,
      issues: [] as const,
    }));
    const dispatch = vi.fn((_value: JsonRecord) => undefined);

    const result = validateServerWireDocument(
      validators,
      'syncPush',
      JSON.stringify(request),
      (value: JsonRecord) => {
        semantics(value);
        dispatch(value);
        return { valid: true as const, issues: [] as const };
      },
    );

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('makes the public client reject an invalid response ID structurally', async () => {
    const manifest = fixture('public-manifest.json');
    const snapshot = fixture('collection-snapshot.json');
    snapshot.snapshotId = invalidId;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === '/.well-known/collection-protocol') return Response.json(manifest);
      return Response.json(snapshot, { headers: { ETag: '"snapshot-1"' } });
    });
    const client = new ColpClient({
      manifestUrl,
      fetch: fetch as typeof globalThis.fetch,
    });

    const response = client.getSnapshot(collectionId);
    await expect(response).rejects.toThrow('Response does not satisfy snapshot');
    await expect(response).rejects.not.toThrow('semantic validation failed');
  });

  it('rejects client route IDs before template expansion and resource fetch', async () => {
    const manifest = fixture('public-manifest.json');
    const fetch = vi.fn(async (_input: string | URL | Request) => Response.json(manifest));
    const client = new ColpClient({ manifestUrl, fetch: fetch as typeof globalThis.fetch });

    await expect(client.getSnapshot('collection/escape')).rejects.toThrow(
      'Endpoint variable collectionId must be a 1-128 character URI-unreserved ASCII wire ID.',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(manifestUrl);
  });

  it('validates decoded server route variables before dispatch', () => {
    const dispatch = vi.fn();
    const result = validateServerEndpointVariables(
      'node',
      { collectionId: 'collection-1', nodeId: 'decoded/slash' },
      validators,
    );
    if (result.valid) dispatch(result.value);

    expect(result).toEqual({
      valid: false,
      code: 'invalid_path_variables',
      errors: ['Endpoint variable nodeId must be a 1-128 character URI-unreserved ASCII wire ID.'],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
