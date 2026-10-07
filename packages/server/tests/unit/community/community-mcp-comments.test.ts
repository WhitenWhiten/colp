import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
  COMMUNITY_STATIC_GENERATION,
  COMMUNITY_TARGET_CONCEALED_MESSAGE,
  CommunityCommentError,
  communityCommentEtag,
  type CommunityCommentCommandPorts,
  type CommunityCommentQueryPorts,
  type CommunityCommentRecord,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_MCP_COMMENTS_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
  COMMUNITY_MCP_RANKING_TOOL_NAME,
  COMMUNITY_MCP_TARGET_TOOL_NAME,
  COMMUNITY_MCP_VOTE_TOOL_NAME,
  createCommunityMcpToolPort,
} from '../../../src/modules/mcp/community-mcp.js';
import type { McpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { McpApplicationToolResult } from '../../../src/modules/mcp/application-results.js';

const ACCOUNT = 'account-reader';
const SUBJECT = 'subject-reader';
const COLLECTION = 'col-1';
const HMAC_KEY = Buffer.alloc(32, 13);
const NOW = new Date('2026-10-03T10:00:00.000Z');
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};

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

function record(overrides: Partial<CommunityCommentRecord> = {}): CommunityCommentRecord {
  return {
    id: 'comment-1',
    target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
    targetGeneration: COMMUNITY_STATIC_GENERATION,
    rootId: 'comment-1', replyToId: null, depth: 0,
    authorAccountId: 'account-author', body: 'hello', state: 'visible',
    curationHidden: false,
    revision: 1n, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function commentQueryPorts(options: {
  resolvedNull?: boolean;
  roots?: readonly CommunityCommentRecord[];
  byId?: CommunityCommentRecord | null;
} = {}): CommunityCommentQueryPorts {
  const roots = options.roots ?? [record()];
  return {
    targets: {
      // The resolve query carries no generation — the authority answers with
      // the CURRENT one, which the application then compares against.
      resolve: async (query) => options.resolvedNull === true ? null : {
        target: {
          kind: query.kind, id: query.id,
          collectionId: query.collectionId ?? null, seriesId: query.seriesId ?? null,
          generation: COMMUNITY_STATIC_GENERATION,
        } as CommunityTarget,
        ownerSubjectId: 'subject-owner', title: 'T', href: '/t/1',
      },
      createdAt: async () => NOW,
    },
    curators: {
      // CS-04: the context subject is a reader, never the target owner.
      canCurate: async (_identity, subjectId) => subjectId === 'subject-owner',
    },
    comments: {
      findById: async () => options.byId === undefined ? record() : options.byId,
      scanRoots: async (_identity, _generation, after, limit) => roots
        .filter((row) => after === null || row.createdAt < (after as { createdAt: Date }).createdAt
          || (row.createdAt.getTime() === (after as { createdAt: Date }).createdAt.getTime()
            && row.id > (after as { id: string }).id))
        .slice(0, limit),
      scanDescendants: async (_rootId, _after, _limit) => [],
      countVisibleThreadReplies: async (ids) => new Map(ids.map((id) => [id, 0])),
      countVisibleDirectReplies: async (ids) => new Map(ids.map((id) => [id, 0])),
    },
    // CS-04: no curation overlay rows and no settings row in these tests.
    curations: { find: async () => null },
    settings: { find: async () => null },
    authors: {
      publicActors: async (ids) => new Map(
        ids.map((id) => [id, { handle: 'alice', displayName: 'Alice', avatarUrl: null }]),
      ),
    },
    clock: { now: async () => NOW },
  };
}

interface CommandEffects {
  lockedAccountId: string | null;
  inserted: CommunityCommentRecord[];
}

function commentCommandPorts(options: {
  claim?: Awaited<ReturnType<CommunityCommentCommandPorts['receipts']['claim']>>;
} = {}): { ports: CommunityCommentCommandPorts; effects: CommandEffects } {
  const effects: CommandEffects = { lockedAccountId: null, inserted: [] };
  return {
    effects,
    ports: {
      receipts: {
        claim: async () => options.claim ?? { kind: 'claimed' },
        complete: async () => undefined,
        purgeExpired: async () => 0,
        deletePrincipalReceipts: async () => 0,
      },
      actor: {
        lockActiveAccount: async (accountId) => {
          effects.lockedAccountId = accountId;
          return accountId === ACCOUNT ? { subjectId: SUBJECT } : null;
        },
      },
      targets: {
        lockResolved: async (identity) => ({
          target: { ...identity, generation: COMMUNITY_STATIC_GENERATION } as CommunityTarget,
          ownerSubjectId: 'subject-owner', title: 'T', href: '/t/1',
        }),
      },
      comments: {
        lockReplyTarget: async () => record({ id: 'comment-parent', rootId: 'comment-parent' }),
        insert: async (row) => { effects.inserted.push(row); },
      },
      authors: {
        publicActors: async (ids) => new Map(
          ids.map((id) => [id, { handle: 'alice', displayName: 'Alice', avatarUrl: null }]),
        ),
      },
      curators: {
        // CS-04: the context subject is a reader, never the target owner.
        canCurate: async (_identity, subjectId) => subjectId === 'subject-owner',
      },
      // No settings row: the comment area is unlocked for the create tests.
      settings: { find: async () => null },
      notifications: {
        // CS-05: owner resolves; appends are no-ops in the fake.
        ownerAccountId: async (ownerSubjectId) =>
          ownerSubjectId === 'subject-owner' ? 'account-owner' : null,
        append: async () => undefined,
      },
      ids: { next: () => 'comment-minted' },
      etags: { for: (comment) => communityCommentEtag(comment, HMAC_KEY) },
      audit: { append: async () => undefined },
      clock: { now: async () => NOW },
    },
  };
}

function port(input: {
  enabled?: boolean;
  query?: CommunityCommentQueryPorts;
  command?: CommunityCommentCommandPorts;
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
      commentQueryUnitOfWork: {
        execute: <Result>(work: (ports: CommunityCommentQueryPorts) => Promise<Result>,
          _options?: { readonly signal?: AbortSignal }) => work(input.query!),
      },
    } : {}),
    ...(input.command !== undefined ? {
      commentCommandUnitOfWork: {
        execute: <Result>(work: (ports: CommunityCommentCommandPorts) => Promise<Result>,
          _options?: { readonly signal?: AbortSignal }) => work(input.command!),
      },
    } : {}),
    ...(input.hmacKey !== undefined ? { commentCursorHmacKey: input.hmacKey } : {}),
  });
}

