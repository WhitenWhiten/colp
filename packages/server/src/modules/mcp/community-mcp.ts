/**
 * CS-01/CS-02/CS-03 community MCP compatibility tools (`known.community.target`,
 * `known.community.vote`, `known.community.ranking`,
 * `known.community.comments`, `known.community.comment.create`,
 * `known.community.comment.get`, `known.community.comment.replies`). A protocol-neutral
 * application tool port: the compat host mounts it behind
 * `/collections/-/mcp-compat` and the facade routes `known.community.*`
 * names here. There is no HTTP loopback and no arbitrary operation
 * dispatcher — each tool invokes the same application service and the same
 * PostgreSQL authority as the product HTTP routes.
 *
 * The CS-03 comment tools live in `community-comment-mcp.ts` (the shared
 * result/error envelope helpers in `community-mcp-shared.ts`) so this
 * module stays inside the source-size budget; the port factory composes
 * all descriptors behind one listing/dispatch.
 *
 * Identity comes only from the MCP context: anonymous principalId is
 * `public`, authenticated principalId is `accounts.id`, and the account
 * subject arrives via `context.authorization.accountSubjectId`. Actor
 * fields are never read from tool arguments.
 */
import {
  CommunityRankingError,
  CommunityTargetError,
  parseCommunityRankingQuery,
  parseCommunityTarget,
  parseCommunityTargetQuery,
  parseCommunityVoteValue,
  resolveCommunityTargetView,
  setCommunityVote,
  listCommunityRanking,
  createCommunityRankingCursorCodec,
  type CommunityCommentCommandPorts,
  type CommunityCommentManagePorts,
  type CommunityCommentQueryPorts,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationQueryPorts,
  type CommunityRankingQueryPorts,
  type CommunityTargetQueryPorts,
  type CommunityVoteCommandPorts,
  type CommunityVoteCommandResult,
  CommunityVoteCommandError,
} from '../community/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolPort } from './application-ports.js';
import type {
  McpApplicationToolDescriptor,
} from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';
import {
  COMMUNITY_COMMENT_MCP_TOOLS,
  COMMUNITY_MCP_COMMENTS_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
  callCommunityCommentTool,
  communityCommentToolAvailable,
  isCommunityCommentMcpTool,
} from './community-comment-mcp.js';
import {
  COMMUNITY_COMMENT_MANAGE_MCP_TOOLS,
  callCommunityCommentManageTool,
  communityCommentManageToolAvailable,
  isCommunityCommentManageMcpTool,
} from './community-comment-manage-mcp.js';
import {
  COMMUNITY_NOTIFICATION_MCP_TOOLS,
  callCommunityNotificationTool,
  communityNotificationToolAvailable,
  isCommunityNotificationMcpTool,
} from './community-notification-mcp.js';
import {
  COMMUNITY_MCP_COMMAND_ID,
  completeCommunityToolResult,
  communityToolProductError,
  mapCommunityToolError,
  rejectedCommunityTool,
} from './community-mcp-shared.js';
import {
  COMMUNITY_MCP_RANKING_INPUT,
  COMMUNITY_MCP_RANKING_PAGE_SCHEMA,
  COMMUNITY_MCP_TARGET_INPUT,
  COMMUNITY_MCP_TARGET_VIEW_SCHEMA,
  COMMUNITY_MCP_VOTE_INPUT,
  COMMUNITY_MCP_VOTE_STATE_SCHEMA,
  communityToolOutputSchema,
} from './community-mcp-schemas.js';
import { grantsScope } from './scope-implications.js';

export {
  COMMUNITY_MCP_COMMENTS_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
} from './community-comment-mcp.js';
export {
  COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME,
  COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME,
} from './community-comment-manage-mcp.js';
export {
  COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME,
  COMMUNITY_MCP_NOTIFICATIONS_READ_TOOL_NAME,
} from './community-notification-mcp.js';

export const COMMUNITY_MCP_TARGET_TOOL_NAME = 'known.community.target';
export const COMMUNITY_MCP_VOTE_TOOL_NAME = 'known.community.vote';
export const COMMUNITY_MCP_RANKING_TOOL_NAME = 'known.community.ranking';
export const COMMUNITY_MCP_READ_SCOPE = 'product:read';
export const COMMUNITY_MCP_WRITE_SCOPE = 'product:write';

