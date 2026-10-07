import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME,
  COMMUNITY_MCP_NOTIFICATIONS_READ_TOOL_NAME,
} from '../../../src/modules/mcp/community-notification-mcp.js';
import { createCommunityMcpToolPort } from '../../../src/modules/mcp/community-mcp.js';
import type { McpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { McpApplicationToolResult } from '../../../src/modules/mcp/application-results.js';
import {
  COMMUNITY_STATIC_GENERATION,
  communityNotificationPreferenceEtag,
  type CommunityCommentRecord,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationQueryPorts,
  type CommunityNotificationRow,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
} from '../../../src/modules/community/index.js';

const ACCOUNT = 'account-reader';
const SUBJECT = 'subject-reader';
const HMAC_KEY = Buffer.alloc(32, 9);
const NOW = new Date('2026-10-05T12:00:00.000Z');
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';
const TARGET = { kind: 'collection' as const, id: 'col-1', collectionId: null, seriesId: null };

function context(options: { authenticated?: boolean; scopes?: readonly string[] } = {}): McpApplicationContext {
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

function comment(id: string): CommunityCommentRecord {
  return {
    id, target: TARGET, targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-root', replyToId: 'comment-root', depth: 1,
    authorAccountId: 'a-actor', body: 'reply body', state: 'visible',
    curationHidden: false, revision: 1n, createdAt: NOW, updatedAt: NOW,
  };
}

function row(id: string): CommunityNotificationRow {
  return {
    notificationId: id, actorProfileId: 'a-actor', subjectId: `comment-${id}`,
    state: 'unread', readAt: null, occurredAt: NOW,
  };
}

function queryPorts(rows: readonly CommunityNotificationRow[] = [row('n-1')]): CommunityNotificationQueryPorts {
  return {
    account: {
      findActive: async () => ({ accountId: ACCOUNT, subjectId: SUBJECT, createdAt: NOW }),
    },
    preferences: { findCommunity: async () => null },
    notifications: {
      page: async (_r, _state, _after, limit) => rows.slice(0, limit),
      unreadGroups: async () => [
        { target: TARGET, targetGeneration: COMMUNITY_STATIC_GENERATION, count: rows.length },
      ],
    },
    comments: {
      findMany: async (ids) => new Map(ids.map((id) => [id, comment(id)])),
    },
    targets: {
      resolve: async () => ({
        target: { ...TARGET, generation: COMMUNITY_STATIC_GENERATION },
        ownerSubjectId: 'subject-owner', title: 'T', href: '/c/col-1',
      }),
    },
    authors: {
      publicActors: async (ids) => new Map(ids.map((id) => [id, {
        accountId: id, subjectId: `s-${id}`, handle: 'alice',
        displayName: 'Alice', avatarUrl: null,
      }])),
    },
    clock: { now: async () => NOW },
  };
}

function commandPorts(setup: {
  claim?: { readonly kind: string };
} = {}): { ports: CommunityNotificationCommandPorts; marked: string[][] } {
  const marked: string[][] = [];
  const ports: CommunityNotificationCommandPorts = {
    receipts: {
      claim: async () => (setup.claim ?? { kind: 'claimed' }) as never,
      complete: async () => undefined,
      purgeExpired: async () => 0,
      deletePrincipalReceipts: async () => 0,
    },
    actor: {
      lockActiveAccount: async (accountId) =>
        accountId === ACCOUNT ? { subjectId: SUBJECT, createdAt: NOW } : null,
    },
    preferences: {
      findCommunity: async () => null,
      lockCommunity: async () => null,
      insertCommunity: async () => { throw new Error('unused'); },
      updateCommunity: async () => { throw new Error('unused'); },
    },
    notifications: {
      lockForRead: async (_r, ids) => ids.map((id) => row(id)),
      markRead: async (_r, ids) => { marked.push([...ids]); return ids; },
      unreadGroups: async () => [],
    },
    comments: { findMany: async (ids) => new Map(ids.map((id) => [id, comment(`comment-${id}`)])) },
    targets: {
      resolve: async () => ({
        target: { ...TARGET, generation: COMMUNITY_STATIC_GENERATION },
        ownerSubjectId: 'subject-owner', title: 'T', href: '/c/col-1',
      }),
    },
    etags: {
      preference: (input) => communityNotificationPreferenceEtag(input, HMAC_KEY),
    },
    audit: { append: async () => undefined },
    clock: { now: async () => NOW },
  };
  return { ports, marked };
}

function port(input: {
  enabled?: boolean;
  query?: CommunityNotificationQueryPorts;
  command?: CommunityNotificationCommandPorts;
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
    ...(input.query !== undefined ? {
      notificationQueryUnitOfWork: {
        execute: <Result>(work: (ports: CommunityNotificationQueryPorts) => Promise<Result>,
          _options?: { readonly signal?: AbortSignal }) => work(input.query!),
      },
    } : {}),
    ...(input.command !== undefined ? {
      notificationCommandUnitOfWork: {
        execute: <Result>(work: (ports: CommunityNotificationCommandPorts) => Promise<Result>,
          _options?: { readonly signal?: AbortSignal }) => work(input.command!),
      },
    } : {}),
    ...(input.hmacKey !== undefined ? { notificationCursorHmacKey: input.hmacKey } : {}),
  });
}

function structured(result: McpApplicationToolResult): unknown {
  assert.equal(result.kind, 'complete');
  return result.kind === 'complete' ? result.structuredContent : undefined;
}

function errorCode(result: McpApplicationToolResult): string {
  if (result.kind === 'rejected') return result.stableCode;
  assert.equal(result.kind, 'complete');
  assert.equal(result.kind === 'complete' && result.isError, true);
  const body = structured(result) as { error: { code: string } };
  return body.error.code;
}

const NAMES = {
  inbox: COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME,
  read: COMMUNITY_MCP_NOTIFICATIONS_READ_TOOL_NAME,
} as const;

test('the CS-05 tool names are the contract values', () => {
  assert.equal(NAMES.inbox, 'known.community.notifications');
  assert.equal(NAMES.read, 'known.community.notifications.read');
});

test('notification tools are listed only when their ports and cursor key are configured', async () => {
  const full = port({ query: queryPorts(), command: commandPorts().ports, hmacKey: HMAC_KEY });
  const names = (await full.listTools(context())).map((tool) => tool.name);
  assert.ok(names.includes(NAMES.inbox));
  assert.ok(names.includes(NAMES.read));

  const noCursorKey = port({ query: queryPorts(), command: commandPorts().ports });
  const noCursorNames = (await noCursorKey.listTools(context())).map((tool) => tool.name);
  assert.ok(!noCursorNames.includes(NAMES.inbox));
  assert.ok(noCursorNames.includes(NAMES.read));

  const noPorts = port({});
  const noPortNames = (await noPorts.listTools(context())).map((tool) => tool.name);
  assert.ok(!noPortNames.includes(NAMES.inbox));
  assert.ok(!noPortNames.includes(NAMES.read));

  // Anonymous listing fails closed on the anonymous-callable set: the
  // inbox requires an authenticated account at dispatch, so it is never
  // advertised — alongside the write-scoped read tool.
  const anonymous = await full.listTools(context({ authenticated: false }));
  assert.ok(!anonymous.map((tool) => tool.name).includes(NAMES.read));
  assert.ok(!anonymous.map((tool) => tool.name).includes(NAMES.inbox));

  // A read-only scope set drops the write tool.
  const readOnly = await full.listTools(context({ scopes: ['product:read'] }));
  assert.ok(readOnly.map((tool) => tool.name).includes(NAMES.inbox));
  assert.ok(!readOnly.map((tool) => tool.name).includes(NAMES.read));
});

test('the inbox tool rejects anonymous and scope-less callers', async () => {
  const p = port({ query: queryPorts(), hmacKey: HMAC_KEY });
  for (const ctx of [
    context({ authenticated: false }),
    context({ scopes: ['product:write'] }),
    context({ scopes: [] }),
  ]) {
    const result = await p.callTool(ctx, NAMES.inbox, {});
    assert.equal(errorCode(result), 'insufficient_scope');
  }
});

test('the inbox tool returns the closed page through the query port', async () => {
  const p = port({ query: queryPorts(), hmacKey: HMAC_KEY });
  const result = await p.callTool(context(), NAMES.inbox, { query: { read: 'unread', limit: 5 } });
  const page = structured(result) as {
    items: { id: string; kind: string }[]; nextCursor: string | null; unreadCount: number;
  };
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.kind, 'comment_reply');
  assert.equal(page.unreadCount, 1);
});

