import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  COMMUNITY_STATIC_GENERATION,
  CommunityTargetError,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityTargetView,
  type CommunityVoteCommandPorts,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_MCP_TARGET_TOOL_NAME,
  COMMUNITY_MCP_VOTE_TOOL_NAME,
  createCommunityMcpToolPort,
} from '../../../src/modules/mcp/community-mcp.js';
import type { McpApplicationContext } from '../../../src/modules/mcp/application-context.js';
import type { McpApplicationToolResult } from '../../../src/modules/mcp/application-results.js';

const ACCOUNT = 'account-voter';
const SUBJECT = 'subject-voter';
const COLLECTION = 'collection-target';
const COMMAND_ID = '019fa956-0c4e-4190-94df-484c41fd9683';

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const RESOLVED: ResolvedCommunityTarget = {
  target: COLLECTION_TARGET, ownerSubjectId: 'subject-owner',
  title: 'Curated list', href: '/c/curated',
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

function port(input: {
  enabled?: boolean;
  resolve?: CommunityTargetQueryPorts['targets']['resolve'];
  readCounts?: CommunityTargetQueryPorts['votes']['readCounts'];
  areaLocked?: boolean;
  command?: (ports: CommunityVoteCommandPorts, input: unknown) => Promise<unknown>;
} = {}) {
  const queryPorts: CommunityTargetQueryPorts = {
    targets: { resolve: input.resolve ?? (async () => RESOLVED) },
    votes: {
      readCounts: input.readCounts ?? (async () => ({ up: 3, down: 1, myVote: 0 })),
    },
    curators: { canCurate: async () => false },
    settings: {
      find: async () => input.areaLocked === true
        ? Object.freeze({
          target: { kind: 'collection', id: COLLECTION, collectionId: null, seriesId: null },
          locked: true, reason: 'Locked', revision: 2n,
          updatedByAccountId: 'account-owner', updatedAt: new Date(0),
        })
        : null,
    },
  };
  return createCommunityMcpToolPort({
    enabled: input.enabled ?? true,
    targetQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityTargetQueryPorts) => Promise<Result>) => work(queryPorts),
    },
    voteCommandUnitOfWork: {
      execute: async <Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>) => {
        if (input.command !== undefined) {
          return await input.command({} as CommunityVoteCommandPorts, {}) as Result;
        }
        return work({} as CommunityVoteCommandPorts);
      },
    },
  });
}

function structured(result: McpApplicationToolResult): unknown {
  assert.equal(result.kind, 'complete');
  return result.kind === 'complete' ? result.structuredContent : undefined;
}

test('tool listing honors exposure, anonymity and required scopes', async () => {
  const open = port();
  const anonymous = await open.listTools(context({ authenticated: false }), undefined);
  assert.deepEqual(anonymous.map((tool) => tool.name), [COMMUNITY_MCP_TARGET_TOOL_NAME]);

  const readOnly = await open.listTools(context({ scopes: ['product:read'] }), undefined);
  assert.deepEqual(readOnly.map((tool) => tool.name), [COMMUNITY_MCP_TARGET_TOOL_NAME]);

  const writeOnly = await open.listTools(context({ scopes: ['product:write'] }), undefined);
  assert.deepEqual(writeOnly.map((tool) => tool.name), [COMMUNITY_MCP_VOTE_TOOL_NAME]);

  const both = await open.listTools(context(), undefined);
  assert.deepEqual(both.map((tool) => tool.name),
    [COMMUNITY_MCP_TARGET_TOOL_NAME, COMMUNITY_MCP_VOTE_TOOL_NAME]);

  const closed = port({ enabled: false });
  assert.deepEqual(await closed.listTools(context(), undefined), []);
});

test('unknown and disabled tools reject with the stable unknown_tool code', async () => {
  const open = port();
  const unknown = await open.callTool(context(), 'known.community.comment', {});
  assert.deepEqual(unknown, { kind: 'rejected', stableCode: 'unknown_tool',
    safeMessage: 'Unknown tool.', retryable: false });
  const closed = await port({ enabled: false }).callTool(context(), COMMUNITY_MCP_TARGET_TOOL_NAME,
    { query: { kind: 'collection', id: COLLECTION } });
  assert.equal(closed.kind, 'rejected');
});