const COMMUNITY_CORE_MCP_TOOLS: readonly McpApplicationToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: COMMUNITY_MCP_TARGET_TOOL_NAME,
    description: 'Resolve a live public community target (collection, bookmark, digest series, or digest edition) including its current generation and vote state.',
    inputSchema: COMMUNITY_MCP_TARGET_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_TARGET_VIEW_SCHEMA),
    requiredScopes: Object.freeze([COMMUNITY_MCP_READ_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_VOTE_TOOL_NAME,
    description: 'Set the authenticated account vote (-1, 0, or 1) on a community target; durable and idempotent on commandId.',
    inputSchema: COMMUNITY_MCP_VOTE_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_VOTE_STATE_SCHEMA),
    requiredScopes: Object.freeze([COMMUNITY_MCP_WRITE_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_RANKING_TOOL_NAME,
    description: 'List the durable hot-v1 community ranking snapshot with optional kind/tag/language/title filters and opaque cursor pagination; current visibility is rechecked on every page.',
    inputSchema: COMMUNITY_MCP_RANKING_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_RANKING_PAGE_SCHEMA),
    requiredScopes: Object.freeze([COMMUNITY_MCP_READ_SCOPE]),
    compatOnly: true,
  }),
]);

const COMMUNITY_MCP_TOOLS: readonly McpApplicationToolDescriptor[] = Object.freeze([
  ...COMMUNITY_CORE_MCP_TOOLS,
  ...COMMUNITY_COMMENT_MCP_TOOLS,
  ...COMMUNITY_COMMENT_MANAGE_MCP_TOOLS,
  ...COMMUNITY_NOTIFICATION_MCP_TOOLS,
]);

export const COMMUNITY_MCP_TOOL_NAMES: readonly string[] = Object.freeze(
  COMMUNITY_MCP_TOOLS.map((tool) => tool.name),
);

/**
 * The tools whose dispatch path explicitly accepts an anonymous principal.
 * Anonymous listing fails closed on this set — a tool not named here is
 * never advertised to anonymous callers, regardless of its requiredScopes.
 * Membership must mirror dispatch: every entry's call path accepts
 * `principal.kind === 'anonymous'` (read-scoped tools that still require an
 * authenticated account, like the notification inbox, stay out). Adding an
 * anonymous-callable tool means adding it here AND making its dispatch
 * accept anonymous principals — both directions are pinned by the
 * community-mcp-* unit tests.
 */
const COMMUNITY_MCP_ANONYMOUS_TOOLS: ReadonlySet<string> = new Set([
  COMMUNITY_MCP_TARGET_TOOL_NAME,
  COMMUNITY_MCP_RANKING_TOOL_NAME,
  COMMUNITY_MCP_COMMENTS_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
]);

