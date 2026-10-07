import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  areUrlHashDeduplicationCandidates,
  compareUrlHashCandidateIdentity,
  createUrlHash,
  evaluateUrlHashDeduplication,
  validateBookmarkUrlHashSemantics,
  validateNodeMergePatchUrlHashSemantics,
} from '../../src/semantic/index.js';
import {
  collectionProtocolSchema,
  createValidatorRegistry,
  type DefinitionName,
  validateWireDocument,
} from '../../src/schema/index.js';
import { UuidV7Generator } from '../../src/server/index.js';

const evidence = '[evidence:core.url-hash-never-object-id]';
const expectedExpandedMustNotCases = 21;
const timestamp = '2026-07-17T00:00:00Z';
const url = 'https://example.test/saved';
const urlHash = createUrlHash(url);
const validators = createValidatorRegistry();
const thisTestPath = resolve(import.meta.dirname, 'url-hash-never-object-id-contract.test.ts');

type JsonRecord = Record<string, any>;

interface BookmarkDecisionRecord extends JsonRecord {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly url: string;
  readonly urlHash: string;
}

interface MustNotCase {
  readonly label: string;
  readonly definition: DefinitionName;
  readonly validValue: unknown;
  readonly invalidValue: unknown;
  readonly invalidPath: string;
}

function bookmarkNode(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'node-bookmark',
    collectionId: 'collection-main',
    kind: 'bookmark',
    parentId: 'node-root',
    position: 'a',
    title: 'Saved page',
    url,
    urlHash,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'revision-node',
    ...overrides,
  };
}

function aliasNode(overrides: JsonRecord = {}): JsonRecord {
  return {
    id: 'node-alias',
    collectionId: 'collection-main',
    kind: 'alias',
    parentId: 'node-root',
    position: 'b',
    title: 'Alias',
    targetNodeId: 'node-bookmark',
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 'revision-alias',
    ...overrides,
  };
}

const collection = {
  schemaVersion: '0.1',
  id: 'collection-main',
  kind: 'bookmarks',
  title: 'Saved pages',
  rootNodeId: 'node-root',
  visibility: 'private',
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 'revision-collection',
};

const relation = {
  id: 'relation-related',
  collectionId: 'collection-main',
  type: 'related',
  fromNodeId: 'node-bookmark',
  toNodeId: 'node-other',
  visibility: 'private',
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 'revision-relation',
};

const operation = {
  opId: 'operation-update-node',
  replicaId: 'replica-main',
  sequence: 2,
  collectionId: 'collection-main',
  type: 'update_node_content',
  targetId: 'node-bookmark',
  baseRevision: 'revision-node',
  occurredAt: timestamp,
  dependencies: ['operation-prior'],
  payload: {
    base: { title: 'Before' },
    value: { title: 'After' },
  },
};

const feedEvent = {
  specversion: '1.0',
  id: 'event-created',
  source: 'https://example.test/collections',
  type: 'com.know-n.colp.collection.created.v1',
  subject: 'collections/collection-main',
  time: timestamp,
  datacontenttype: 'application/json',
  collectionprotocolversion: '0.1',
  data: { collectionId: 'collection-main', revision: 'revision-collection' },
};

const tombstone = {
  resourceType: 'node',
  targetId: 'node-deleted',
  collectionId: 'collection-main',
  scope: 'single',
  deletedAt: timestamp,
  deleteRevision: 'revision-delete',
  operationId: 'operation-delete',
  deleteCursor: 'cursor-delete',
  affectedCount: 1,
  purgeAfter: '2026-08-17T00:00:00Z',
};

const createRequest = {
  parentId: 'node-root',
  afterId: 'node-before',
  beforeId: 'node-after',
  node: { kind: 'bookmark', title: 'New page', url, urlHash },
};

const globalIdentity = {
  serverUuid: 'server-main',
  resourceType: 'node',
  id: 'node-bookmark',
} as const;

function replace(value: unknown, path: readonly (string | number)[]): unknown {
  if (path.length === 0) return urlHash;
  const copy = structuredClone(value) as JsonRecord;
  let target: JsonRecord = copy;
  for (const segment of path.slice(0, -1)) target = target[segment] as JsonRecord;
  target[path.at(-1)!] = urlHash;
  return copy;
}

function mustNotCase(
  label: string,
  definition: DefinitionName,
  validValue: unknown,
  path: readonly (string | number)[],
  invalidPath: string,
): MustNotCase {
  return { label, definition, validValue, invalidValue: replace(validValue, path), invalidPath };
}

