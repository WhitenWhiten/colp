import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { endpointContracts } from '../../src/semantic/endpoint-contracts.js';
import {
  collectionProtocolSchema,
  createAjv,
  createValidatorRegistry,
  type DefinitionName,
  validateWireDocument,
  validateWireJsonDocument,
} from '../../src/schema/index.js';

const evidence = '[evidence:core.exact-version-unknown-top-level]';
const fixturesRoot = resolve(import.meta.dirname, '..', '..', 'fixtures', 'protocol', 'examples');
const validators = createValidatorRegistry();

type JsonObject = Record<string, any>;
type DirectCase = Readonly<{ label: string; definition: DefinitionName; value: () => JsonObject }>;

function fixture(name: string): JsonObject {
  return JSON.parse(readFileSync(resolve(fixturesRoot, name), 'utf8')) as JsonObject;
}

function fixtureAt(name: string, ...path: Array<string | number>): () => JsonObject {
  return () => path.reduce<any>((value, segment) => value[segment], fixture(name)) as JsonObject;
}

function literal(value: JsonObject): () => JsonObject {
  return () => structuredClone(value);
}

const timestamp = '2026-07-16T07:00:00Z';
const nodeBase = {
  collectionId: 'collection-1', createdAt: timestamp, updatedAt: timestamp, revision: 'revision-1',
};

