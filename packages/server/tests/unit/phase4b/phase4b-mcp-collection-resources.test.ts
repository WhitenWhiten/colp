import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  createMcpStatelessReadCore,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
  createPhase4bMcpResourceIdentity,
  PHASE4B_MCP_COLLECTION_RESOURCE_COMPARATOR_VERSION,
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpCollectionResourceProjectionOptions,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryFilter,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
  type PublicationMetadataReadPort,
  type PublicationMetadataRecord,
} from '../../../src/modules/publication/index.js';
import type { AccessPolicyFactsPort } from '../../../src/modules/access-policy/index.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const OWNER = 'subject-owner';
const MEMBER = 'subject-member';
const OUTSIDER = 'subject-outsider';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: AUDIENCE,
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  } as Record<string, string>;
}

interface FixtureCollection {
  readonly id: string;
  readonly title: string;
  readonly visibility: 'public' | 'protected' | 'private' | 'unlisted';
  readonly ownerSubjectId: string;
  readonly published: boolean;
  readonly deleted: boolean;
  readonly member?: string;
  readonly updatedAt: string;
}

const fixtureCollections: readonly FixtureCollection[] = Object.freeze([
  Object.freeze({
    id: 'public-b',
    title: 'Public B',
    visibility: 'public',
    ownerSubjectId: OWNER,
    published: true,
    deleted: false,
    updatedAt: '2026-07-24T00:00:03.000000Z',
  }),
  Object.freeze({
    id: 'public-a',
    title: 'Public A',
    visibility: 'public',
    ownerSubjectId: OWNER,
    published: true,
    deleted: false,
    updatedAt: '2026-07-24T00:00:02.000000Z',
  }),
  Object.freeze({
    id: 'protected-owner',
    title: 'Protected Owner',
    visibility: 'protected',
    ownerSubjectId: OWNER,
    published: true,
    deleted: false,
    updatedAt: '2026-07-24T00:00:01.000000Z',
  }),
  Object.freeze({
    id: 'protected-member',
    title: 'Protected Member',
    visibility: 'protected',
    ownerSubjectId: 'other-owner',
    member: MEMBER,
    published: true,
    deleted: false,
    updatedAt: '2026-07-24T00:00:00.500000Z',
  }),
  Object.freeze({
    id: 'unlisted',
    title: 'Unlisted',
    visibility: 'unlisted',
    ownerSubjectId: OWNER,
    published: true,
    deleted: false,
    updatedAt: '2026-07-24T00:00:00.400000Z',
  }),
  Object.freeze({
    id: 'private',
    title: 'Private',
    visibility: 'private',
    ownerSubjectId: OWNER,
    published: true,
    deleted: false,
    updatedAt: '2026-07-24T00:00:00.300000Z',
  }),
  Object.freeze({
    id: 'deleted-public',
    title: 'Deleted Public',
    visibility: 'public',
    ownerSubjectId: OWNER,
    published: true,
    deleted: true,
    updatedAt: '2026-07-24T00:00:00.200000Z',
  }),
  Object.freeze({
    id: 'unpublished',
    title: 'Unpublished',
    visibility: 'protected',
    ownerSubjectId: OWNER,
    published: false,
    deleted: false,
    updatedAt: '2026-07-24T00:00:00.100000Z',
  }),
]);

function directoryRecords(): PublicationDirectoryRecord[] {
  return fixtureCollections
    .filter((fixture) => fixture.published && !fixture.deleted
      && (fixture.visibility === 'public' || fixture.visibility === 'protected'))
    .map((fixture, index) => ({
      id: fixture.id,
      ownerSubjectId: fixture.ownerSubjectId,
      title: fixture.title,
      summary: null,
      kind: 'bookmarks',
      visibility: fixture.visibility === 'public' ? 'public' : 'protected',
      publicationSlug: fixture.id,
      tags: [],
      language: null,
      nodeCount: 1,
      updatedAt: fixture.updatedAt,
      orderingUpdatedAtMicros: String(3_000_000 - index * 100_000),
      protectedAuthorized: fixture.visibility === 'protected',
    }));
}

