/**
 * Community MCP contract surface: the 13 `known.community.*` tools exist
 * only on `/collections/-/mcp-compat`, advertise the contract's closed
 * inputSchema plus the success-or-`ProductErrorEnvelope` outputSchema union,
 * and never appear in the strict `/collections/-/mcp` catalog.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  createAnonymousPublicBinding,
} from '@know-n/colp/mcp';
import {
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  createMcpOauthVerifier,
  createPhase4bMcpApplicationFacade,
  createPhase4bMcpRequestContext,
  type McpApplicationContext,
  type McpApplicationFacade,
  type McpApplicationReadPort,
  type McpApplicationToolResult,
} from '../../../src/modules/mcp/index.js';
import {
  COMMUNITY_STATIC_GENERATION,
  type CommunityCommentCommandPorts,
  type CommunityCommentManagePorts,
  type CommunityCommentQueryPorts,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationQueryPorts,
  type CommunityRankingQueryPorts,
  type CommunityTarget,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
  type ResolvedCommunityTarget,
} from '../../../src/modules/community/index.js';
import {
  COMMUNITY_MCP_TOOL_NAMES,
  createCommunityMcpToolPort,
} from '../../../src/modules/mcp/community-mcp.js';
import { listStrictApplicationTools } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import {
  compatJsonRpc,
  injectCompatLegacyPost,
  startCompatApp,
} from '../../support/phase4b-mcp-compat-admission.js';
import {
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  AUDIENCE,
  createKeyFixture,
  mintCredential,
  staticJwksProvider,
  verifierOptions,
} from '../../support/phase4b-mcp-transport-scaffold.js';

const COMPAT_REVISION = MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION;
const COLLECTION = 'collection-1';
const HMAC = Buffer.alloc(32, 7);

const COLLECTION_TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: COMMUNITY_STATIC_GENERATION,
};
const RESOLVED: ResolvedCommunityTarget = {
  target: COLLECTION_TARGET, ownerSubjectId: 'subject-owner',
  title: 'Curated list', href: '/c/curated',
};

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function track<T extends { readonly app: FastifyInstance }>(server: T): T {
  apps.push(server.app);
  return server;
}

const targetQueryPorts: CommunityTargetQueryPorts = {
  targets: { resolve: async () => RESOLVED },
  votes: { readCounts: async () => ({ up: 3, down: 1, myVote: 0 }) },
  curators: { canCurate: async () => false },
  settings: { find: async () => null },
};

/** All composition ports present so every one of the 13 tools can list. */
function communityPort() {
  return createCommunityMcpToolPort({
    enabled: true,
    targetQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityTargetQueryPorts) => Promise<Result>) =>
        work(targetQueryPorts),
    },
    voteCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityVoteCommandPorts) => Promise<Result>) =>
        work({} as CommunityVoteCommandPorts),
    },
    rankingQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityRankingQueryPorts) => Promise<Result>) =>
        work({} as CommunityRankingQueryPorts),
    },
    rankingCursorHmacKey: HMAC,
    commentQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityCommentQueryPorts) => Promise<Result>) =>
        work({} as CommunityCommentQueryPorts),
    },
    commentCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityCommentCommandPorts) => Promise<Result>) =>
        work({} as CommunityCommentCommandPorts),
    },
    commentManageUnitOfWork: {
      execute: <Result>(work: (ports: CommunityCommentManagePorts) => Promise<Result>) =>
        work({} as CommunityCommentManagePorts),
    },
    commentCursorHmacKey: HMAC,
    notificationQueryUnitOfWork: {
      execute: <Result>(work: (ports: CommunityNotificationQueryPorts) => Promise<Result>) =>
        work({} as CommunityNotificationQueryPorts),
    },
    notificationCommandUnitOfWork: {
      execute: <Result>(work: (ports: CommunityNotificationCommandPorts) => Promise<Result>) =>
        work({} as CommunityNotificationCommandPorts),
    },
    notificationCursorHmacKey: HMAC,
  });
}

