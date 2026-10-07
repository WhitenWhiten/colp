import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_STATIC_GENERATION,
  type CommunityRankedEntry,
  type CommunityRankingQueryPorts,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_MCP_RANKING_TOOL_NAME,
  COMMUNITY_MCP_TARGET_TOOL_NAME,
  COMMUNITY_MCP_VOTE_TOOL_NAME,
  createCommunityMcpToolPort,
} from '../../../src/modules/mcp/community-mcp.js';
import type { McpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { McpApplicationToolResult } from '../../../src/modules/mcp/application-results.js';

const ACCOUNT = 'account-reader';
const SUBJECT = 'subject-reader';
const HMAC_KEY = Buffer.alloc(32, 13);
const NOW = new Date('2026-10-02T00:00:00.000Z');

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: 'col-1',
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};

function context(options: {
  authenticated?: boolean;
  scopes?: readonly string[];
} = {}): McpApplicationContext {
  const authenticated = options.authenticated ?? true;
  return {
    principal: authenticated
      ? { kind: 'authenticated', principalId: ACCOUNT, clientId: 'client',
          credentialBindingId: 'binding', resourceAudience: 'aud', securityEpoch: '1' }
      : { kind: 'anonymous', principalId: 'public', resourceAudience: 'aud', securityEpoch: '1' },
    clientId: 'client',
    scopes: options.scopes ?? ['product:read', 'product:write'],
    resourceAudience: 'aud',
    abortSignal: new AbortController().signal,
    budgets: { maxDepth: 8, maxNodes: 256, maxBytes: 65_536, maxOperations: 8 },
    correlationId: 'corr-1',
    authorization: authenticated ? { accountSubjectId: SUBJECT } : {},
  };
}

function rankingPorts(entries: readonly CommunityRankedEntry[] = []): CommunityRankingQueryPorts {
  return {
    rankings: {
      latestSnapshot: async () => ({
        snapshotId: '7', scoreVersion: 'hot-v1', createdAt: NOW, itemCount: entries.length,
      }),
      findSnapshot: async () => null,
      scanEntries: async (_id, afterPosition, limit) =>
        entries.filter((row) => row.position > afterPosition).slice(0, limit),
    },
    targets: {
      resolve: async () => ({
        target: COLLECTION_TARGET, ownerSubjectId: 'subject-owner',
        title: 'Curated list', href: '/c/curated',
      }),
    },
    clock: { now: async () => NOW },
  };
}

function port(input: {
  enabled?: boolean;
  ranking?: CommunityRankingQueryPorts;
  hmacKey?: Buffer;
} = {}) {
  return createCommunityMcpToolPort({
    enabled: input.enabled ?? true,
    targetQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityTargetQueryPorts) => Promise<Result>) =>
        work({} as CommunityTargetQueryPorts),
    },
    voteCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>) =>
        work({} as CommunityVoteCommandPorts),
    },
    ...(input.ranking !== undefined
      ? { rankingQueryUnitOfWork: {
          execute: <Result>(work: (ports: CommunityRankingQueryPorts) => Promise<Result>,
            _options?: { readonly signal?: AbortSignal }) => work(input.ranking!),
        } }
      : {}),
    ...(input.hmacKey !== undefined ? { rankingCursorHmacKey: input.hmacKey } : {}),
  });
}

function structured(result: McpApplicationToolResult): unknown {
  assert.equal(result.kind, 'complete');
  return result.kind === 'complete' ? result.structuredContent : undefined;
}

test('the ranking tool lists only when its query port and cursor key are composed', async () => {
  const ready = await port({ ranking: rankingPorts(), hmacKey: HMAC_KEY })
    .listTools(context({ scopes: ['product:read'] }), undefined);
  assert.deepEqual(ready.map((tool) => tool.name),
    [COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_RANKING_TOOL_NAME]);

  const missingPorts = await port().listTools(context(), undefined);
  assert.deepEqual(missingPorts.map((tool) => tool.name).sort(),
    [COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME].sort());

  const missingKey = await port({ ranking: rankingPorts() }).listTools(context(), undefined);
  assert.ok(!missingKey.some((tool) => tool.name === COMMUNITY_MCP_RANKING_TOOL_NAME));

  // Anonymous callers may read the public ranking but never see the vote tool.
  const anonymous = await port({ ranking: rankingPorts(), hmacKey: HMAC_KEY })
    .listTools(context({ authenticated: false }), undefined);
  assert.deepEqual(anonymous.map((tool) => tool.name),
    [COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_RANKING_TOOL_NAME]);
});