function createFakeDirectoryRead(
  subjectMembers: Readonly<Record<string, readonly string[]>>,
): PublicationDirectoryReadPort {
  const records = directoryRecords();
  return {
    async loadPage(request) {
      const subject = request.principal === 'anonymous' ? undefined : request.principal.subjectId;
      const visible = records.filter((record) => {
        if (request.principal === 'anonymous') return record.visibility === 'public';
        if (record.visibility === 'public') return true;
        if (record.visibility !== 'protected') return false;
        return record.ownerSubjectId === subject
          || (subject !== undefined && (subjectMembers[subject] ?? []).includes(record.id));
      });
      const filtered = visible.filter((record) => {
        if (request.filter.tag !== undefined && !record.tags.includes(request.filter.tag)) return false;
        if (request.filter.kind !== undefined && record.kind !== request.filter.kind) return false;
        return true;
      });
      const sorted = [...filtered].sort((left, right) => {
        const time = Number(right.orderingUpdatedAtMicros) - Number(left.orderingUpdatedAtMicros);
        if (time !== 0) return time;
        return left.id.localeCompare(right.id, 'en', { sensitivity: 'variant' });
      });
      let page = sorted;
      if (request.after !== undefined) {
        const anchor = sorted.find((record) =>
          createHash('sha256').update(record.id).digest('hex').slice(0, 32)
            === request.after!.idLocator);
        const anchorIndex = anchor === undefined ? -1 : sorted.indexOf(anchor);
        if (anchorIndex < 0) throw new Error('publication directory anchor missing');
        page = sorted.slice(anchorIndex + 1);
      }
      return Object.freeze(page.slice(0, request.limit + 1));
    },
  };
}

function metadataRecords(): PublicationMetadataRecord[] {
  return fixtureCollections.map((fixture) => ({
    id: fixture.id,
    ownerSubjectId: fixture.ownerSubjectId,
    kind: 'bookmarks',
    title: fixture.title,
    summary: null,
    visibility: fixture.visibility,
    publicationSlug: fixture.published ? fixture.id : null,
    rootNodeId: `${fixture.id}-root`,
    rootAvailable: true,
    contentRevision: 'content-1',
    policyRevision: 'policy-1',
    tags: [],
    language: null,
    membershipRole: fixture.member === undefined ? null : 'viewer',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: fixture.updatedAt,
    deletedAt: fixture.deleted ? '2026-07-24T00:00:00.200000Z' : null,
  }));
}

function createFakeMetadataRead(): PublicationMetadataReadPort {
  const records = metadataRecords();
  return {
    async load(input) {
      const key = input.collectionId ?? input.publicationSlug;
      const record = records.find((candidate) => candidate.id === key || candidate.publicationSlug === key);
      if (record === undefined) return null;
      if (input.actorSubjectId !== undefined
        && record.id === 'protected-member'
        && input.actorSubjectId !== MEMBER) {
        return Object.freeze({ ...record, membershipRole: null });
      }
      return record;
    },
  };
}

function createFakeAccessPolicy(): AccessPolicyFactsPort {
  return {
    async loadCollectionFacts(input) {
      const fixture = fixtureCollections.find((candidate) => candidate.id === input.collectionId);
      if (fixture === undefined) return null;
      return {
        collectionId: fixture.id,
        ownerSubjectId: fixture.ownerSubjectId,
        visibility: fixture.visibility,
        policyRevision: 'policy-1',
        membershipRole: fixture.member === input.actorSubjectId ? 'viewer' : null,
        deleted: fixture.deleted,
      };
    },
  };
}

interface ProjectionFixture {
  readonly projection: Phase4bMcpCollectionResourceProjection;
  readonly destroy: () => void;
}

function createProjectionFixture(
  overrides: Partial<Phase4bMcpCollectionResourceProjectionOptions> = {},
  subjectMembers: Readonly<Record<string, readonly string[]>> = {},
): ProjectionFixture {
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'publication-unit', secret: Buffer.alloc(32, 41).toString('base64') },
    retained: [],
  });
  const mcpCursors = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-unit', secret: Buffer.alloc(32, 43).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => NOW,
  });
  const projection = createPhase4bMcpCollectionResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    directoryQuery: {
      reads: createFakeDirectoryRead(subjectMembers),
      cursors: publicationCursors,
      origin: 'https://known.example',
    },
    metadataQuery: {
      reads: createFakeMetadataRead(),
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: createFakeAccessPolicy(),
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize: 2,
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
    ...overrides,
  });
  return {
    projection,
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

function trustedContext(overrides: Partial<McpTrustedReadRequestContext> = {}): McpTrustedReadRequestContext {
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
    ...overrides,
  });
}