test('known.community.target resolves anonymously and returns the exact HTTP body', async () => {
  const seen: { viewer?: { accountId: string | null; subjectId: string | null } } = {};
  const tool = port({
    resolve: async (query) => {
      assert.deepEqual(query, { kind: 'collection', id: COLLECTION });
      return RESOLVED;
    },
  });
  // Spy through the query port by re-creating with a viewer probe via readCounts.
  const result = await tool.callTool(context({ authenticated: false }),
    COMMUNITY_MCP_TARGET_TOOL_NAME, { query: { kind: 'collection', id: COLLECTION } });
  const body = structured(result) as CommunityTargetView;
  assert.equal(body.target.kind, 'collection');
  assert.equal(body.canVote, false);
  assert.equal(body.canComment, false);
  assert.equal(body.votes.myVote, 0);
  assert.equal(seen.viewer, undefined);
});

test('known.community.target enforces product:read for authenticated callers', async () => {
  const denied = await port().callTool(context({ scopes: ['product:write'] }),
    COMMUNITY_MCP_TARGET_TOOL_NAME, { query: { kind: 'collection', id: COLLECTION } });
  assert.deepEqual(denied, { kind: 'rejected', stableCode: 'insufficient_scope',
    safeMessage: 'Insufficient scope.', retryable: false });
});

test('known.community.target maps domain errors to product error bodies', async () => {
  const invalid = await port().callTool(context(), COMMUNITY_MCP_TARGET_TOOL_NAME,
    { query: { kind: 'unknown', id: 'x' } });
  const invalidBody = structured(invalid) as { error: { code: string } };
  assert.equal(invalid.isError, true);
  assert.equal(invalidBody.error.code, 'invalid_query');

  // The complete ProductErrorEnvelope lands in structuredContent and the text
  // JSON verbatim — every baseline field present, requestId from the context.
  assert.deepEqual(Object.keys(invalidBody.error).sort(), [
    'code', 'currentEtag', 'fieldErrors', 'message', 'precondition',
    'recovery', 'requestId', 'retryAfterSeconds', 'sameRequestRetrySafe',
  ].sort());
  const invalidError = invalidBody.error as unknown as Record<string, unknown>;
  assert.equal(invalidError.requestId, 'corr-1');
  assert.equal(invalidError.recovery, 'user_action');
  assert.equal(invalidError.sameRequestRetrySafe, false);
  assert.equal(invalidError.precondition, null);
  assert.equal(invalidError.currentEtag, null);
  assert.equal(invalidError.retryAfterSeconds, null);
  assert.deepEqual(invalidError.fieldErrors, []);
  const invalidText = (invalid as { content: { text: string }[] }).content[0]!.text;
  assert.deepEqual(JSON.parse(invalidText), invalidBody);

  const concealed = await port({ resolve: async () => null }).callTool(context(),
    COMMUNITY_MCP_TARGET_TOOL_NAME, { query: { kind: 'collection', id: COLLECTION } });
  const concealedBody = structured(concealed) as { error: { code: string; recovery: string } };
  assert.equal(concealedBody.error.code, 'resource_not_found');
  assert.equal(concealedBody.error.recovery, 'none');
});

test('known.community.target rejects unknown argument and query keys', async () => {
  const tool = port();
  for (const args of [
    { kind: 'collection', id: COLLECTION },
    { query: { kind: 'collection', id: COLLECTION }, extra: 1 },
    { query: { kind: 'collection', id: COLLECTION, generation: 'static-v1' } },
    { query: 'collection' },
    {},
  ]) {
    const result = await tool.callTool(context(), COMMUNITY_MCP_TARGET_TOOL_NAME, args);
    const body = structured(result) as { error: { code: string } };
    assert.equal(body.error.code, 'invalid_query', JSON.stringify(args));
  }
});

const voteArgs = { body: { target: { ...COLLECTION_TARGET }, value: 1 }, commandId: COMMAND_ID };