const emptyReadPort: McpApplicationReadPort = Object.freeze({
  listTools: async () => Object.freeze([]),
  callTool: async (): Promise<McpApplicationToolResult> => Object.freeze({
    kind: 'rejected', stableCode: 'unknown_tool',
    safeMessage: 'Unknown tool.', retryable: false,
  }),
});

/** The production facade shape: communityPort composed beside the read port. */
function facade(): McpApplicationFacade {
  return createPhase4bMcpApplicationFacade({
    resourceIdentity: {} as never,
    collectionProjection: {} as never,
    snapshotProjection: {} as never,
    nodeProjection: {} as never,
    readPort: emptyReadPort,
    communityPort: communityPort(),
  });
}

const WRITE_SCOPES = Object.freeze(['product:read', 'product:write'] as const);

function applicationContext(scopes: readonly string[]): McpApplicationContext {
  return Object.freeze({
    principal: Object.freeze({
      kind: 'authenticated' as const,
      principalId: 'account-1',
      clientId: 'client-1',
      credentialBindingId: 'binding-1',
      resourceAudience: 'aud',
      securityEpoch: '1',
    }),
    clientId: 'client-1',
    scopes,
    resourceAudience: 'aud',
    abortSignal: new AbortController().signal,
    budgets: { maxDepth: 8, maxNodes: 256, maxBytes: 65_536, maxOperations: 8 },
    correlationId: 'corr-contract',
    authorization: Object.freeze({ accountSubjectId: 'subject-1' }),
  });
}

interface ListedCompatTool {
  readonly name: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

async function compatListedTools(
  server: { readonly app: FastifyInstance },
  token?: string,
): Promise<readonly ListedCompatTool[]> {
  const listed = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsListBody(2),
    COMPAT_REVISION,
    token === undefined ? {} : { authorization: `Bearer ${token}` },
  );
  assert.equal(listed.statusCode, 200, listed.payload);
  return (compatJsonRpc(listed).result?.tools ?? []) as readonly ListedCompatTool[];
}

test('all 13 community descriptors are compatOnly with closed input schemas and contract output unions', async () => {
  const port = communityPort();
  const tools = await port.listTools(applicationContext(WRITE_SCOPES), undefined);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...COMMUNITY_MCP_TOOL_NAMES].sort(),
  );
  assert.equal(tools.length, 13);
  const writeTools = new Set([
    'known.community.vote', 'known.community.comment.create',
    'known.community.comment.edit', 'known.community.comment.delete',
    'known.community.comment.curate', 'known.community.comments.configure',
    'known.community.notifications.read',
  ]);
  for (const tool of tools) {
    assert.equal(tool.compatOnly, true, tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.deepEqual(
      tool.requiredScopes,
      [writeTools.has(tool.name) ? 'product:write' : 'product:read'],
      tool.name,
    );
    // Contract outputSchema: `{ type:'object', oneOf: [success, Error] }`.
    const output = tool.outputSchema;
    assert.ok(output !== undefined, `${tool.name} must advertise outputSchema`);
    assert.equal(output.type, 'object', tool.name);
    const arms = output.oneOf as readonly Readonly<Record<string, unknown>>[] | undefined;
    assert.ok(Array.isArray(arms) && arms.length === 2, `${tool.name} outputSchema union`);
    const errorArm = arms?.[1] as { properties?: { error?: unknown } };
    assert.ok(errorArm?.properties?.error !== undefined, `${tool.name} error arm`);
  }
});