function structured(result: McpApplicationToolResult): unknown {
  assert.equal(result.kind, 'complete');
  return result.kind === 'complete' ? result.structuredContent : undefined;
}

function errorBody(result: McpApplicationToolResult): { code: string } {
  assert.equal(result.kind, 'complete');
  assert.equal(result.kind === 'complete' && result.isError, true);
  const body = structured(result) as { error: { code: string; message: string } };
  assert.deepEqual(Object.keys(body), ['error']);
  return body.error;
}

const listArgs = { query: { kind: 'collection', id: COLLECTION, generation: 'static-v1' } };
const createArgs = {
  body: { target: COLLECTION_TARGET, body: 'hi', replyToId: null },
  commandId: COMMAND_ID,
};

/* ——— listing and scopes ——— */

test('comment tools list only when query/command ports and the cursor key are composed', async () => {
  const ready = await port({ query: commentQueryPorts(), command: commentCommandPorts().ports, hmacKey: HMAC_KEY })
    .listTools(context(), undefined);
  assert.deepEqual(ready.map((tool) => tool.name).sort(), [
    COMMUNITY_MCP_COMMENTS_TOOL_NAME, COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME,
    COMMUNITY_MCP_COMMENT_GET_TOOL_NAME, COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
    COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME,
  ].sort());
  // No ranking ports composed: the ranking tool stays absent.
  assert.ok(!ready.some((tool) => tool.name === COMMUNITY_MCP_RANKING_TOOL_NAME));

  // No cursor key at all, or no query port: nothing comment-related lists.
  for (const partial of [
    port({ hmacKey: HMAC_KEY }),
    port({ query: commentQueryPorts() }),
    port({ command: commentCommandPorts().ports, hmacKey: HMAC_KEY }),
  ]) {
    const names = (await partial.listTools(context(), undefined)).map((tool) => tool.name);
    assert.deepEqual(names.sort(),
      [COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME].sort());
  }
  // Query port + key but no command port: the three reads list, create does
  // not — a half-composed surface never advertises a broken write tool.
  const readsOnly = await port({ query: commentQueryPorts(), hmacKey: HMAC_KEY })
    .listTools(context(), undefined);
  assert.deepEqual(readsOnly.map((tool) => tool.name).sort(), [
    COMMUNITY_MCP_COMMENTS_TOOL_NAME, COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
    COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
    COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME,
  ].sort());

  // Anonymous callers see the three reads but never the create tool.
  const anonymous = await port({ query: commentQueryPorts(), command: commentCommandPorts().ports, hmacKey: HMAC_KEY })
    .listTools(context({ authenticated: false }), undefined);
  assert.deepEqual(anonymous.map((tool) => tool.name).sort(), [
    COMMUNITY_MCP_COMMENTS_TOOL_NAME, COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
    COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME, COMMUNITY_MCP_TARGET_TOOL_NAME,
  ].sort());

  const disabled = await port({ enabled: false, query: commentQueryPorts(), command: commentCommandPorts().ports, hmacKey: HMAC_KEY })
    .listTools(context(), undefined);
  assert.deepEqual(disabled, []);
});