test('known.community.vote requires authentication and product:write', async () => {
  const anonymous = await port().callTool(context({ authenticated: false }),
    COMMUNITY_MCP_VOTE_TOOL_NAME, voteArgs);
  assert.equal(anonymous.kind, 'rejected');
  assert.equal(anonymous.kind === 'rejected' && anonymous.stableCode, 'insufficient_scope');

  const readOnly = await port().callTool(context({ scopes: ['product:read'] }),
    COMMUNITY_MCP_VOTE_TOOL_NAME, voteArgs);
  assert.equal(readOnly.kind === 'rejected' && readOnly.stableCode, 'insufficient_scope');
});

test('known.community.vote returns the vote state and forwards receipt outcomes', async () => {
  const succeeded = port({
    command: async () => ({
      kind: 'succeeded',
      state: { target: COLLECTION_TARGET, up: 4, down: 1, myVote: 1 },
    }),
  });
  const result = await succeeded.callTool(context(), COMMUNITY_MCP_VOTE_TOOL_NAME, voteArgs);
  assert.deepEqual(structured(result), {
    target: COLLECTION_TARGET, up: 4, down: 1, myVote: 1,
  });

  const replayBody = { target: COLLECTION_TARGET, up: 4, down: 1, myVote: 1 };
  const replayed = port({
    command: async () => ({
      kind: 'replay', status: 200,
      body: Buffer.from(JSON.stringify(replayBody)),
      stableHeaders: { 'cache-control': 'private, no-store' },
      mediaType: 'application/json', contractVersion: '1.0.0',
    }),
  });
  assert.deepEqual(structured(await replayed.callTool(context(), COMMUNITY_MCP_VOTE_TOOL_NAME,
    voteArgs)), replayBody);

  for (const [outcome, code, retryAfter] of [
    [{ kind: 'in_progress' as const, retryAfterSeconds: 1 }, 'command_in_progress', 1],
    [{ kind: 'reused' as const }, 'command_id_reused', null],
  ] as const) {
    const tool = port({ command: async () => outcome });
    const body = structured(await tool.callTool(context(), COMMUNITY_MCP_VOTE_TOOL_NAME,
      voteArgs)) as { error: { code: string; retryAfterSeconds: number | null; recovery: string } };
    assert.equal(body.error.code, code);
    assert.equal(body.error.retryAfterSeconds, retryAfter);
    if (code === 'command_in_progress') {
      assert.equal(body.error.recovery, 'same_request');
    }
  }
});

test('known.community.vote validates arguments and maps domain errors', async () => {
  for (const [args, code] of [
    // Flat pre-contract shape: `target`/`value` outside `body` are unknown keys.
    [{ target: { ...COLLECTION_TARGET }, value: 1, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { target: { kind: 'collection', id: 'x' }, value: 1 }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { target: { ...COLLECTION_TARGET }, value: 2 }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { target: { ...COLLECTION_TARGET }, value: 1, extra: 1 }, commandId: COMMAND_ID }, 'invalid_request'],
    [{ body: { target: { ...COLLECTION_TARGET }, value: 1 }, commandId: 'not-a-uuid' }, 'invalid_request'],
    [{ body: { target: { ...COLLECTION_TARGET }, value: 1 } }, 'invalid_request'],
    [{ body: 'v1', commandId: COMMAND_ID }, 'invalid_request'],
    [{ ...voteArgs, viewer: 'attacker' }, 'invalid_request'],
  ] as const) {
    const body = structured(
      await port().callTool(context(), COMMUNITY_MCP_VOTE_TOOL_NAME, args),
    ) as { error: { code: string } };
    assert.equal(body.error.code, code, JSON.stringify(args));
  }

  const conflicted = port({
    command: async () => {
      throw new CommunityTargetError('revision_conflict', 'stale');
    },
  });
  const body = structured(await conflicted.callTool(context(), COMMUNITY_MCP_VOTE_TOOL_NAME,
    voteArgs)) as { error: { code: string; recovery: string; precondition: string | null } };
  assert.equal(body.error.code, 'revision_conflict');
  assert.equal(body.error.recovery, 'refresh_and_retry');
  assert.equal(body.error.precondition, 'content');
});