const directCases: readonly DirectCase[] = [
  // Core resources and every Node discriminant.
  { label: 'Collection', definition: 'collection', value: fixtureAt('collection-snapshot.json', 'collection') },
  { label: 'Annotation', definition: 'annotation', value: fixtureAt('collection-snapshot.json', 'annotations', 0) },
  { label: 'Attachment', definition: 'attachment', value: literal({ id: 'attachment-1', collectionId: 'collection-1', subject: { type: 'node', id: 'bookmark-1' }, rel: 'alternate', url: 'https://example.com/a', visibility: 'public', createdAt: timestamp, updatedAt: timestamp, revision: 'r-1' }) },
  { label: 'Relation', definition: 'relation', value: literal({ id: 'relation-1', collectionId: 'collection-1', type: 'related', fromNodeId: 'root-1', toNodeId: 'bookmark-1', visibility: 'public', createdAt: timestamp, updatedAt: timestamp, revision: 'r-1' }) },
  { label: 'root Node', definition: 'node', value: literal({ ...nodeBase, id: 'root-1', kind: 'root', parentId: null, position: null, folderRole: 'root', title: 'Root' }) },
  { label: 'folder Node', definition: 'node', value: literal({ ...nodeBase, id: 'folder-1', kind: 'folder', parentId: 'root-1', position: 'a', title: 'Folder' }) },
  { label: 'bookmark Node', definition: 'node', value: fixtureAt('local-bookmark-node.json') },
  { label: 'separator Node', definition: 'node', value: literal({ ...nodeBase, id: 'separator-1', kind: 'separator', parentId: 'root-1', position: 'b' }) },
  { label: 'alias Node', definition: 'node', value: literal({ ...nodeBase, id: 'alias-1', kind: 'alias', parentId: 'root-1', position: 'c', title: 'Alias', targetNodeId: 'bookmark-1' }) },

  // Create/update/move and JSON Merge Patch DTOs.
  { label: 'Collection create', definition: 'collectionCreate', value: fixtureAt('publisher-collection-create.json', 'collection') },
  { label: 'root create', definition: 'rootCreate', value: fixtureAt('publisher-collection-create.json', 'root') },
  { label: 'Collection create request', definition: 'collectionCreateRequest', value: fixtureAt('publisher-collection-create.json') },
  { label: 'folder create', definition: 'nodeCreate', value: literal({ kind: 'folder', title: 'Folder' }) },
  { label: 'bookmark create', definition: 'nodeCreate', value: literal({ kind: 'bookmark', title: 'Bookmark', url: 'https://example.com/' }) },
  { label: 'separator create', definition: 'nodeCreate', value: literal({ kind: 'separator' }) },
  { label: 'alias create', definition: 'nodeCreate', value: literal({ kind: 'alias', title: 'Alias', targetNodeId: 'bookmark-1' }) },
  { label: 'Node create request', definition: 'nodeCreateRequest', value: literal({ parentId: 'root-1', node: { kind: 'folder', title: 'Folder' } }) },
  { label: 'Node move request', definition: 'nodeMoveRequest', value: fixtureAt('publisher-node-move.json') },
  { label: 'Annotation create', definition: 'annotationCreate', value: fixtureAt('publisher-annotation-create.json') },
  { label: 'Attachment create', definition: 'attachmentCreate', value: literal({ subject: { type: 'node', id: 'bookmark-1' }, rel: 'alternate', url: 'https://example.com/a', visibility: 'public' }) },
  { label: 'Relation create', definition: 'relationCreate', value: literal({ type: 'related', fromNodeId: 'root-1', toNodeId: 'bookmark-1', visibility: 'public' }) },
  { label: 'Collection merge patch', definition: 'collectionMergePatch', value: literal({ title: 'Updated' }) },
  { label: 'Node merge patch', definition: 'nodeMergePatch', value: literal({ title: 'Updated' }) },
  { label: 'Annotation merge patch', definition: 'annotationMergePatch', value: literal({ visibility: 'private' }) },
  { label: 'Attachment merge patch', definition: 'attachmentMergePatch', value: literal({ title: null }) },
  { label: 'Relation merge patch', definition: 'relationMergePatch', value: literal({ label: null }) },

  // Operations, operation payloads, results, and publication wrappers.
  { label: 'Operation', definition: 'operation', value: fixtureAt('sync-update-operation.json') },
  { label: 'operation payload', definition: 'nodeContentUpdateOperationPayload', value: fixtureAt('sync-update-operation.json', 'payload') },
  { label: 'create Collection operation payload', definition: 'createCollectionOperationPayload', value: fixtureAt('publisher-collection-create.json') },
  { label: 'create Node operation payload', definition: 'createNodeOperationPayload', value: literal({ parentId: 'root-1', node: { kind: 'folder', title: 'Folder' } }) },
  { label: 'move operation payload', definition: 'moveOperationPayload', value: fixtureAt('publisher-node-move.json') },
  { label: 'reorder operation payload', definition: 'reorderOperationPayload', value: literal({ parentId: 'root-1', childIds: ['node-1'], baseChildrenRevision: 'revision-1' }) },
  { label: 'Collection metadata update operation payload', definition: 'collectionMetadataUpdateOperationPayload', value: literal({ base: { title: 'Old' }, value: { title: 'New' } }) },
  { label: 'delete operation payload', definition: 'deleteOperationPayload', value: literal({ reason: 'Removed' }) },
  { label: 'restore operation payload', definition: 'restoreOperationPayload', value: literal({ reason: 'Restored' }) },
  { label: 'create Annotation operation payload', definition: 'createAnnotationOperationPayload', value: () => ({ annotation: fixture('publisher-annotation-create.json') }) },
  { label: 'Annotation update operation payload', definition: 'annotationUpdateOperationPayload', value: literal({ base: { visibility: 'private' }, value: { visibility: 'public' } }) },
  { label: 'create Attachment operation payload', definition: 'createAttachmentOperationPayload', value: literal({ attachment: { subject: { type: 'node', id: 'bookmark-1' }, rel: 'alternate', url: 'https://example.com/a', visibility: 'public' } }) },
  { label: 'Attachment update operation payload', definition: 'attachmentUpdateOperationPayload', value: literal({ base: { title: 'Old' }, value: { title: 'New' } }) },
  { label: 'create Relation operation payload', definition: 'createRelationOperationPayload', value: literal({ relation: { type: 'related', fromNodeId: 'root-1', toNodeId: 'bookmark-1', visibility: 'public' } }) },
  { label: 'Relation update operation payload', definition: 'relationUpdateOperationPayload', value: literal({ base: { label: 'Old' }, value: { label: 'New' } }) },
  { label: 'Operation result', definition: 'operationResult', value: fixtureAt('sync-push-result.json', 'results', 0) },
  { label: 'Snapshot', definition: 'snapshot', value: fixtureAt('collection-snapshot.json') },
  { label: 'Snapshot page', definition: 'snapshotPage', value: fixtureAt('collection-snapshot.json', 'page') },
  { label: 'Collection directory', definition: 'collectionDirectory', value: fixtureAt('collection-directory.json') },
  { label: 'directory Collection', definition: 'directoryCollection', value: fixtureAt('collection-directory.json', 'collections', 0) },
  { label: 'Collection metadata', definition: 'collectionMetadata', value: fixtureAt('collection-metadata.json') },
  { label: 'Node detail', definition: 'nodeDetail', value: fixtureAt('node-detail.json') },
  { label: 'Node included wrapper', definition: 'nodeIncluded', value: fixtureAt('node-detail.json', 'included') },
  { label: 'Collection create result', definition: 'collectionCreateResult', value: fixtureAt('publisher-collection-create-result.json') },
  { label: 'Node move result', definition: 'nodeMoveResult', value: () => ({ node: fixture('local-bookmark-node.json'), sourceParentRevision: 'revision-1', targetParentRevision: 'revision-2', position: 'a', warnings: [] }) },
  { label: 'Delete result', definition: 'deleteResult', value: literal({ receipt: { resourceType: 'node', targetId: 'node-1', collectionId: 'collection-1', scope: 'single', deletedAt: timestamp, deleteRevision: 'revision-1', operationId: 'operation-1', affectedCount: 1, purgeAfter: timestamp } }) },
  { label: 'release create', definition: 'releaseCreate', value: literal({ title: 'Release' }) },
  { label: 'Release result', definition: 'releaseResult', value: fixtureAt('release-result.json') },
  { label: 'Release directory', definition: 'releaseDirectory', value: fixtureAt('release-directory.json') },
  { label: 'Problem', definition: 'problem', value: fixtureAt('problem.json') },

  // Manifest, Feed/CloudEvent, and their nested protocol objects.
  { label: 'Manifest', definition: 'manifest', value: fixtureAt('public-manifest.json') },
  { label: 'Manifest mount', definition: 'manifestMount', value: fixtureAt('public-manifest.json', 'mounts', 0) },
  { label: 'Manifest endpoints', definition: 'manifestEndpoints', value: fixtureAt('public-manifest.json', 'mounts', 0, 'endpoints') },
  { label: 'Manifest features', definition: 'manifestFeatures', value: fixtureAt('public-manifest.json', 'mounts', 0, 'features') },
  { label: 'Manifest auth', definition: 'manifestAuth', value: fixtureAt('public-manifest.json', 'mounts', 0, 'auth') },
  { label: 'Manifest limits', definition: 'manifestLimits', value: fixtureAt('public-manifest.json', 'mounts', 0, 'limits') },
  { label: 'Manifest signing', definition: 'manifestSigning', value: fixtureAt('public-manifest.json', 'signing') },
  { label: 'Feed', definition: 'feed', value: fixtureAt('public-feed.json') },
  { label: 'CloudEvent', definition: 'feedEvent', value: fixtureAt('public-feed.json', 'events', 0) },
  { label: 'Feed event data', definition: 'releasePublishedFeedEventData', value: fixtureAt('public-feed.json', 'events', 0, 'data') },
  { label: 'Feed change counts', definition: 'changeCounts', value: fixtureAt('public-feed.json', 'events', 0, 'data', 'changes') },
  { label: 'Feed poll hint', definition: 'pollHint', value: fixtureAt('public-feed.json', 'poll') },
  { label: 'MCP tools list', definition: 'mcpToolsList', value: fixtureAt('mcp-tools-list.json') },
  { label: 'MCP tool', definition: 'mcpTool', value: fixtureAt('mcp-tools-list.json', 'result', 'tools', 0) },

  // Sync wrappers, branches, nested state, conflicts, and acknowledgements.
  { label: 'Collection sync session request', definition: 'syncSessionRequest', value: fixtureAt('sync-session-request.json') },
  { label: 'Replica', definition: 'replica', value: fixtureAt('sync-session-request.json', 'replica') },
  { label: 'Replica adapter', definition: 'replicaAdapter', value: fixtureAt('sync-session-request.json', 'replica', 'adapter') },
  { label: 'Replica capabilities', definition: 'replicaCapabilities', value: fixtureAt('sync-session-request.json', 'replica', 'capabilities') },
  { label: 'Replica binding', definition: 'replicaBinding', value: fixtureAt('sync-session-request.json', 'replica', 'binding') },
  { label: 'Collection sync session result', definition: 'syncSessionResult', value: fixtureAt('sync-session-result.json') },
  { label: 'Replica lease', definition: 'replicaLease', value: fixtureAt('sync-session-result.json', 'replicaLease') },
  { label: 'Conversion policy', definition: 'conversionPolicy', value: fixtureAt('sync-session-result.json', 'conversionPolicy') },
  { label: 'Sync push', definition: 'syncPush', value: fixtureAt('sync-push.json') },
  { label: 'Sync push result', definition: 'syncPushResult', value: fixtureAt('sync-push-result.json') },
  { label: 'Sync pull', definition: 'syncPull', value: fixtureAt('sync-pull.json') },
  { label: 'Sync pull event', definition: 'syncPullEvent', value: fixtureAt('sync-pull.json', 'events', 0) },
  { label: 'Conflict', definition: 'conflict', value: fixtureAt('sync-pull.json', 'events', 0, 'conflict') },
  { label: 'Sync ack request', definition: 'syncAckRequest', value: literal({ sessionId: 'session-1', cursor: 'cursor-1', warnings: [] }) },
  { label: 'Sync ack result', definition: 'syncAckResult', value: literal({ replicaId: 'replica-1', ackedCursor: 'cursor-1', ackedAt: timestamp }) },
  { label: 'Conflict resolution request', definition: 'conflictResolutionRequest', value: literal({ resolution: 'server', baseConflictRevision: 'revision-1' }) },
  { label: 'Conflict resolution result', definition: 'conflictResolutionResult', value: () => ({ conflict: fixture('sync-pull.json').events[0].conflict, operation: fixture('sync-update-operation.json'), cursor: 'cursor-1' }) },

  // Access, key, rate-limit, and planning DTOs.
  { label: 'Access policy', definition: 'accessPolicy', value: fixtureAt('access-policy.json') },
  { label: 'Access entry', definition: 'accessEntry', value: fixtureAt('access-policy.json', 'entries', 0) },
  { label: 'Principal reference', definition: 'principalRef', value: fixtureAt('access-policy.json', 'entries', 0, 'principal') },
  { label: 'Access publication policy', definition: 'accessPublicationPolicy', value: fixtureAt('access-policy.json', 'publication') },
  { label: 'Access policy patch', definition: 'accessPolicyPatch', value: literal({ visibility: 'private' }) },
  { label: 'API key metadata', definition: 'apiKeyMetadata', value: literal({ id: 'key-1', name: 'Reader', type: 'read_key', scopes: ['collections:read'], collections: [], createdAt: timestamp, expiresAt: null, lastUsedAt: null, lastUsedIp: null, status: 'active' }) },
  { label: 'API key create request', definition: 'apiKeyCreateRequest', value: literal({ name: 'Reader', type: 'read_key', scopes: ['collections:read'], collections: [], expiresAt: null }) },
  { label: 'API key create result', definition: 'apiKeyCreateResult', value: literal({ key: { id: 'key-1', name: 'Reader', type: 'read_key', scopes: ['collections:read'], collections: [], createdAt: timestamp, expiresAt: null, lastUsedAt: null, lastUsedIp: null, status: 'active' }, secret: 'secret-value-1234' }) },
  { label: 'API key rotate result', definition: 'apiKeyRotateResult', value: literal({ key: { id: 'key-1', name: 'Reader', type: 'read_key', scopes: ['collections:read'], collections: [], createdAt: timestamp, expiresAt: null, lastUsedAt: null, lastUsedIp: null, status: 'active' }, secret: 'rotated-secret-12' }) },
  { label: 'API key rotate request', definition: 'apiKeyRotateRequest', value: literal({ overlapSeconds: 60 }) },
  { label: 'API key revoke result', definition: 'apiKeyRevokeResult', value: literal({ key: { id: 'key-1', name: 'Reader', type: 'read_key', scopes: ['collections:read'], collections: [], createdAt: timestamp, expiresAt: null, lastUsedAt: null, lastUsedIp: null, status: 'revoked' }, revokedAt: timestamp }) },
  { label: 'API key directory', definition: 'apiKeyDirectory', value: literal({ keys: [], nextCursor: null }) },
  { label: 'Rate-limit scope', definition: 'rateLimitScope', value: literal({ endpointClass: 'read' }) },
  { label: 'Rate-limit policy', definition: 'rateLimitPolicy', value: literal({ id: 'principal-1', scope: { endpointClass: 'read' }, limit: 100, windowSeconds: 60, burst: 10, concurrency: 4, minIntervalMilliseconds: 0, action: 'reject', revision: 'revision-1' }) },
  { label: 'Rate-limit patch', definition: 'rateLimitPolicyPatch', value: literal({ limit: 50 }) },
  { label: 'Rate-limit update request', definition: 'rateLimitPolicyUpdateRequest', value: literal({ id: 'principal-1', patch: { limit: 50 } }) },
  { label: 'Rate-limit directory', definition: 'rateLimitDirectory', value: literal({ policies: [] }) },
  { label: 'Audit directory', definition: 'auditDirectory', value: literal({ events: [], nextCursor: null }) },
  { label: 'Change plan request', definition: 'changePlanRequest', value: fixtureAt('change-plan-request.json') },
  { label: 'Change plan', definition: 'changePlan', value: fixtureAt('change-plan.json') },
  { label: 'Change plan impact', definition: 'changePlanImpact', value: fixtureAt('change-plan.json', 'impact') },

  // Endpoint Registry query DTOs, including required Sync query branches.
  ...(['cursorPageQuery', 'auditQuery', 'directoryQuery', 'snapshotQuery', 'nodeDetailQuery', 'nodeDeleteQuery', 'feedQuery'] as const)
    .map((definition) => ({ label: `${definition} endpoint query`, definition, value: literal({}) })),
  { label: 'Sync pull query', definition: 'syncPullQuery', value: literal({ sessionId: 'session-1', cursor: 'cursor-1' }) },
  { label: 'Sync Snapshot query', definition: 'syncSnapshotQuery', value: literal({ sessionId: 'session-1' }) },
] as const;