function authenticatedContext(principalId: string, overrides: Partial<McpTrustedReadRequestContext> = {}): McpTrustedReadRequestContext {
  return trustedContext({
    binding: Object.freeze({
      kind: 'authenticated',
      principalId,
      clientId: 'mcp-client',
      credentialBindingId: 'credential-1',
      resourceAudience: AUDIENCE,
      securityEpoch: 'epoch-1',
    }),
    authorization: Object.freeze({ accountSubjectId: principalId }),
    ...overrides,
  });
}

async function collectList(
  projection: Phase4bMcpCollectionResourceProjection,
  context: McpTrustedReadRequestContext,
): Promise<readonly string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await projection.listResources(
      cursor === undefined ? Object.freeze({}) : Object.freeze({ cursor }),
      context,
    );
    ids.push(...page.resources.map((entry) => entry.uri.split('/').at(-1)!));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return Object.freeze(ids);
}

test('MCP collection cursor is opaque, signed, expiry-bound, and key-rotated', () => {
  const initialNow = new Date('2026-08-05T00:00:00.000Z');
  const scope = {
    principal: 'anonymous',
    securityEpoch: 'epoch-1',
    filterDigest: 'filter-digest',
    filter: Object.freeze({ tag: 'known' }) as PublicationDirectoryFilter,
    pageSize: 2,
    comparator: PHASE4B_MCP_COLLECTION_RESOURCE_COMPARATOR_VERSION,
    policyRevision: 'policy-a',
    nextPosition: '1~abc',
  };
  const keyring = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-v1', secret: Buffer.alloc(32, 53).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => initialNow,
  });
  const token = keyring.sign(scope);

  assert.match(token, /^mcr1\./u);
  assert.equal(token.includes('anonymous'), false);
  assert.equal(token.includes('epoch-1'), false);
  assert.equal(token.includes('policy-a'), false);
  assert.equal(token.includes('1~abc'), false);

  const verified = keyring.verify(token);
  assert.equal(verified.valid, true);
  if (!verified.valid) return;
  assert.equal(verified.payload.principal, 'anonymous');
  assert.equal(verified.payload.securityEpoch, 'epoch-1');
  assert.equal(verified.payload.pageSize, 2);
  assert.equal(verified.payload.nextPosition, '1~abc');

  const expiredKeyring = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-v1', secret: Buffer.alloc(32, 53).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => new Date(initialNow.getTime() + 60_001),
  });
  assert.equal(expiredKeyring.verify(token).valid, false);

  const rotated = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-v2', secret: Buffer.alloc(32, 55).toString('base64') },
    retained: [{ id: 'mcp-v1', secret: Buffer.alloc(32, 53).toString('base64') }],
    ttlMs: 60_000,
    now: () => initialNow,
  });
  assert.equal(rotated.verify(token).valid, true);

  const dropped = createPhase4bMcpCollectionResourceCursorKeyring({
    active: { id: 'mcp-v2', secret: Buffer.alloc(32, 55).toString('base64') },
    retained: [],
    ttlMs: 60_000,
    now: () => initialNow,
  });
  assert.equal(dropped.verify(token).valid, false);
  keyring.destroy();
  rotated.destroy();
  dropped.destroy();
  expiredKeyring.destroy();
});

