import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  type McpTrustedReadRequestContext,
} from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import {
  PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS,
  createPhase4bMcpCollectionResourceCursorKeyring,
  createPhase4bMcpCollectionResourceProjection,
} from '../../../src/modules/mcp/index.js';
import {
  createPublicationCursorKeyring,
  type PublicationDirectoryReadPort,
  type PublicationDirectoryRecord,
} from '../../../src/modules/publication/index.js';
import type { AccessPolicyFactsPort } from '../../../src/modules/access-policy/index.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const AUDIENCE = 'https://collections.example.test/collections/-/mcp';
const NOW = new Date('2026-08-05T08:00:00.000Z');
const LONG_SUMMARY = `Fresh public notes. ${'x'.repeat(400)}`;

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

interface AnnotatedItem {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly _meta?: { readonly nodeCount: number; readonly updatedAt: string };
}

function directoryRecords(): PublicationDirectoryRecord[] {
  return [
    {
      id: 'fresh',
      ownerSubjectId: 'owner',
      title: 'Fresh Collection',
      summary: LONG_SUMMARY,
      kind: 'bookmarks',
      visibility: 'public',
      publicationSlug: 'fresh',
      tags: [],
      language: null,
      nodeCount: 12,
      updatedAt: '2026-08-05T07:00:00.000Z',
      orderingUpdatedAtMicros: '3000000',
      protectedAuthorized: false,
    },
    {
      id: 'older',
      ownerSubjectId: 'owner',
      title: 'Older Collection',
      summary: '  A short public path.  ',
      kind: 'bookmarks',
      visibility: 'public',
      publicationSlug: 'older',
      tags: [],
      language: null,
      nodeCount: 3,
      updatedAt: '2026-07-01T00:00:00.000Z',
      orderingUpdatedAtMicros: '2000000',
      protectedAuthorized: false,
    },
    {
      id: 'blank-summary',
      ownerSubjectId: 'owner',
      title: 'No Summary',
      summary: '   ',
      kind: 'bookmarks',
      visibility: 'public',
      publicationSlug: 'blank-summary',
      tags: [],
      language: null,
      nodeCount: 1,
      updatedAt: '2026-06-01T00:00:00.000Z',
      orderingUpdatedAtMicros: '1000000',
      protectedAuthorized: false,
    },
  ];
}

function createDirectoryRead(): PublicationDirectoryReadPort {
  const records = directoryRecords();
  return {
    async loadPage(request) {
      const sorted = [...records].sort((left, right) => {
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

function createProjection() {
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
      reads: createDirectoryRead(),
      cursors: publicationCursors,
      origin: 'https://known.example',
    },
    metadataQuery: {
      reads: { async load() { return null; } },
      origin: 'https://known.example',
      now: () => NOW,
    },
    accessPolicy: {
      async loadCollectionFacts() { return null; },
    } as AccessPolicyFactsPort,
    cursorKeys: mcpCursors,
    now: () => NOW,
    pageSize: 2,
    sharedExposure: Object.freeze({ async listBlobFacts() { return []; } }),
  });
  return {
    projection,
    destroy() {
      mcpCursors.destroy();
      publicationCursors.destroy();
    },
  };
}

function anonymousContext(): McpTrustedReadRequestContext {
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

test('anonymous resources/list is newest-first and annotates description plus _meta', async () => {
  const fixture = createProjection();
  try {
    const first = await fixture.projection.listResources(Object.freeze({}), anonymousContext());
    const items = first.resources as readonly AnnotatedItem[];
    assert.deepEqual(items.map((entry) => entry.uri.split('/').at(-1)), ['fresh', 'older']);
    assert.equal(items[0]!.description?.startsWith('Fresh public notes.'), true);
    assert.equal(items[0]!.description?.endsWith('…'), true);
    assert.ok((items[0]!.description?.length ?? 0) <= PHASE4B_MCP_COLLECTION_RESOURCE_DESCRIPTION_MAX_CHARS);
    assert.deepEqual(items[0]!._meta, { nodeCount: 12, updatedAt: '2026-08-05T07:00:00.000Z' });
    assert.equal(items[1]!.description, 'A short public path.');
    assert.deepEqual(items[1]!._meta, { nodeCount: 3, updatedAt: '2026-07-01T00:00:00.000Z' });
    assert.ok(first.nextCursor);

    const second = await fixture.projection.listResources(
      Object.freeze({ cursor: first.nextCursor! }),
      anonymousContext(),
    );
    const continued = second.resources as readonly AnnotatedItem[];
    assert.deepEqual(continued.map((entry) => entry.uri.split('/').at(-1)), ['blank-summary']);
    assert.equal(continued[0]!.description, undefined);
    assert.deepEqual(continued[0]!._meta, { nodeCount: 1, updatedAt: '2026-06-01T00:00:00.000Z' });
    assert.equal(second.nextCursor, undefined);
  } finally {
    fixture.destroy();
  }
});