const mustNotCases: readonly MustNotCase[] = [
  mustNotCase('opaqueId value', 'opaqueId', 'node-bookmark', [], ''),
  mustNotCase('Node id', 'node', bookmarkNode(), ['id'], '/id'),
  mustNotCase('Node collectionId', 'node', bookmarkNode(), ['collectionId'], '/collectionId'),
  mustNotCase('Node parentId reference', 'node', bookmarkNode(), ['parentId'], '/parentId'),
  mustNotCase('Node targetNodeId reference', 'node', aliasNode(), ['targetNodeId'], '/targetNodeId'),
  mustNotCase('Collection id', 'collection', collection, ['id'], '/id'),
  mustNotCase('Collection rootNodeId reference', 'collection', collection, ['rootNodeId'], '/rootNodeId'),
  mustNotCase('Relation id', 'relation', relation, ['id'], '/id'),
  mustNotCase('Relation fromNodeId reference', 'relation', relation, ['fromNodeId'], '/fromNodeId'),
  mustNotCase('Relation toNodeId reference', 'relation', relation, ['toNodeId'], '/toNodeId'),
  mustNotCase('Operation opId', 'operation', operation, ['opId'], '/opId'),
  mustNotCase('Operation targetId', 'operation', operation, ['targetId'], '/targetId'),
  mustNotCase('Operation dependency ID', 'operation', operation, ['dependencies', 0], '/dependencies/0'),
  mustNotCase('Feed Event id', 'feedEvent', feedEvent, ['id'], '/id'),
  mustNotCase('Sync Tombstone targetId', 'syncTombstone', tombstone, ['targetId'], '/targetId'),
  mustNotCase('Sync Tombstone operationId', 'syncTombstone', tombstone, ['operationId'], '/operationId'),
  mustNotCase('Node create parentId', 'nodeCreateRequest', createRequest, ['parentId'], '/parentId'),
  mustNotCase('Node create afterId', 'nodeCreateRequest', createRequest, ['afterId'], '/afterId'),
  mustNotCase('Node create beforeId', 'nodeCreateRequest', createRequest, ['beforeId'], '/beforeId'),
  mustNotCase('global identity serverUuid', 'globalResourceIdentity', globalIdentity, ['serverUuid'], '/serverUuid'),
  mustNotCase('global identity id', 'globalResourceIdentity', globalIdentity, ['id'], '/id'),
];