test('comment reads require product:read; create requires product:write', async () => {
  const tool = port({ query: commentQueryPorts(), command: commentCommandPorts().ports, hmacKey: HMAC_KEY });
  for (const name of [
    COMMUNITY_MCP_COMMENTS_TOOL_NAME, COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
    COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
  ]) {
    const denied = await tool.callTool(context({ scopes: ['product:write'] }), name,
      name === COMMUNITY_MCP_COMMENTS_TOOL_NAME ? listArgs : { path: { commentId: 'comment-1' } });
    assert.deepEqual(denied, { kind: 'rejected', stableCode: 'insufficient_scope',
      safeMessage: 'Insufficient scope.', retryable: false }, name);
  }
  for (const ctx of [
    context({ scopes: ['product:read'] }),
    context({ authenticated: false }),
  ]) {
    const denied = await tool.callTool(ctx, COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME, createArgs);
    assert.deepEqual(denied, { kind: 'rejected', stableCode: 'insufficient_scope',
      safeMessage: 'Insufficient scope.', retryable: false });
  }
});

/* ——— known.community.comments ——— */

test('known.community.comments returns the HTTP-identical page anonymously and to readers', async () => {
  const tool = port({ query: commentQueryPorts(), hmacKey: HMAC_KEY });
  for (const ctx of [context({ scopes: ['product:read'] }), context({ authenticated: false })]) {
    const result = await tool.callTool(ctx, COMMUNITY_MCP_COMMENTS_TOOL_NAME, listArgs);
    const page = structured(result) as {
      items: { id: string; depth: number; body: string | null }[];
      nextCursor: string | null;
    };
    assert.equal(result.isError, undefined);
    assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.id, 'comment-1');
    assert.equal(page.nextCursor, null);
  }
});