test('the inbox tool rejects unknown argument keys and malformed queries', async () => {
  const p = port({ query: queryPorts(), hmacKey: HMAC_KEY });
  for (const args of [
    { surprise: 1 },
    { query: { read: 'bogus' } },
    { query: { limit: 0 } },
    { query: { extra: 1 } },
    { query: 'not-an-object' },
  ]) {
    const result = await p.callTool(context(), NAMES.inbox, args);
    assert.match(errorCode(result), /^invalid_(query|request)$/u, JSON.stringify(args));
  }
});

test('the read tool marks ids read and reports changedIds + unreadCount', async () => {
  const { ports, marked } = commandPorts();
  const p = port({ command: ports });
  const result = await p.callTool(context(), NAMES.read, {
    body: { ids: ['n-1', 'n-2'] }, commandId: COMMAND_ID,
  });
  const body = structured(result) as { changedIds: string[]; unreadCount: number };
  assert.deepEqual(body.changedIds, ['n-1', 'n-2']);
  assert.equal(body.unreadCount, 0);
  assert.deepEqual(marked, [['n-1', 'n-2']]);
});

test('the read tool requires product:write and an authenticated principal', async () => {
  const p = port({ command: commandPorts().ports });
  for (const ctx of [
    context({ authenticated: false }),
    context({ scopes: ['product:read'] }),
  ]) {
    const result = await p.callTool(ctx, NAMES.read, {
      body: { ids: ['n-1'] }, commandId: COMMAND_ID,
    });
    assert.equal(errorCode(result), 'insufficient_scope');
  }
});