const unknownFields = [
  ['futureCoreField', true],
  ['protocolversion', null],
  ['ProtocolVersion', { nested: ['complex', 1] }],
  ['protocolVersion ', []],
  ['protocolVersio\u043d', false], // Cyrillic small en, visually close to ASCII n.
  ['extensions2', { 'https://example.com/ns': 'not an extension container' }],
  ['__proto__', { polluted: true }],
] as const;

const reviewedOpenObjects = {
  '#/$defs/extensions': 'namespace-keyed opaque extension values',
  '#/$defs/operationResult/properties/transform': 'server-defined transform payload',
  '#/$defs/auditEvent/properties/metadata': 'opaque audit metadata',
  '#/$defs/mcpTool/properties/inputSchema': 'embedded JSON Schema',
  '#/$defs/mcpTool/properties/outputSchema': 'embedded JSON Schema',
  '#/$defs/mcpTool/properties/_meta': 'opaque MCP metadata',
  '#/$defs/problem/properties/links': 'relation-keyed HTTP link map',
  '#/$defs/changePlan/properties/baseRevisions': 'resource-keyed revision map',
  '#/$defs/operation/properties/payload': 'closed by exhaustive operation discriminants',
  '#/$defs/feedEvent/properties/data': 'closed by exhaustive core event discriminants',
  '#/$defs/syncCollectionPush/properties/operations/not/contains': 'negative applicator only',
  '#/$defs/syncInstanceCreatePush/properties/operations/items/allOf/1': 'allOf refinement only',
  '#/$defs/activeReplicaLease/allOf/1': 'allOf refinement only',
} as const;