test('list projection separates anonymous, member, owner, and revoked visibility', async () => {
  const members: Record<string, readonly string[]> = { [MEMBER]: ['protected-member'] };
  const fixture = createProjectionFixture({}, members);
  try {
    const anonymous = await collectList(fixture.projection, trustedContext());
    assert.deepEqual(anonymous, ['public-b', 'public-a']);

    const member = await collectList(fixture.projection, authenticatedContext(MEMBER));
    assert.deepEqual(member, ['public-b', 'public-a', 'protected-member']);

    const owner = await collectList(fixture.projection, authenticatedContext(OWNER));
    assert.deepEqual(owner, ['public-b', 'public-a', 'protected-owner']);

    const outsider = await collectList(fixture.projection, authenticatedContext(OUTSIDER));
    assert.deepEqual(outsider, ['public-b', 'public-a']);

    const colliding = await collectList(
      fixture.projection,
      authenticatedContext(OWNER, {
        authorization: Object.freeze({ accountSubjectId: 'subject-attacker' }),
      }),
    );
    assert.deepEqual(colliding, ['public-b', 'public-a']);

    members[MEMBER] = [];
    const revoked = await collectList(fixture.projection, authenticatedContext(MEMBER));
    assert.deepEqual(revoked, ['public-b', 'public-a']);

    const first = await fixture.projection.listResources(Object.freeze({}), authenticatedContext(MEMBER));
    const firstItem = first.resources[0] as typeof first.resources[0] & {
      readonly description?: string;
      readonly _meta?: { readonly nodeCount: number; readonly updatedAt: string };
    };
    assert.deepEqual(Object.keys(firstItem).sort(), ['_meta', 'mimeType', 'name', 'provenance', 'uri']);
    assert.deepEqual(firstItem.provenance, { origin: 'internal' });
    assert.deepEqual(firstItem._meta, {
      nodeCount: 1,
      updatedAt: '2026-07-24T00:00:03.000000Z',
    });
    assert.equal(firstItem.description, undefined);
    assert.deepEqual(first.resources.map((entry) => entry.name), ['Public B', 'Public A']);
    const serialized = JSON.stringify(first.resources);
    assert.doesNotMatch(serialized, /ownerSubjectId|membershipRole|policyRevision|subjectId/iu);
  } finally {
    fixture.destroy();
  }
});

test('list pagination is deterministic with no duplicates or omissions', async () => {
  const fixture = createProjectionFixture({}, { [MEMBER]: ['protected-member'] });
  try {
    const member = await collectList(fixture.projection, authenticatedContext(MEMBER));
    assert.deepEqual(member, ['public-b', 'public-a', 'protected-member']);
    assert.equal(new Set(member).size, member.length);
  } finally {
    fixture.destroy();
  }
});

test('list cursor binds principal class, security epoch, filter, page size, comparator, and policy revision', async () => {
  let policyRevision = 'policy-a';
  const fixture = createProjectionFixture({
    policyRevisionFor: async () => policyRevision,
  }, { [MEMBER]: ['protected-member'] });
  try {
    const first = await fixture.projection.listResources(Object.freeze({}), authenticatedContext(MEMBER));
    assert.ok(first.nextCursor);

    const same = await fixture.projection.listResources(
      Object.freeze({ cursor: first.nextCursor! }),
      authenticatedContext(MEMBER),
    );
    assert.deepEqual(same.resources.map((entry) => entry.name), ['Protected Member']);

    await assert.rejects(
      () => fixture.projection.listResources(
        Object.freeze({ cursor: first.nextCursor! }),
        trustedContext(),
      ),
      McpReadRequestContextError,
    );
    await assert.rejects(
      () => fixture.projection.listResources(
        Object.freeze({ cursor: first.nextCursor! }),
        authenticatedContext(MEMBER, {
          binding: Object.freeze({
            kind: 'authenticated',
            principalId: MEMBER,
            clientId: 'mcp-client',
            credentialBindingId: 'credential-1',
            resourceAudience: AUDIENCE,
            securityEpoch: 'epoch-2',
          }),
        }),
      ),
      McpReadRequestContextError,
    );

    policyRevision = 'policy-b';
    await assert.rejects(
      () => fixture.projection.listResources(
        Object.freeze({ cursor: first.nextCursor! }),
        authenticatedContext(MEMBER),
      ),
      McpReadRequestContextError,
    );
  } finally {
    fixture.destroy();
  }
});