test('the read tool validates the closed {body,commandId} arguments', async () => {
  const p = port({ command: commandPorts().ports });
  for (const [args, code] of [
    [{ body: { ids: ['n-1'] } }, 'invalid_request'],
    [{ body: { ids: ['n-1'] }, commandId: 'not-a-uuid' }, 'invalid_request'],
    [{ body: { ids: ['n-1'] }, commandId: COMMAND_ID, extra: 1 }, 'invalid_query'],
    [{ body: { ids: [] }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { ids: ['n-1', 'n-1'] }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { extra: 1 }, commandId: COMMAND_ID }, 'invalid_request'],
  ] as const) {
    const result = await p.callTool(context(), NAMES.read, args);
    assert.equal(errorCode(result), code, JSON.stringify(args));
  }
});

test('the read tool maps receipt outcomes to the community error envelope', async () => {
  const replay = port({
    command: commandPorts({
      claim: {
        kind: 'replay',
        result: {
          status: 200,
          body: Buffer.from('{"changedIds":["n-9"],"unreadCount":4}'),
          stableHeaders: { 'cache-control': 'private, no-store', 'content-type': 'application/json' },
          mediaType: 'application/json', contractVersion: '1.0.0',
        },
      },
    } as never).ports,
  });
  const replayed = await replay.callTool(context(), NAMES.read, {
    body: { ids: ['n-9'] }, commandId: COMMAND_ID,
  });
  assert.deepEqual(structured(replayed), { changedIds: ['n-9'], unreadCount: 4 });

  for (const [claim, code] of [
    [{ kind: 'in_progress', retryAfterSeconds: 3 }, 'command_in_progress'],
    [{ kind: 'reused' }, 'command_id_reused'],
    [{ kind: 'expired', resultDigest: null }, 'command_result_expired'],
  ] as const) {
    const p = port({ command: commandPorts({ claim: claim as never }).ports });
    const result = await p.callTool(context(), NAMES.read, {
      body: { ids: ['n-1'] }, commandId: COMMAND_ID,
    });
    assert.equal(errorCode(result), code);
  }
});

test('a concealed inbox maps through the shared community error envelope', async () => {
  const gone = queryPorts();
  gone.account = { findActive: async () => null };
  const p = port({ query: gone, hmacKey: HMAC_KEY });
  const result = await p.callTool(context(), NAMES.inbox, {});
  assert.equal(errorCode(result), 'resource_not_found');
});