function expectAdditionalProperty(result: ReturnType<typeof validators.validate>, field: string, path = ''): void {
  expect(result.valid).toBe(false);
  if (result.valid) return;
  expect(result.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ instancePath: path, keyword: 'additionalProperties', params: { additionalProperty: field } }),
  ]));
}

describe(`CORE-0031 exact-version unknown top-level fields ${evidence}`, () => {
  it('audits the whole canonical schema and documents every intentional open payload or keyed-map exception', () => {
    const open: string[] = [];
    const closed: string[] = [];
    const schema = collectionProtocolSchema as any;

    function visit(value: unknown, path: string): void {
      if (value === null || typeof value !== 'object') return;
      const candidate = value as Record<string, unknown>;
      if (candidate.type === 'object') {
        (candidate.additionalProperties === false ? closed : open).push(path);
      }
      for (const [key, child] of Object.entries(candidate)) visit(child, `${path}/${key}`);
    }
    for (const [name, definition] of Object.entries(schema.$defs)) visit(definition, `#/$defs/${name}`);

    expect(Object.keys(schema.$defs)).toHaveLength(191);
    expect(closed).toHaveLength(169);
    expect(open).toHaveLength(13);
    expect(open.sort()).toEqual(Object.keys(reviewedOpenObjects).sort());
    expect(Object.keys(reviewedOpenObjects)).not.toContain('#/$defs/extensions/additionalProperties');
  });

  it('keeps every Endpoint Registry object request, response, and query represented by the direct matrix', () => {
    const represented = new Set<DefinitionName>(directCases.map(({ definition }) => definition));
    const registryObjects = Object.values(endpointContracts).flatMap(({ operations }) =>
      operations.flatMap((operation) => [
        'query' in operation ? operation.query : undefined,
        'request' in operation ? operation.request : undefined,
        'response' in operation ? operation.response : undefined,
      ]),
    ).filter((name): name is NonNullable<typeof name> => name !== undefined)
      .filter((name) => (collectionProtocolSchema as any).$defs[name]?.type === 'object'
        || (collectionProtocolSchema as any).$defs[name]?.$ref !== undefined
        || (collectionProtocolSchema as any).$defs[name]?.oneOf !== undefined);
    const uniqueRegistryObjects = [...new Set(registryObjects)];
    expect(uniqueRegistryObjects).toHaveLength(57);
    expect(uniqueRegistryObjects.filter((name) => !represented.has(name))).toEqual([]);
  });

  it.each(directCases.flatMap((testCase) => unknownFields.map(([field, fieldValue]) => ({ ...testCase, field, fieldValue }))))(
    'rejects $field on $label by direct $definition validation',
    ({ definition, value, field, fieldValue }) => {
      const candidate = value();
      expect(validators.validate(definition, candidate)).toEqual({ valid: true, errors: [] });
      Object.defineProperty(candidate, field, { value: structuredClone(fieldValue), enumerable: true, configurable: true, writable: true });
      expect(Object.hasOwn(candidate, field)).toBe(true);
      expectAdditionalProperty(validators.validate(definition, candidate), field);
      expect(Object.hasOwn(candidate, field)).toBe(true);
    },
  );

  it.each([
    ['Snapshot root', 'snapshot', 'collection-snapshot.json', '', 'futureCoreField'],
    ['Snapshot Collection', 'snapshot', 'collection-snapshot.json', '/collection', 'futureCoreField'],
    ['Snapshot page', 'snapshot', 'collection-snapshot.json', '/page', 'protocolversion'],
    ['Manifest mount', 'manifest', 'public-manifest.json', '/mounts/0', 'ProtocolVersion'],
    ['CloudEvent', 'feed', 'public-feed.json', '/events/0', '__proto__'],
    ['CloudEvent data', 'feed', 'public-feed.json', '/events/0/data', 'extensions2'],
    ['Sync operation payload', 'syncPush', 'sync-push.json', '/operations/0/payload', 'protocolVersio\u043d'],
    ['Problem root', 'problem', 'problem.json', '', 'protocolVersion '],
  ] as const)('rejects nested/public wire case %s structurally with the exact path and never calls semantics', (_label, definition, file, pointer, field) => {
    const candidate = fixture(file);
    const target = pointer === '' ? candidate : pointer.slice(1).split('/').reduce<any>((value, segment) => value[Number.isNaN(Number(segment)) ? segment : Number(segment)], candidate);
    Object.defineProperty(target, field, { value: { complex: [null, true] }, enumerable: true });
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const result = validateWireDocument(validators, definition, candidate, semantics);
    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    if (result.valid || result.stage !== 'structural') return;
    expectAdditionalProperty({ valid: false, errors: result.errors }, field, pointer);
    expect(semantics).not.toHaveBeenCalled();
  });

  it('preserves an own __proto__ member through JSON parsing and rejects it before semantics', () => {
    const snapshot = fixture('collection-snapshot.json');
    const source = JSON.stringify(snapshot).replace(/^\{/u, '{"__proto__":{"polluted":true},');
    const candidate = JSON.parse(source) as JsonObject;
    expect(Object.hasOwn(candidate, '__proto__')).toBe(true);
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const result = validateWireDocument(validators, 'snapshot', candidate, semantics);
    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    if (result.valid || result.stage !== 'structural') return;
    expectAdditionalProperty({ valid: false, errors: result.errors }, '__proto__');
    expect(semantics).not.toHaveBeenCalled();
    expect(({} as any).polluted).toBeUndefined();

    const parsedWireResult = validateWireJsonDocument(validators, 'snapshot', source, semantics);
    expect(parsedWireResult).toMatchObject({ valid: false, stage: 'parse' });
    expect(semantics).not.toHaveBeenCalled();
  });

  it('does not remove, coerce, or otherwise normalize unknown fields for hostile caller AJV options', () => {
    const hostileAjv = createAjv({ removeAdditional: 'all', coerceTypes: true });
    const hardened = createValidatorRegistry(hostileAjv);
    const snapshot = fixture('collection-snapshot.json');
    snapshot.futureCoreField = '1';
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const result = validateWireDocument(hardened, 'snapshot', snapshot, semantics);
    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    if (result.valid || result.stage !== 'structural') return;
    expectAdditionalProperty({ valid: false, errors: result.errors }, 'futureCoreField');
    expect(snapshot.futureCoreField).toBe('1');
    expect(semantics).not.toHaveBeenCalled();
  });

});