test('known.community.comments rejects closed-argument and query violations', async () => {
  const tool = port({ query: commentQueryPorts(), hmacKey: HMAC_KEY });
  for (const [args, code] of [
    [{ viewer: 'attacker' }, 'invalid_query'],
    [{ query: listArgs.query, actor: 'attacker' }, 'invalid_query'],
    [{ query: 'collection' }, 'invalid_query'],
    [{ query: { kind: 'collection', id: COLLECTION } }, 'invalid_query'],
    [{ query: { ...listArgs.query, extra: 'x' } }, 'invalid_query'],
    [{ query: { ...listArgs.query, limit: 0 } }, 'invalid_query'],
    [{ query: { ...listArgs.query, cursor: 'not a cursor!' } }, 'invalid_cursor'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENTS_TOOL_NAME, args);
    assert.equal(errorBody(result).code, code, JSON.stringify(args));
  }
});

test('known.community.comments maps concealment to the product error envelope', async () => {
  const tool = port({ query: commentQueryPorts({ resolvedNull: true }), hmacKey: HMAC_KEY });
  const result = await tool.callTool(context({ authenticated: false }),
    COMMUNITY_MCP_COMMENTS_TOOL_NAME, listArgs);
  assert.equal(errorBody(result).code, 'resource_not_found');
});

/* ——— known.community.comment.create ——— */

test('known.community.comment.create uses context identity, never argument fields', async () => {
  const { ports, effects } = commentCommandPorts();
  const tool = port({ query: commentQueryPorts(), command: ports, hmacKey: HMAC_KEY });
  const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME, {
    ...createArgs,
    body: { ...createArgs.body, body: 'hello from mcp' },
  });
  const created = structured(result) as { id: string; body: string; depth: number };
  assert.equal(created.id, 'comment-minted');
  assert.equal(created.body, 'hello from mcp');
  assert.equal(created.depth, 0);
  // The author lock proves the actor came from the MCP context, not args.
  assert.equal(effects.lockedAccountId, ACCOUNT);
  assert.equal(effects.inserted[0]!.authorAccountId, ACCOUNT);

  // Any actor/viewer/principal hint in the arguments is rejected by the
  // closed argument shape before the command runs: an unknown top-level key
  // is invalid_query, an unknown key inside `body` is invalid_request.
  for (const [args, code] of [
    [{ ...createArgs, actor: 'account-evil' }, 'invalid_query'],
    [{ ...createArgs, viewer: 'account-evil' }, 'invalid_query'],
    [{ body: { ...createArgs.body, actor: 'account-evil' }, commandId: COMMAND_ID }, 'invalid_request'],
  ] as const) {
    const rejected = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME, args);
    assert.equal(errorBody(rejected).code, code, JSON.stringify(args));
  }
});

test('known.community.comment.create validates body closure and command id', async () => {
  const tool = port({ command: commentCommandPorts().ports, hmacKey: HMAC_KEY });
  for (const [args, code] of [
    [{ commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: 'hi', commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { ...createArgs.body, extra: 1 }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { ...createArgs.body, body: '' }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { ...createArgs.body, body: 'x'.repeat(4_001) }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { ...createArgs.body, replyToId: 'bad id!' }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ ...createArgs, commandId: 'not-a-uuid' }, 'invalid_request'],
    [{ ...createArgs, commandId: COMMAND_ID.toUpperCase() }, 'invalid_request'],
  ] as const) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME, args);
    assert.equal(errorBody(result).code, code, JSON.stringify(args));
  }
});

test('known.community.comment.create maps receipt outcomes to product envelopes', async () => {
  const replay = {
    kind: 'replay' as const, status: 201,
    body: Buffer.from('{"id":"comment-9","state":"visible"}'),
    stableHeaders: { 'cache-control': 'private, no-store' },
    mediaType: 'application/json',
    contractVersion: COMMUNITY_COMMENT_COMMAND_CONTRACT_VERSION,
  };
  for (const [claim, expected] of [
    [{ kind: 'replay' as const, result: replay }, 'id'],
    [{ kind: 'reused' as const }, 'command_id_reused'],
    [{ kind: 'in_progress' as const, retryAfterSeconds: 2 }, 'command_in_progress'],
    [{ kind: 'expired' as const, resultDigest: null }, 'command_result_expired'],
  ] as const) {
    const tool = port({ command: commentCommandPorts({ claim }).ports, hmacKey: HMAC_KEY });
    const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME, createArgs);
    if (expected === 'id') {
      assert.equal((structured(result) as { id: string }).id, 'comment-9');
    } else {
      assert.equal(errorBody(result).code, expected);
    }
  }
});

/* ——— known.community.comment.get ——— */