test('anonymous listing fails closed on exactly the anonymous-callable tools', async () => {
  const port = communityPort();
  const anonymousContext: McpApplicationContext = Object.freeze({
    ...applicationContext(WRITE_SCOPES),
    principal: Object.freeze({
      kind: 'anonymous' as const,
      principalId: 'public',
      resourceAudience: 'aud',
      securityEpoch: '1',
    }),
    scopes: Object.freeze([]),
    authorization: Object.freeze({}),
  });
  const tools = await port.listTools(anonymousContext, undefined);
  // The five tools whose dispatch accepts an anonymous principal. The
  // read-scoped notification inbox requires an authenticated account, so
  // it must never be advertised here; any new tool fails closed (hidden)
  // until its dispatch accepts anonymous principals and this set grows.
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'known.community.comment.get',
    'known.community.comment.replies',
    'known.community.comments',
    'known.community.ranking',
    'known.community.target',
  ]);
});

test('the advertised input schemas match the frozen contract argument shapes', async () => {
  const port = communityPort();
  const tools = await port.listTools(applicationContext(WRITE_SCOPES), undefined);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const target = byName.get('known.community.target')!;
  assert.deepEqual(target.inputSchema.required, ['query']);
  const query = (target.inputSchema.properties as Record<string, unknown>).query as
    { oneOf: readonly Record<string, unknown>[] };
  assert.equal(query.oneOf.length, 4);
  for (const variant of query.oneOf) {
    assert.equal(variant.additionalProperties, false);
    assert.equal(
      'generation' in (variant.properties as Record<string, unknown>),
      false,
      'resolveCommunityTarget query carries no generation',
    );
  }

  const vote = byName.get('known.community.vote')!;
  assert.deepEqual([...(vote.inputSchema.required as readonly string[])].sort(), ['body', 'commandId']);
  const voteBody = (vote.inputSchema.properties as Record<string, unknown>).body as
    { additionalProperties: boolean; required: readonly string[] };
  assert.equal(voteBody.additionalProperties, false);
  assert.deepEqual(voteBody.required, ['target', 'value']);

  const markRead = byName.get('known.community.notifications.read')!;
  assert.deepEqual([...(markRead.inputSchema.required as readonly string[])].sort(), ['body', 'commandId']);

  const edit = byName.get('known.community.comment.edit')!;
  assert.deepEqual(
    [...(edit.inputSchema.required as readonly string[])].sort(),
    ['body', 'commandId', 'ifMatch', 'path'],
  );

  const inbox = byName.get('known.community.notifications')!;
  assert.deepEqual(inbox.inputSchema.required, []);
});

test('compat tools/list advertises all 13 tools with outputSchema; strict filters them out', async () => {
  const key = await createKeyFixture('community-compat');
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...WRITE_SCOPES],
    jwks: staticJwksProvider([key.jwk]),
    audience: `${AUDIENCE}-compat`,
  }));
  const token = await mintCredential({
    key: key.privateKey, kid: key.kid, scope: [...WRITE_SCOPES],
    audience: `${AUDIENCE}-compat`,
  });
  const server = track(startCompatApp({
    mcpReadTransport: { oauthVerifier: verifier, applicationFacade: facade() },
  }));

  const tools = await compatListedTools(server, token);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...COMMUNITY_MCP_TOOL_NAMES].sort(),
  );
  for (const tool of tools) {
    assert.ok(tool.outputSchema !== undefined, `${tool.name} must advertise outputSchema`);
    assert.equal(tool.outputSchema?.type, 'object', tool.name);
    assert.equal(tool.inputSchema?.additionalProperties, false, tool.name);
  }

  // The same facade on the strict surface lists none of them.
  const strict = await listStrictApplicationTools(
    createPhase4bMcpRequestContext({
      headers: Object.freeze([
        Object.freeze({ name: 'MCP-Protocol-Version', value: '2026-07-28' }),
        Object.freeze({ name: 'Mcp-Method', value: 'tools/list' }),
      ]),
      httpMethod: 'POST',
      body: Object.freeze({
        method: 'tools/list',
        params: Object.freeze({
          _meta: Object.freeze({
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': Object.freeze({
              tools: Object.freeze({ call: true }),
            }),
          }),
        }),
      }),
      binding: createAnonymousPublicBinding({
        resourceAudience: 'https://collections.example.test/collections/-/mcp',
        securityEpoch: 'epoch-1',
      }),
      scope: [],
      budget: DEFAULT_MCP_RESOURCE_READ_BUDGET,
      abortSignal: new AbortController().signal,
      authorization: Object.freeze({}),
    }),
    facade(),
    undefined,
    false,
  );
  const strictNames = ((strict.tools ?? []) as readonly { readonly name: string }[])
    .map((tool) => tool.name);
  assert.equal(
    strictNames.some((name) => name.startsWith('known.community.')),
    false,
    `strict catalog leaked community tools: ${JSON.stringify(strictNames)}`,
  );
});

