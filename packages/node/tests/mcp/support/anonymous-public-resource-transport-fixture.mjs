/**
 * Child-process fixture for the anonymous public Resource transport contract.
 *
 * It deliberately runs outside Vitest's module runner: the real server
 * projection is TypeScript that imports `@know-n/colp/*` from the server
 * package, and that install does not exist in the node-only CI job. The
 * `--import` register hook in `anonymous-public-resource-transport-register.mjs`
 * maps those packages to this checkout's sources, so the same invocation works
 * with no `packages/server/node_modules`.
 *
 * The composed path is the shipped one:
 *   real `createPhase4bMcpCollectionResourceProjection`
 *     -> the transport's schema validation
 *     -> real server `createPhase4bMcpResult`
 *     -> real `createMcp20260728Result`.
 *
 * `buildDynamicResourceResult` itself is private to
 * `transport/mcp/mcp-read-routes.ts`; its only body outside the real server
 * wrapper is the SDK schema check reproduced below. The wrapper is imported
 * directly from the real server module, so the non-enumerable
 * `callerScope: 'anonymous'` cache marker is exercised through the exact
 * assembly the route uses.
 */
import {
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
} from '../../../../server/src/modules/mcp/collection-resources.ts';
import { createPhase4bMcpResult } from '../../../../server/src/modules/mcp/results.ts';
import {
  createMcp20260728Result,
} from '@know-n/colp/mcp';
import { DEFAULT_MCP_RESOURCE_READ_BUDGET } from '../../../src/mcp/shared/resources.ts';
import {
  ListResourcesResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const ORIGIN = 'https://collections.example.test';
const AUDIENCE = `${ORIGIN}/collections/-/mcp`;
const COLLECTION_ID = 'public-collection';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const PUBLIC_READ_CACHE_TTL_MS = 60_000;

function mcpReadConfig() {
  const secret = Buffer.alloc(32, 43).toString('base64');
  return {
    enabled: true,
    endpointPath: '/collections/-/mcp',
    origin: ORIGIN,
    endpoint: AUDIENCE,
    serverUuid: SERVER_UUID,
    allowedOrigins: ['https://app.example.test'],
    oauth: {
      issuer: 'https://app.example.test/api/v1/auth',
      audience: AUDIENCE,
      authorizationServerMetadataUrl:
        'https://app.example.test/.well-known/oauth-authorization-server/api/v1/auth',
      jwksUri: 'https://app.example.test/api/v1/auth/jwks',
      scopes: ['mcp:read:public', 'mcp:read:own'],
      revocationStore: 'none',
    },
    budgets: {
      request: {
        maxBodyBytes: 65_536,
        maxHeaderCount: 64,
        maxHeaderNameBytes: 128,
        maxHeaderValueBytes: 4_096,
        maxConcurrent: 1,
        maxQueue: 2,
      },
      listen: { maxConnections: 16, maxQueueBytes: 262_144, maxDurationMs: 3_600_000 },
      output: { maxBytes: 1_048_576, maxItems: 10_000, maxDepth: 16 },
      strictIJson: { maxDepth: 16, maxMembers: 10_000 },
    },
    requestRateLimit: { maxRequests: 120, windowMs: 60_000 },
    collectionResources: {
      cursorKeys: { active: { id: 'anonymous-public-transport', secret }, retained: [] },
      cursorTtlMs: 60_000,
    },
    protocolVersion: '2026-07-28',
  };
}

function directoryRecord() {
  return Object.freeze({
    id: COLLECTION_ID,
    ownerSubjectId: 'subject-owner',
    title: 'Public Collection',
    summary: 'A public collection.',
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: COLLECTION_ID,
    tags: Object.freeze([]),
    language: null,
    nodeCount: 3,
    updatedAt: '2026-08-05T07:00:00.000Z',
    orderingUpdatedAtMicros: '3000000',
    protectedAuthorized: false,
  });
}

function metadataRecord() {
  return Object.freeze({
    id: COLLECTION_ID,
    ownerSubjectId: 'subject-owner',
    kind: 'bookmarks',
    title: 'Public Collection',
    summary: 'A public collection.',
    visibility: 'public',
    publicationSlug: COLLECTION_ID,
    rootNodeId: `${COLLECTION_ID}-root`,
    rootAvailable: true,
    contentRevision: 'content-1',
    policyRevision: 'policy-1',
    tags: Object.freeze([]),
    language: null,
    membershipRole: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-05T07:00:00.000Z',
    deletedAt: null,
  });
}

function createProjection() {
  const cursorKeys = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'anonymous-public-transport', secret: Buffer.alloc(32, 43).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const directory = directoryRecord();
  const metadata = metadataRecord();
  const projection = createPhase4bMcpCollectionResourceProjection({
    config: mcpReadConfig(),
    directoryQuery: {
      reads: {
        async loadPage() {
          return Object.freeze([directory]);
        },
      },
      cursors: {
        directory: {
          // One record with a two-item page limit never emits a next cursor.
          sign() {
            throw new Error('unexpected directory cursor sign');
          },
          verify() {
            return { valid: false };
          },
        },
      },
      origin: ORIGIN,
    },
    metadataQuery: {
      reads: {
        async load(input) {
          const key = input.collectionId ?? input.publicationSlug;
          return key === COLLECTION_ID ? metadata : null;
        },
      },
      origin: ORIGIN,
      now: () => NOW,
    },
    accessPolicy: {
      async loadCollectionFacts() {
        return null;
      },
    },
    cursorKeys,
    now: () => NOW,
    pageSize: 2,
    sharedExposure: Object.freeze({
      async listBlobFacts() {
        return [];
      },
    }),
  });
  return { projection, cursorKeys };
}

function anonymousContext() {
  return Object.freeze({
    binding: Object.freeze({
      kind: 'anonymous',
      principalId: 'public',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze([]),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
  });
}

function authenticatedContext() {
  return Object.freeze({
    binding: Object.freeze({
      kind: 'authenticated',
      principalId: 'subject-owner',
      clientId: 'client-owner',
      credentialBindingId: 'credential-owner',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    scope: Object.freeze(['mcp:read:own']),
    budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
    abortSignal: new AbortController().signal,
    authorization: Object.freeze({}),
  });
}

/** Mirrors the schema validation in `transport/mcp/mcp-read-routes.ts`. */
function buildDynamicResourceResult(method, fields, cache) {
  const schema = method === 'resources/list' ? ListResourcesResultSchema : ReadResourceResultSchema;
  if (!schema.safeParse(fields).success) {
    throw new TypeError('MCP Resource projection produced an invalid Modern result.');
  }
  return createPhase4bMcpResult({ method, fields, cache });
}

function cacheObservation(cache) {
  const descriptor = Object.getOwnPropertyDescriptor(cache, 'callerScope');
  return {
    cache: {
      ttlMs: cache.ttlMs,
      cacheScope: cache.cacheScope,
    },
    callerScope: descriptor?.value,
    callerScopeEnumerable: descriptor?.enumerable,
  };
}

function resultObservation(result, schema) {
  return {
    resultType: result.resultType,
    ttlMs: result.ttlMs,
    cacheScope: result.cacheScope,
    hasCallerScope: Object.hasOwn(result, 'callerScope'),
    schemaOk: schema.safeParse(result).success,
    wireHasCallerScope: Object.hasOwn(JSON.parse(JSON.stringify(result)), 'callerScope'),
  };
}

function captureTypeError(operation) {
  try {
    operation();
    return undefined;
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

async function main() {
  const { projection, cursorKeys } = createProjection();
  try {
    const anonymous = anonymousContext();
    const collectionResource = Object.freeze({
      kind: 'collection-metadata',
      collectionId: COLLECTION_ID,
    });

    const listCache = await projection.cacheForList({}, anonymous);
    const listed = await projection.listResources({}, anonymous);
    const listResult = buildDynamicResourceResult('resources/list', {
      resources: listed.resources.map((entry) => ({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
      })),
    }, listCache);

    const readCache = await projection.cacheForRead({ resource: collectionResource }, anonymous);
    const read = await projection.readResource({ resource: collectionResource }, anonymous);
    const readResult = buildDynamicResourceResult('resources/read', {
      contents: read.contents.map((entry) => ({
        uri: `colp://${SERVER_UUID}/collections/${COLLECTION_ID}`,
        mimeType: entry.mimeType,
        text: entry.text,
      })),
    }, readCache);

    const authenticated = authenticatedContext();
    const authenticatedListCache = await projection.cacheForList({}, authenticated);
    const authenticatedReadCache = await projection.cacheForRead(
      { resource: collectionResource },
      authenticated,
    );

    // The trusted marker is an internal input assertion; it must never appear
    // in the serialized result, even when it is passed explicitly.
    const explicitMarkerResult = createMcp20260728Result({
      method: 'resources/list',
      cache: { ttlMs: PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public', callerScope: 'anonymous' },
      fields: { resources: [] },
    });

    const report = {
      list: {
        ...cacheObservation(listCache),
        result: resultObservation(listResult, ListResourcesResultSchema),
        resourceNames: listed.resources.map((entry) => entry.name),
      },
      read: {
        ...cacheObservation(readCache),
        result: resultObservation(readResult, ReadResourceResultSchema),
        contentCount: read.contents.length,
      },
      authenticated: {
        list: cacheObservation(authenticatedListCache),
        read: cacheObservation(authenticatedReadCache),
      },
      explicitMarker: resultObservation(explicitMarkerResult, ListResourcesResultSchema),
      unmarkedFactoryError: captureTypeError(() => createMcp20260728Result({
        method: 'resources/list',
        cache: { ttlMs: PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
        fields: { resources: [] },
      })),
      unmarkedWrapperError: captureTypeError(() => createPhase4bMcpResult({
        method: 'resources/list',
        cache: { ttlMs: PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
        fields: { resources: [] },
      })),
    };

    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    cursorKeys.destroy();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
}