export interface CommunityMcpToolPortOptions {
  /** KNOWN_FEATURE_COMMUNITY exposure; when false no tools list or dispatch. */
  readonly enabled: boolean;
  readonly targetQueryUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityTargetQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly voteCommandUnitOfWork: {
    execute<Result>(
      work: (ports: CommunityVoteCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-02 ranking snapshot query port + cursor key (production-composed). */
  readonly rankingQueryUnitOfWork?: {
    execute<Result>(
      work: (ports: CommunityRankingQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly rankingCursorHmacKey?: Buffer;
  /** CS-03 comment query port + cursor key (production-composed). */
  readonly commentQueryUnitOfWork?: {
    execute<Result>(
      work: (ports: CommunityCommentQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-03 comment create port (production-composed). */
  readonly commentCommandUnitOfWork?: {
    execute<Result>(
      work: (ports: CommunityCommentCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-04 comment manage port: author edit/delete + curator curation/settings. */
  readonly commentManageUnitOfWork?: {
    execute<Result>(
      work: (ports: CommunityCommentManagePorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly commentCursorHmacKey?: Buffer;
  /** CS-05 notification inbox query port + cursor key (production-composed). */
  readonly notificationQueryUnitOfWork?: {
    execute<Result>(
      work: (ports: CommunityNotificationQueryPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  /** CS-05 notification read/preference write port (production-composed). */
  readonly notificationCommandUnitOfWork?: {
    execute<Result>(
      work: (ports: CommunityNotificationCommandPorts) => Promise<Result>,
      options?: { readonly signal?: AbortSignal },
    ): Promise<Result>;
  };
  readonly notificationCursorHmacKey?: Buffer;
}

export function createCommunityMcpToolPort(
  options: CommunityMcpToolPortOptions,
): McpApplicationToolPort {
  return Object.freeze({
    listTools: async (context: McpApplicationContext) => {
      if (!options.enabled) return [];
      const rankingReady = options.rankingQueryUnitOfWork !== undefined
        && options.rankingCursorHmacKey !== undefined;
      const tools = COMMUNITY_MCP_TOOLS.filter((tool) => {
        if (tool.name === COMMUNITY_MCP_RANKING_TOOL_NAME) return rankingReady;
        if (isCommunityCommentMcpTool(tool.name)) {
          return communityCommentToolAvailable(options, tool.name);
        }
        if (isCommunityCommentManageMcpTool(tool.name)) {
          return communityCommentManageToolAvailable(options, tool.name);
        }
        if (isCommunityNotificationMcpTool(tool.name)) {
          return communityNotificationToolAvailable(options, tool.name);
        }
        return true;
      });
      if (context.principal.kind === 'anonymous') {
        // Fail closed: only the tools whose dispatch accepts an anonymous
        // principal are listed. Scope alone is not sufficient — e.g. the
        // read-scoped notification inbox requires an authenticated account.
        return tools.filter((tool) => COMMUNITY_MCP_ANONYMOUS_TOOLS.has(tool.name));
      }
      return tools.filter((tool) =>
        tool.requiredScopes.every((scope) => grantsScope(context.scopes, scope)));
    },
    callTool: async (
      context: McpApplicationContext,
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => {
      if (!options.enabled || !(COMMUNITY_MCP_TOOL_NAMES as readonly string[]).includes(name)) {
        return rejectedCommunityTool('unknown_tool', 'Unknown tool.');
      }
      try {
        if (name === COMMUNITY_MCP_TARGET_TOOL_NAME) {
          return await callTargetTool(options, context, args);
        }
        if (name === COMMUNITY_MCP_RANKING_TOOL_NAME) {
          return await callRankingTool(options, context, args);
        }
        if (isCommunityCommentMcpTool(name)) {
          return await callCommunityCommentTool(options, context, name, args);
        }
        if (isCommunityCommentManageMcpTool(name)) {
          return await callCommunityCommentManageTool(options, context, name, args);
        }
        if (isCommunityNotificationMcpTool(name)) {
          return await callCommunityNotificationTool(options, context, name, args);
        }
        return await callVoteTool(options, context, args);
      } catch (error) {
        return mapCommunityToolError(context, error);
      }
    },
  });
}

async function callTargetTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind === 'authenticated'
      && !grantsScope(context.scopes, COMMUNITY_MCP_READ_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  // Contract arguments: `{ query: <closed target variant> }` — the top-level
  // object and the query admit no other keys.
  for (const key of Object.keys(args)) {
    if (key !== 'query') {
      throw new CommunityTargetError('invalid_query', 'The community target arguments are invalid.');
    }
  }
  const rawQuery = args.query;
  if (typeof rawQuery !== 'object' || rawQuery === null || Array.isArray(rawQuery)) {
    throw new CommunityTargetError('invalid_query', 'The community target query is invalid.');
  }
  for (const key of Object.keys(rawQuery as Readonly<Record<string, unknown>>)) {
    if (!COMMUNITY_TARGET_QUERY_KEYS.includes(key as (typeof COMMUNITY_TARGET_QUERY_KEYS)[number])) {
      throw new CommunityTargetError('invalid_query', 'The community target query is invalid.');
    }
  }
  const query = parseCommunityTargetQuery(rawQuery as Readonly<Record<string, unknown>>);
  const authenticated = context.principal.kind === 'authenticated';
  const viewer = authenticated
    ? { accountId: context.principal.principalId, subjectId: requireMcpAccountSubjectId(context.authorization) }
    : { accountId: null, subjectId: null };
  const view = await options.targetQueryUnitOfWork.execute((ports) =>
    resolveCommunityTargetView(ports, { viewer, query }),
    { signal: context.abortSignal });
  return completeCommunityToolResult(view);
}

/** Union of the closed keys the four contract target-query variants permit. */
const COMMUNITY_TARGET_QUERY_KEYS = ['kind', 'id', 'collectionId', 'seriesId'] as const;

async function callVoteTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind !== 'authenticated'
      || !grantsScope(context.scopes, COMMUNITY_MCP_WRITE_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  // Contract arguments: `{ body: { target, value }, commandId }` — both
  // envelopes are closed; unknown keys are rejected, never ignored.
  for (const key of Object.keys(args)) {
    if (key !== 'body' && key !== 'commandId') {
      throw new CommunityVoteCommandError('invalid_request', 'The community vote arguments are invalid.');
    }
  }
  const body = args.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CommunityVoteCommandError('invalid_request', 'The community vote body is invalid.');
  }
  const bodyRecord = body as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(bodyRecord)) {
    if (key !== 'target' && key !== 'value') {
      throw new CommunityVoteCommandError('invalid_request', 'The community vote body is invalid.');
    }
  }
  const target = parseCommunityTarget(bodyRecord.target);
  const value = parseCommunityVoteValue(bodyRecord.value);
  const commandId = typeof args.commandId === 'string' && COMMUNITY_MCP_COMMAND_ID.test(args.commandId)
    ? args.commandId
    : (() => { throw new CommunityVoteCommandError('invalid_request', 'commandId must be a canonical UUID v4.'); })();
  const outcome = await options.voteCommandUnitOfWork.execute((ports) =>
    setCommunityVote(ports, {
      actor: {
        principalId: context.principal.principalId,
        subjectId: requireMcpAccountSubjectId(context.authorization),
      },
      target,
      value,
      commandId,
    }), { signal: context.abortSignal });
  return mapVoteOutcome(context, outcome);
}

async function callRankingTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind === 'authenticated'
      && !grantsScope(context.scopes, COMMUNITY_MCP_READ_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.rankingQueryUnitOfWork === undefined || options.rankingCursorHmacKey === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community ranking tool is not configured.');
  }
  // Closed arguments: only `query` is permitted; it must be an object.
  for (const key of Object.keys(args)) {
    if (key !== 'query') {
      throw new CommunityRankingError('invalid_query', 'The community ranking arguments are invalid.');
    }
  }
  const rawQuery = args.query;
  if (rawQuery !== undefined
      && (typeof rawQuery !== 'object' || rawQuery === null || Array.isArray(rawQuery))) {
    throw new CommunityRankingError('invalid_query', 'The community ranking query is invalid.');
  }
  const query = parseCommunityRankingQuery(
    (rawQuery ?? {}) as Readonly<Record<string, unknown>>,
  );
  const authenticated = context.principal.kind === 'authenticated';
  const viewer = authenticated
    ? { accountId: context.principal.principalId, subjectId: requireMcpAccountSubjectId(context.authorization) }
    : { accountId: null, subjectId: null };
  const page = await options.rankingQueryUnitOfWork.execute((ports) =>
    listCommunityRanking(ports, {
      viewer,
      query,
      cursorCodec: createCommunityRankingCursorCodec(options.rankingCursorHmacKey!),
    }),
    { signal: context.abortSignal });
  return completeCommunityToolResult(page);
}

function mapVoteOutcome(
  context: McpApplicationContext,
  outcome: CommunityVoteCommandResult,
): McpApplicationToolResult {
  if (outcome.kind === 'succeeded') {
    return completeCommunityToolResult({
      target: outcome.state.target,
      up: outcome.state.up,
      down: outcome.state.down,
      myVote: outcome.state.myVote,
    });
  }
  if (outcome.kind === 'replay') {
    const body = JSON.parse(Buffer.from(outcome.body).toString('utf8')) as unknown;
    return completeCommunityToolResult(body);
  }
  switch (outcome.kind) {
    case 'in_progress':
      return communityToolProductError(
        context, 'command_in_progress', 'A command with this id is still in progress.',
        { retryAfterSeconds: outcome.retryAfterSeconds },
      );
    case 'reused':
      return communityToolProductError(
        context, 'command_id_reused', 'This command id was already used with a different request.');
    default:
      return communityToolProductError(
        context, 'command_result_expired', 'The stored result for this command has expired.');
  }
}