test('exact metadata read honors anonymous discoverability separately from exact URI read', async () => {
  const fixture = createProjectionFixture();
  try {
    const publicRead = await fixture.projection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'public-a' }) }),
      trustedContext(),
    );
    assert.equal(publicRead.contents[0]!.mimeType, PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE);
    const publicBody = JSON.parse(publicRead.contents[0]!.text) as Record<string, unknown>;
    assert.equal((publicBody.collection as { id: string }).id, 'public-a');
    assert.doesNotMatch(publicRead.contents[0]!.text, /ownerSubjectId|membershipRole|policyRevision|subjectId/iu);
    assert.deepEqual(
      await fixture.projection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'public-a' }) }),
        trustedContext(),
      ),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );

    const unlisted = await fixture.projection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'unlisted' }) }),
      trustedContext(),
    );
    assert.equal(JSON.parse(unlisted.contents[0]!.text).collection.visibility, 'unlisted');
    assert.deepEqual(
      await fixture.projection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'unlisted' }) }),
        trustedContext(),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );

    for (const id of ['protected-member', 'private', 'deleted-public', 'missing']) {
      await assert.rejects(
        () => fixture.projection.readResource(
          Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: id }) }),
          trustedContext(),
        ),
        McpResourceNotFoundError,
        id,
      );
    }

    await assert.rejects(
      () => fixture.projection.readResource(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'protected-member' }),
        }),
        authenticatedContext(OUTSIDER),
      ),
      McpResourceNotFoundError,
    );

    const ownerPrivate = await fixture.projection.readResource(
      Object.freeze({
        resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'private' }),
      }),
      authenticatedContext(OWNER),
    );
    assert.equal(JSON.parse(ownerPrivate.contents[0]!.text).collection.id, 'private');

    const member = await fixture.projection.readResource(
      Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'protected-member' }) }),
      authenticatedContext(MEMBER),
    );
    assert.equal(JSON.parse(member.contents[0]!.text).collection.id, 'protected-member');
    await assert.rejects(
      () => fixture.projection.readResource(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'protected-member' }) }),
        authenticatedContext(MEMBER, { scope: Object.freeze(['mcp:read:public']) }),
      ),
      McpResourceNotFoundError,
    );
    assert.deepEqual(
      await fixture.projection.cacheForRead(
        Object.freeze({ resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'protected-member' }) }),
        authenticatedContext(MEMBER),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    fixture.destroy();
  }
});

test('projection output passes the stateless read core validation and canonical URI seam', async () => {
  const fixture = createProjectionFixture();
  const config = loadConfig(mcpEnv()).mcp!;
  const identity = createPhase4bMcpResourceIdentity(config);
  const core = createMcpStatelessReadCore({
    projection: {
      listResources: async (input, context) => {
        const page = await fixture.projection.listResources(input, context);
        return Object.freeze({
          resources: Object.freeze(page.resources.map((entry) => Object.freeze({
            uri: entry.uri,
            name: entry.name,
            mimeType: entry.mimeType,
            provenance: entry.provenance,
          }))),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        });
      },
      readResource: (input, context) => fixture.projection.readResource(input, context),
    },
    uriCodec: identity.codec,
  });
  try {
    const metadataUri = identity.collectionMetadata('public-a');
    const read = await core.readResource(trustedContext(), { uri: metadataUri });
    assert.equal(read.contents[0]!.uri, metadataUri);
    assert.equal(JSON.parse(read.contents[0]!.text).collection.id, 'public-a');

    const list = await core.listResources(trustedContext(), {});
    assert.equal(list.resources[0]!.uri, identity.collectionMetadata('public-b'));
  } finally {
    fixture.destroy();
  }
});

test('non-collection metadata resources and deleted projections are concealed', async () => {
  const fixture = createProjectionFixture();
  try {
    await assert.rejects(
      () => fixture.projection.readResource(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-snapshot', collectionId: 'public-a' }),
        }),
        trustedContext(),
      ),
      McpResourceNotFoundError,
    );
    await assert.rejects(
      () => fixture.projection.readResource(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-node', collectionId: 'public-a', nodeId: 'node-1' }),
        }),
        trustedContext(),
      ),
      McpResourceNotFoundError,
    );
    await assert.rejects(
      () => fixture.projection.readResource(
        Object.freeze({
          resource: Object.freeze({ kind: 'collection-metadata', collectionId: 'deleted-public' }),
        }),
        authenticatedContext(OWNER),
      ),
      McpResourceNotFoundError,
    );
  } finally {
    fixture.destroy();
  }
});

test('list cache scope is private for authenticated results', async () => {
  const fixture = createProjectionFixture();
  try {
    assert.deepEqual(
      await fixture.projection.cacheForList(Object.freeze({}), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );
    assert.deepEqual(
      await fixture.projection.cacheForList(Object.freeze({}), authenticatedContext(MEMBER)),
      { ttlMs: 0, cacheScope: 'private' },
    );
  } finally {
    fixture.destroy();
  }
});