describe(`CORE-0044 URL hash MUST NOT become any object ID ${evidence}`, () => {
  it.each(mustNotCases)(
    'MUST_NOT write or substitute urlHash into $label',
    ({ definition, validValue, invalidValue, invalidPath }) => {
      expect(validators.validate(definition, validValue)).toEqual({ valid: true, errors: [] });

      const result = validators.validate(definition, invalidValue);

      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ instancePath: invalidPath })]),
      );
    },
  );

  it('keeps independent Node IDs and references unchanged when a valid urlHash is present', () => {
    const node = bookmarkNode();
    const before = structuredClone(node);

    expect(validators.validate('node', node)).toEqual({ valid: true, errors: [] });
    expect(validateBookmarkUrlHashSemantics(node)).toEqual({ valid: true, issues: [] });
    expect(node).toEqual(before);
    expect(node).toMatchObject({
      id: 'node-bookmark',
      collectionId: 'collection-main',
      parentId: 'node-root',
      urlHash,
    });
    expect(node.id).not.toBe(urlHash);
    expect(node.collectionId).not.toBe(urlHash);
    expect(node.parentId).not.toBe(urlHash);
  });

  it('binds every canonical opaque object-ID carrier to the hash-disjoint opaqueId contract', () => {
    const opaqueIdReferencePaths: string[] = [];
    const walk = (value: unknown, path: readonly string[]): void => {
      if (typeof value !== 'object' || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.$ref === '#/$defs/opaqueId') opaqueIdReferencePaths.push(path.join('/'));
      for (const [key, child] of Object.entries(record)) {
        if (Array.isArray(child)) {
          child.forEach((item, index) => walk(item, [...path, key, String(index)]));
        } else {
          walk(child, [...path, key]);
        }
      }
    };

    walk(collectionProtocolSchema.$defs, ['$defs']);

    // External/native/principal/JSON-RPC identifiers have separate contracts; all protocol
    // object IDs and references transitively use one of these audited opaqueId references.
    // CORE-0027's closed Snapshot-only Node projection repeats nine opaque ID carriers.
    expect(opaqueIdReferencePaths).toHaveLength(200);
    expect(opaqueIdReferencePaths).toEqual(expect.arrayContaining([
      '$defs/globalResourceIdentity/properties/serverUuid',
      '$defs/globalResourceIdentity/properties/id',
      '$defs/collection/properties/id',
      '$defs/collection/properties/rootNodeId',
      '$defs/node/properties/id',
      '$defs/node/properties/collectionId',
      '$defs/node/properties/targetNodeId',
      '$defs/operation/properties/opId',
      '$defs/operation/properties/targetId',
      '$defs/feedEvent/properties/id',
    ]));
    expect(validators.validate('opaqueId', urlHash).valid).toBe(false);
  });

  it('rejects a hash-shaped object ID structurally before semantic validation can run', () => {
    const semantics = vi.fn(() => ({ valid: true as const, issues: [] as const }));
    const invalid = bookmarkNode({ id: urlHash });

    const result = validateWireDocument(validators, 'node', invalid, semantics);

    expect(result).toMatchObject({ valid: false, stage: 'structural' });
    expect(semantics).not.toHaveBeenCalled();
  });

  it('preserves independently assigned IDs through valid URL-hash merge patches', () => {
    const current = bookmarkNode();
    const before = structuredClone(current);
    const changedUrl = 'https://example.test/changed';
    const patch = { url: changedUrl, urlHash: createUrlHash(changedUrl) };

    expect(validators.validate('nodeMergePatch', patch)).toEqual({ valid: true, errors: [] });
    expect(validateNodeMergePatchUrlHashSemantics(current as any, patch)).toEqual({
      valid: true,
      issues: [],
    });
    expect(current).toEqual(before);
    expect(current).toMatchObject({
      id: 'node-bookmark',
      collectionId: 'collection-main',
      parentId: 'node-root',
    });
  });

  it('keeps UUIDv7 allocation independent of nearby URL-hash values', () => {
    const options = {
      clock: { now: () => new Date(1_721_234_567_890) },
      randomBytes: (length: number) => new Uint8Array(length).fill(0x5a),
    } as const;
    const first = new UuidV7Generator(options);
    const second = new UuidV7Generator(options);

    const idNearFirstHash = first.uuidV7();
    const firstHash = createUrlHash('https://first.example.test/');
    const secondHash = createUrlHash('https://second.example.test/');
    const idNearSecondHash = second.uuidV7();

    expect(firstHash).not.toBe(secondHash);
    expect(idNearFirstHash).toBe(idNearSecondHash);
    expect(idNearFirstHash).not.toBe(firstHash);
    expect(idNearFirstHash).not.toBe(secondHash);
    expect(validators.validate('opaqueId', idNearFirstHash)).toEqual({ valid: true, errors: [] });
  });

  it('returns only candidate/semantic decisions and preserves independently assigned IDs', () => {
    const left = bookmarkNode() as BookmarkDecisionRecord;
    const right = bookmarkNode({ id: 'node-independent' }) as BookmarkDecisionRecord;
    const before = structuredClone({ left, right });

    const candidate = areUrlHashDeduplicationCandidates(left.urlHash, right.urlHash);
    const deduplication = evaluateUrlHashDeduplication(left, right, {
      contentMatches: (a, b) => a.title === b.title,
      collectionMatches: (a, b) => a.collectionId === b.collectionId,
    });
    const identity = compareUrlHashCandidateIdentity(left.urlHash, right.urlHash,
      globalIdentity, { ...globalIdentity, id: right.id });
    const semantic = validateBookmarkUrlHashSemantics(left);

    expect(candidate).toBe(true);
    expect(typeof candidate).toBe('boolean');
    expect(deduplication).toEqual({ hashCandidate: true, semanticMatch: true, reason: 'semantic_match' });
    expect(identity).toEqual({ hashCandidate: true, sameObject: false });
    expect(semantic).toEqual({ valid: true, issues: [] });
    expect(deduplication).not.toHaveProperty('id');
    expect(identity).not.toHaveProperty('id');
    expect(semantic).not.toHaveProperty('id');
    expect(semantic).not.toHaveProperty('targetId');
    expect(semantic).not.toHaveProperty('write');
    expect({ left, right }).toEqual(before);
  });

  it('statically declares one evidence marker and the full expanded MUST_NOT count', () => {
    const source = readFileSync(thisTestPath, 'utf8');

    expect(source.match(/\[evidence:core\.url-hash-never-object-id\]/gu)).toHaveLength(1);
    expect(source).toContain('const expectedExpandedMustNotCases = 21;');
    expect(mustNotCases).toHaveLength(expectedExpandedMustNotCases);
  });
});