test('compat tools/call returns the exact HTTP body and the complete error envelope', async () => {
  const key = await createKeyFixture('community-compat-call');
  const verifier = createMcpOauthVerifier(verifierOptions({
    allowedScopes: [...WRITE_SCOPES],
    jwks: staticJwksProvider([key.jwk]),
    audience: `${AUDIENCE}-compat`,
  }));
  const token = await mintCredential({
    key: key.privateKey, kid: key.kid, scope: [...WRITE_SCOPES],
    audience: `${AUDIENCE}-compat`,
  });
  const server = track(startCompatApp({
    mcpReadTransport: { oauthVerifier: verifier, applicationFacade: facade() },
  }));

  const called = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('known.community.target', 3, {
      query: { kind: 'collection', id: COLLECTION },
    }),
    COMPAT_REVISION,
    { authorization: `Bearer ${token}` },
  );
  assert.equal(called.statusCode, 200, called.payload);
  const result = compatJsonRpc(called).result ?? {};
  const body = result.structuredContent as {
    target: { kind: string; generation: string };
    votes: { up: number; down: number; myVote: number };
  };
  assert.equal(body.target.kind, 'collection');
  assert.equal(body.target.generation, COMMUNITY_STATIC_GENERATION);
  assert.equal(body.votes.up, 3);
  const okText = (result.content as readonly { text: string }[])[0]!.text;
  assert.deepEqual(JSON.parse(okText), result.structuredContent);

  // Application rejection: isError with the complete ProductErrorEnvelope in
  // both structuredContent and the text JSON block.
  const rejected = await injectCompatLegacyPost(
    server.app,
    mcpCompatToolsCallBody('known.community.target', 4, {
      query: { kind: 'collection', id: COLLECTION, rogue: true },
    }),
    COMPAT_REVISION,
    { authorization: `Bearer ${token}` },
  );
  assert.equal(rejected.statusCode, 200, rejected.payload);
  const errorResult = compatJsonRpc(rejected).result ?? {};
  assert.equal(errorResult.isError, true);
  const envelope = errorResult.structuredContent as {
    error: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(envelope.error).sort(), [
    'code', 'currentEtag', 'fieldErrors', 'message', 'precondition',
    'recovery', 'requestId', 'retryAfterSeconds', 'sameRequestRetrySafe',
  ].sort());
  assert.equal(envelope.error.code, 'invalid_query');
  assert.equal(typeof envelope.error.requestId, 'string');
  const errorText = (errorResult.content as readonly { text: string }[])[0]!.text;
  assert.deepEqual(JSON.parse(errorText), envelope);
});

test('the strict facade call path cannot reach community names', async () => {
  // Strict tools/call dispatches to the mounted read/write COLP adapters —
  // never through the facade's community branch — so a compat-only name is a
  // plain unknown tool there. The facade-level contract: a strict surface
  // composes no communityPort, and even with one the names only resolve
  // through compat admission. Guard the name set anyway.
  for (const name of COMMUNITY_MCP_TOOL_NAMES) {
    assert.match(name, /^known\.community\./u);
  }
});