test('known.community.ranking requires product:read for authenticated callers', async () => {
  const tool = port({ ranking: rankingPorts(), hmacKey: HMAC_KEY });
  const denied = await tool.callTool(context({ scopes: ['product:write'] }),
    COMMUNITY_MCP_RANKING_TOOL_NAME, {});
  assert.deepEqual(denied, { kind: 'rejected', stableCode: 'insufficient_scope',
    safeMessage: 'Insufficient scope.', retryable: false });
});

test('known.community.ranking serves the durable page anonymously and to readers', async () => {
  const entries: CommunityRankedEntry[] = [{
    position: 1, target: COLLECTION_TARGET, title: 'Curated list', href: '/c/curated',
    tags: ['design'], language: 'en', up: 5, down: 1,
    firstVoteAt: new Date(NOW.getTime() - 3_600_000), hot: 1.25,
  }];
  const tool = port({ ranking: rankingPorts(entries), hmacKey: HMAC_KEY });
  for (const ctx of [context(), context({ authenticated: false })]) {
    const result = await tool.callTool(ctx, COMMUNITY_MCP_RANKING_TOOL_NAME, {});
    const page = structured(result) as {
      items: { title: string; up: number; firstVoteAt: string | null }[];
      nextCursor: string | null;
      asOf: string;
      scoreVersion: string;
    };
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.title, 'Curated list');
    assert.equal(page.items[0]!.up, 5);
    assert.equal(page.nextCursor, null);
    assert.equal(page.asOf, NOW.toISOString());
    assert.equal(page.scoreVersion, 'hot-v1');
  }
});

test('known.community.ranking rejects unknown argument keys and malformed queries', async () => {
  const tool = port({ ranking: rankingPorts(), hmacKey: HMAC_KEY });
  for (const [args, code] of [
    [{ viewer: 'attacker' }, 'invalid_query'],
    [{ query: 'collection' }, 'invalid_query'],
    [{ query: { sort: 'hot' } }, 'invalid_query'],
    [{ query: { collectionId: 'col-1' } }, 'invalid_query'],
    [{ query: { limit: 0 } }, 'invalid_query'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_RANKING_TOOL_NAME, args);
    const body = structured(result) as { error: { code: string } };
    assert.equal(result.kind === 'complete' && result.isError, true, JSON.stringify(args));
    assert.equal(body.error.code, code, JSON.stringify(args));
  }
  // Viewer identity comes from context only: a query-level viewer hint can
  // never be smuggled in because `query` rejects unknown keys.
});

test('known.community.ranking maps cursor and snapshot errors to product codes', async () => {
  const tool = port({ ranking: rankingPorts(), hmacKey: HMAC_KEY });
  const badCursor = await tool.callTool(context(), COMMUNITY_MCP_RANKING_TOOL_NAME,
    { query: { cursor: 'not a cursor!!' } });
  const badBody = structured(badCursor) as { error: { code: string } };
  assert.equal(badBody.error.code, 'invalid_cursor');

  // A signed cursor whose snapshot is gone is snapshot_expired, not invalid.
  const paged = port({
    ranking: rankingPorts([{
      position: 1, target: COLLECTION_TARGET, title: 'A', href: '/a',
      tags: [], language: 'en', up: 2, down: 0, firstVoteAt: NOW, hot: 1,
    }, {
      position: 2, target: { ...COLLECTION_TARGET, id: 'col-2' }, title: 'B', href: '/b',
      tags: [], language: 'en', up: 1, down: 0, firstVoteAt: NOW, hot: 0.5,
    }]),
    hmacKey: HMAC_KEY,
  });
  const first = await paged.callTool(context(), COMMUNITY_MCP_RANKING_TOOL_NAME,
    { query: { limit: 1 } });
  const cursor = (structured(first) as { nextCursor: string | null }).nextCursor;
  assert.ok(cursor);
  const expired = await paged.callTool(context(), COMMUNITY_MCP_RANKING_TOOL_NAME,
    { query: { limit: 1, cursor } });
  const expiredBody = structured(expired) as { error: { code: string } };
  assert.equal(expiredBody.error.code, 'snapshot_expired');
});
