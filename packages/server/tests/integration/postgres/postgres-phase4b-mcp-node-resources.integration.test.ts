import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpResourceNotFoundError,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { createValidatorRegistry } from '@know-n/colp/schema';
import { loadConfig } from '../../support/test-config.js';
import { createPostgresSharedExposureFactsPort, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresAccessPolicyFactsPort,
} from '../../../src/infrastructure/access-policy/index.js';
import {
  createPostgresPublicationAnnotationReadPort,
  createPostgresPublicationRelationReadPort,
  createPostgresPublicationSnapshotReadPort,
} from '../../../src/infrastructure/publication/index.js';
import {
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
  PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS,
  createPhase4bMcpNodeResourceProjection,
  type Phase4bMcpNodeResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
} from '../../../src/modules/publication/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const OWNER = 'owner-fixture';
const MEMBER = 'member-fixture';
const OUTSIDER = 'outsider-fixture';
const SIDECAR_SECRET = 'sidecar-secret-content';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  PUBLICATION_ORIGIN: 'https://collections.example.test',
  PUBLICATION_SERVER_UUID: SERVER_UUID,
  LOG_LEVEL: 'silent',
};

function mcpEnv(): Record<string, string> {
  return {
    ...baseEnv,
    OIDC_ISSUER: 'https://issuer.example.test/realms/known',
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
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

describeWithPostgres('Phase 4B R10 MCP Node Resource PostgreSQL projection', () => {
  let isolated: IsolatedPostgresRuntime;
  let projection: Phase4bMcpNodeResourceProjection;
  let destroyProjection: () => void;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_node_resources', {
      maxConnections: 8,
      applicationName: 'known-phase4b-mcp-node-resources',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedNodeFixture(isolated);
    const built = buildProjection(isolated);
    projection = built.projection;
    destroyProjection = built.destroy;
  }, 300_000);

  afterAll(async () => {
    destroyProjection?.();
    await isolated?.close();
  });

  test('root, folder, and bookmark point reads return current core Node JSON', async () => {
    for (const [nodeId, kind] of [
      ['node-root', 'root'],
      ['node-folder', 'folder'],
      ['node-bookmark', 'bookmark'],
    ] as const) {
      const result = await projection.readResource(nodeInput('node-collection', nodeId), trustedContext());
      const body = JSON.parse(result.contents[0]!.text) as Record<string, unknown>;
      assert.equal(result.contents[0]!.mimeType, PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE);
      assert.deepEqual(result.contents[0]!.provenance, { origin: 'internal' });
      assert.equal(body.kind, kind, nodeId);
      assert.equal(body.id, nodeId, nodeId);
      assert.equal(body.collectionId, 'node-collection', nodeId);
      assert.equal(fixtureContainsSidecarSecrets(JSON.stringify(body)), false);
    }
  });

  test('sidecar rows are omitted from Node point reads and sidecar ports stay unrequested', async () => {
    const result = await projection.readResource(nodeInput('node-collection', 'node-bookmark'), trustedContext());
    assert.doesNotMatch(result.contents[0]!.text, /sidecar-secret-content|sidecar-relation-label|ownerSubjectId/u);
  });

  test('malicious title and URL serialize as escaped I-JSON and pass COLP node schema', async () => {
    const result = await projection.readResource(nodeInput('node-collection', 'node-malicious'), trustedContext());
    const text = result.contents[0]!.text;
    assert.equal(Buffer.byteLength(text, 'utf8'), text.length);
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/u);
    assert.ok(text.includes('\\u4e2d'));
    assert.ok(text.includes('\\ud83d\\ude42'));
    const body = JSON.parse(text) as Record<string, unknown>;
    const validation = createValidatorRegistry().validate('node', body);
    assert.equal(validation.valid, true);
    assert.doesNotMatch(text, /ownerSubjectId|membershipRole|creatorPrincipalId|subjectId/u);
  });

  test('wrong collection binding and hidden nodes conceal existence with private cache', async () => {
    for (const input of [
      nodeInput('node-collection', 'other-node'),
      nodeInput('node-collection', 'node-hidden'),
      nodeInput('node-collection', 'node-hidden-child'),
      nodeInput('node-collection', 'missing-node'),
    ]) {
      await assert.rejects(
        () => projection.readResource(input, trustedContext()),
        (error: unknown) => {
          assert.equal(error instanceof McpResourceNotFoundError, true);
          assert.equal((error as McpResourceNotFoundError).message, 'MCP Resource was not found.');
          assert.equal('resource' in (error as Record<string, unknown>), false);
          return true;
        },
      );
      assert.deepEqual(
        await projection.cacheForRead(input, trustedContext()),
        { ttlMs: 0, cacheScope: 'private' },
      );
    }
  });

  test('member and owner reads include protected/private nodes; outsiders and revoked members do not', async () => {
    await assert.rejects(
      () => projection.readResource(nodeInput('node-collection', 'node-hidden'), authenticatedContext(OUTSIDER)),
      McpResourceNotFoundError,
    );

    const member = await projection.readResource(
      nodeInput('node-collection', 'node-hidden'),
      authenticatedContext(MEMBER),
    );
    const memberBody = JSON.parse(member.contents[0]!.text) as Record<string, unknown>;
    assert.equal(memberBody.id, 'node-hidden');
    assert.equal(memberBody.visibility, 'private');
    assert.deepEqual(
      await projection.cacheForRead(
        nodeInput('node-collection', 'node-hidden'),
        authenticatedContext(MEMBER),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );

    const owner = await projection.readResource(
      nodeInput('node-collection', 'node-hidden-child'),
      authenticatedContext(OWNER),
    );
    const ownerBody = JSON.parse(owner.contents[0]!.text) as Record<string, unknown>;
    assert.equal(ownerBody.id, 'node-hidden-child');

    await isolated.runtime.pool.query(
      `delete from collection_members
        where collection_id = 'node-collection' and subject_id = $1`,
      [MEMBER],
    );
    await assert.rejects(
      () => projection.readResource(
        nodeInput('node-collection', 'node-hidden'),
        authenticatedContext(MEMBER),
      ),
      McpResourceNotFoundError,
    );
    await isolated.runtime.pool.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ('node-collection', $1, 'viewer')`,
      [MEMBER],
    );
  });

  test('move and deletion invalidate the prior cache class and resolve to current state', async () => {
    const before = await projection.readResource(
      nodeInput('node-collection', 'node-moved'),
      trustedContext(),
    );
    const beforeBody = JSON.parse(before.contents[0]!.text) as Record<string, unknown>;
    assert.equal(beforeBody.parentId, 'node-root');
    assert.deepEqual(
      await projection.cacheForRead(nodeInput('node-collection', 'node-moved'), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );

    await isolated.runtime.pool.query(
      `with changed as (
         update nodes
            set parent_id = 'node-hidden',
                position_token = 'Z',
                resource_revision = 'moved-r2',
                updated_at = '2026-08-05T09:00:00Z'::timestamptz
          where id = 'node-moved'
          returning collection_id, parent_id
       )
       update collections
          set content_revision = 'content-after-move',
              resource_revision = 'resource-after-move',
              updated_at = '2026-08-05T09:00:00Z'::timestamptz
        where id = 'node-collection'`,
    );

    await assert.rejects(
      () => projection.readResource(nodeInput('node-collection', 'node-moved'), trustedContext()),
      McpResourceNotFoundError,
    );
    assert.deepEqual(
      await projection.cacheForRead(nodeInput('node-collection', 'node-moved'), trustedContext()),
      { ttlMs: 0, cacheScope: 'private' },
    );

    const after = await projection.readResource(
      nodeInput('node-collection', 'node-moved'),
      authenticatedContext(OWNER),
    );
    const afterBody = JSON.parse(after.contents[0]!.text) as Record<string, unknown>;
    assert.equal(afterBody.parentId, 'node-hidden');
    assert.equal(afterBody.position, 'Z');
    assert.equal(afterBody.revision, 'moved-r2');

    await isolated.runtime.pool.query(
      `update nodes
          set deleted_at = '2026-08-05T10:00:00Z'::timestamptz,
              updated_at = '2026-08-05T10:00:00Z'::timestamptz
        where id = 'node-moved'`,
    );
    await assert.rejects(
      () => projection.readResource(
        nodeInput('node-collection', 'node-moved'),
        authenticatedContext(OWNER),
      ),
      McpResourceNotFoundError,
    );
  });

  test('public nodes carry public cache scope only for anonymous public projections', async () => {
    assert.deepEqual(
      await projection.cacheForRead(nodeInput('node-collection', 'node-bookmark'), trustedContext()),
      { ttlMs: PHASE4B_MCP_PUBLIC_READ_CACHE_TTL_MS, cacheScope: 'public' },
    );
    assert.deepEqual(
      await projection.cacheForRead(
        nodeInput('node-collection', 'node-bookmark'),
        authenticatedContext(OWNER),
      ),
      { ttlMs: 0, cacheScope: 'private' },
    );
    assert.ok(
      Buffer.byteLength(
        (await projection.readResource(nodeInput('node-collection', 'node-bookmark'), trustedContext()))
          .contents[0]!.text,
        'utf8',
      ) <= DEFAULT_MCP_RESOURCE_READ_BUDGET.maxTextBytes,
    );
  });
});

function nodeInput(
  collectionId: string,
  nodeId: string,
): Readonly<{ readonly resource: { readonly kind: 'collection-node'; readonly collectionId: string; readonly nodeId: string } }> {
  return Object.freeze({
    resource: Object.freeze({ kind: 'collection-node', collectionId, nodeId }),
  });
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

function authenticatedContext(principalId: string): McpTrustedReadRequestContext {
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
  });
}

function buildProjection(isolatedRuntime: IsolatedPostgresRuntime): {
  readonly projection: Phase4bMcpNodeResourceProjection;
  readonly destroy: () => void;
} {
  const publicationCursors = createPublicationCursorKeyring({
    active: { id: 'node-pg-v1', secret: Buffer.alloc(32, 103).toString('base64') },
    retained: [],
  });
  const snapshotQuery = {
    reads: createPostgresPublicationSnapshotReadPort(isolatedRuntime.runtime),
    annotations: createPostgresPublicationAnnotationReadPort(isolatedRuntime.runtime, {
      origin: 'https://known.example',
    }),
    relations: createPostgresPublicationRelationReadPort(isolatedRuntime.runtime),
    accessPolicy: createPostgresAccessPolicyFactsPort(isolatedRuntime.runtime.db),
    cursors: publicationCursors,
    origin: 'https://known.example',
    now: () => NOW,
    sharedExposure: createPostgresSharedExposureFactsPort(isolatedRuntime.runtime),
  };
  const projection = createPhase4bMcpNodeResourceProjection({
    config: loadConfig(mcpEnv()).mcp!,
    snapshotQuery,
    now: () => NOW,
  });
  return {
    projection,
    destroy() {
      publicationCursors.destroy();
    },
  };
}

function fixtureContainsSidecarSecrets(value: string): boolean {
  return value.includes(SIDECAR_SECRET) || value.includes('sidecar-relation-label');
}

async function seedNodeFixture(isolatedRuntime: IsolatedPostgresRuntime): Promise<void> {
  const client = await isolatedRuntime.runtime.pool.connect();
  try {
    await client.query('begin');
    await client.query('set constraints all deferred');
    await client.query(
      `insert into resource_id_ledger(resource_id, resource_type) values
         ('node-collection', 'collection'),
         ('node-root', 'node'),
         ('node-folder', 'node'),
         ('node-bookmark', 'node'),
         ('node-hidden', 'node'),
         ('node-hidden-child', 'node'),
         ('node-malicious', 'node'),
         ('node-moved', 'node'),
         ('other-collection', 'collection'),
         ('other-root', 'node'),
         ('other-node', 'node'),
         ('node-annotation', 'annotation'),
         ('node-relation', 'relation')`,
    );
    await client.query(
      `insert into collections
        (id, owner_subject_id, title, kind, visibility, root_node_id,
         resource_revision, content_revision, policy_revision, publication_slug,
         published_at, updated_at)
       values
         ('node-collection', $1, 'Node Collection', 'mixed', 'public', 'node-root',
          'r1', 'c1', 'p1', 'node-collection',
          '2026-01-01T00:00:00Z'::timestamptz, '2026-01-01T00:00:00Z'::timestamptz),
         ('other-collection', $2, 'Other Collection', 'bookmarks', 'public', 'other-root',
          'r1', 'c1', 'p1', 'other-collection',
          '2026-01-01T00:00:00Z'::timestamptz, '2026-01-01T00:00:00Z'::timestamptz)`,
      [OWNER, 'other-owner'],
    );
    await client.query(
      `insert into nodes(
         id, collection_id, parent_id, kind, is_root, title, url, tags,
         visibility, position_token, resource_revision, children_revision)
       values
         ('node-root', 'node-collection', null, 'folder', true, 'Node Root', null,
          '[]'::jsonb, 'inherit', null, 'r1', 'ch1'),
         ('node-folder', 'node-collection', 'node-root', 'folder', false, 'Folder', null,
          '[]'::jsonb, 'inherit', 'A', 'r1', 'ch1'),
         ('node-bookmark', 'node-collection', 'node-folder', 'bookmark', false, 'Bookmark',
          'https://example.test/bookmark', '["known"]'::jsonb, 'inherit', 'A', 'r1', 'ch1'),
         ('node-hidden', 'node-collection', 'node-root', 'folder', false, 'Hidden',
          null, '[]'::jsonb, 'private', 'B', 'r1', 'ch1'),
         ('node-hidden-child', 'node-collection', 'node-hidden', 'bookmark', false, 'Hidden Child',
          'https://example.test/hidden-child', '[]'::jsonb, 'inherit', 'A', 'r1', 'ch1'),
         ('node-malicious', 'node-collection', 'node-root', 'bookmark', false, $1,
           $2, '[]'::jsonb, 'inherit', 'C', 'r1', 'ch1'),
         ('node-moved', 'node-collection', 'node-root', 'bookmark', false, 'Moved',
          'https://example.test/moved', '[]'::jsonb, 'inherit', 'D', 'r1', 'ch1'),
         ('other-root', 'other-collection', null, 'folder', true, 'Other Root', null,
          '[]'::jsonb, 'inherit', null, 'r1', 'ch1'),
         ('other-node', 'other-collection', 'other-root', 'bookmark', false, 'Other Node',
          'https://example.test/other', '[]'::jsonb, 'inherit', 'A', 'r1', 'ch1')`,
      [
        'Malicious\n<script>alert("x")</script> 中文🙂',
        'https://example.test/?q=%22%3E%3Csvg%20onload%3Dalert(1)%3E',
      ],
    );
    await client.query(
      `insert into collection_members(collection_id, subject_id, role)
       values ('node-collection', $1, 'viewer')`,
      [MEMBER],
    );
    const instant = '2026-07-25T00:00:00Z';
    await client.query(
      `insert into annotations(
         id, collection_id, subject_type, subject_id, creator_principal_id,
         type, format, value_json, visibility, resource_revision, created_at,
         updated_at, payload_json)
       values (
         'node-annotation', 'node-collection', 'node', 'node-bookmark', $1,
         'note', 'plain', to_jsonb($2::text), 'public', 'r1',
         $3::timestamptz, $3::timestamptz,
         jsonb_build_object(
           'id', 'node-annotation',
           'collectionId', 'node-collection',
           'subject', jsonb_build_object('type', 'node', 'id', 'node-bookmark'),
           'creator', jsonb_build_object('id', 'https://known.example/profiles/owner', 'name', 'Owner'),
           'type', 'note', 'format', 'plain', 'value', to_jsonb($2::text),
           'visibility', 'public', 'revision', 'r1',
           'createdAt', $3::timestamptz, 'updatedAt', $3::timestamptz))`,
      [OWNER, SIDECAR_SECRET, instant],
    );
    await client.query(
      `insert into relations(
         id, collection_id, from_node_id, to_node_id, type, label, visibility,
         resource_revision, created_at, updated_at, payload_json)
       values (
         'node-relation', 'node-collection', 'node-root', 'node-bookmark', 'related',
         'sidecar-relation-label', 'public', 'r1',
         $1::timestamptz, $1::timestamptz,
         jsonb_build_object(
           'id', 'node-relation',
           'collectionId', 'node-collection',
           'type', 'related',
           'fromNodeId', 'node-root',
           'toNodeId', 'node-bookmark',
           'label', 'sidecar-relation-label',
           'visibility', 'public',
           'revision', 'r1',
           'createdAt', $1::timestamptz, 'updatedAt', $1::timestamptz))`,
      [instant],
    );
    await client.query('commit');
    await isolatedRuntime.runtime.pool.query('analyze nodes');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