test('known.community.comment.get returns the Comment or the concealed envelope', async () => {
  const tool = port({ query: commentQueryPorts(), hmacKey: HMAC_KEY });
  const result = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
    { path: { commentId: 'comment-1' } });
  const body = structured(result) as { id: string; depth: number; replyToId: string | null };
  assert.equal(body.id, 'comment-1');
  assert.equal(body.depth, 0);

  for (const [args, code] of [
    [{}, 'invalid_query'],
    [{ path: {} }, 'invalid_request'],
    [{ path: { commentId: 'bad id!' } }, 'invalid_request'],
    [{ path: { commentId: 'comment-1', extra: 1 } }, 'invalid_query'],
    [{ path: { commentId: 'comment-1' }, query: {} }, 'invalid_query'],
  ] as const) {
    const rejected = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_GET_TOOL_NAME, args);
    assert.equal(errorBody(rejected).code, code, JSON.stringify(args));
  }

  const concealed = port({ query: commentQueryPorts({ byId: null }), hmacKey: HMAC_KEY });
  const missing = await concealed.callTool(context(), COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
    { path: { commentId: 'comment-x' } });
  assert.equal(errorBody(missing).code, 'resource_not_found');
});

/* ——— known.community.comment.replies ——— */

test('known.community.comment.replies flattens descendants and binds the root path', async () => {
  const descendants = [
    record({ id: 'reply-1', depth: 1, rootId: 'comment-1', replyToId: 'comment-1',
      createdAt: new Date(NOW.getTime() + 1_000) }),
    record({ id: 'reply-2', depth: 2, rootId: 'comment-1', replyToId: 'reply-1',
      createdAt: new Date(NOW.getTime() + 2_000) }),
  ];
  const queryPorts = commentQueryPorts();
  queryPorts.comments.scanDescendants = async (rootId, after, limit) => descendants
    .filter((row) => row.rootId === rootId
      && (after === null || row.createdAt > (after as { createdAt: Date }).createdAt
        || (row.createdAt.getTime() === (after as { createdAt: Date }).createdAt.getTime()
          && row.id > (after as { id: string }).id)))
    .slice(0, limit);
  const tool = port({ query: queryPorts, hmacKey: HMAC_KEY });
  const first = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
    { path: { commentId: 'comment-1' }, query: { limit: 1 } });
  const page = structured(first) as { items: { id: string; replyToId: string }[]; nextCursor: string | null };
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.id, 'reply-1');
  assert.ok(page.nextCursor !== null);
  const second = await tool.callTool(context(), COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
    { path: { commentId: 'comment-1' }, query: { limit: 1, cursor: page.nextCursor! } });
  const page2 = structured(second) as { items: { id: string; replyToId: string }[]; nextCursor: string | null };
  assert.equal(page2.items[0]!.id, 'reply-2');
  assert.equal(page2.items[0]!.replyToId, 'reply-1');
  assert.equal(page2.nextCursor, null);

  // A non-root path id is invalid_request; a cursor from a different viewer
  // or root is invalid_cursor — all through the {error: {code}} envelope.
  const nonRoot = port({
    query: commentQueryPorts({ byId: record({ id: 'comment-2', depth: 1, replyToId: 'comment-1', rootId: 'comment-1' }) }),
    hmacKey: HMAC_KEY,
  });
  const nonRootResult = await nonRoot.callTool(context(), COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
    { path: { commentId: 'comment-2' } });
  assert.equal(errorBody(nonRootResult).code, 'invalid_request');
});

test('comment tools never read identity from arguments and errors stay product-shaped', async () => {
  const tool = port({ query: commentQueryPorts(), hmacKey: HMAC_KEY });
  // Domain errors thrown inside the unit of work map to the {error:{code}}
  // envelope — never an exception or a foreign shape.
  const failing = port({
    query: {
      ...commentQueryPorts(),
      targets: { resolve: async () => {
        throw new CommunityCommentError('resource_not_found', COMMUNITY_TARGET_CONCEALED_MESSAGE);
      } },
    },
    hmacKey: HMAC_KEY,
  });
  const result = await failing.callTool(context({ authenticated: false }),
    COMMUNITY_MCP_COMMENTS_TOOL_NAME, listArgs);
  assert.equal(errorBody(result).code, 'resource_not_found');
});
