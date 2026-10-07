/**
 * CS-03 community comment MCP compatibility tools
 * (`known.community.comments`, `known.community.comment.create`,
 * `known.community.comment.get`, `known.community.comment.replies`).
 *
 * Each tool invokes the same application service and the same PostgreSQL
 * authority as the product HTTP routes — there is no HTTP loopback and no
 * arbitrary operation dispatcher. Identity comes only from the MCP
 * context: anonymous principalId is `public`, authenticated principalId is
 * `accounts.id`, and the account subject arrives via
 * `context.authorization.accountSubjectId`. Actor fields are never read
 * from tool arguments.
 */
import {
  COMMUNITY_COMMENTS_ENDPOINT,
  COMMUNITY_COMMENT_REPLIES_ENDPOINT,
  CommunityCommentError,
  createCommunityComment,
  createCommunityCommentCursorCodec,
  getCommunityComment,
  listCommunityCommentReplies,
  listCommunityComments,
  parseCommunityCommentCreateBody,
  parseCommunityCommentId,
  parseCommunityCommentRepliesQuery,
  parseCommunityCommentsQuery,
  type CommunityCommentCommandResult,
} from '../community/index.js';
import { requireMcpAccountSubjectId } from './account-context.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';
import {
  COMMUNITY_MCP_COMMAND_ID,
  completeCommunityToolResult,
  communityToolProductError,
  rejectedCommunityTool,
} from './community-mcp-shared.js';
import {
  COMMUNITY_MCP_COMMENT_CREATE_INPUT,
  COMMUNITY_MCP_COMMENT_GET_INPUT,
  COMMUNITY_MCP_COMMENT_PAGE_SCHEMA,
  COMMUNITY_MCP_COMMENT_REPLIES_INPUT,
  COMMUNITY_MCP_COMMENT_SCHEMA,
  COMMUNITY_MCP_COMMENTS_INPUT,
  communityToolOutputSchema,
} from './community-mcp-schemas.js';
import type { CommunityMcpToolPortOptions } from './community-mcp.js';
import { grantsScope } from './scope-implications.js';

export const COMMUNITY_MCP_COMMENTS_TOOL_NAME = 'known.community.comments';
export const COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME = 'known.community.comment.create';
export const COMMUNITY_MCP_COMMENT_GET_TOOL_NAME = 'known.community.comment.get';
export const COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME = 'known.community.comment.replies';

const READ_SCOPE = 'product:read';
const WRITE_SCOPE = 'product:write';

export const COMMUNITY_COMMENT_MCP_TOOLS: readonly McpApplicationToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: COMMUNITY_MCP_COMMENTS_TOOL_NAME,
    description: 'List root comments on a live public community target, createdAt-descending, with opaque cursor pagination; current target visibility and generation are rechecked on every page.',
    inputSchema: COMMUNITY_MCP_COMMENTS_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_PAGE_SCHEMA),
    requiredScopes: Object.freeze([READ_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME,
    description: 'Create a root comment or depth-limited reply on a public community target; durable and idempotent on commandId.',
    inputSchema: COMMUNITY_MCP_COMMENT_CREATE_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_SCHEMA),
    requiredScopes: Object.freeze([WRITE_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
    description: 'Read one community comment by id; concealed targets and superseded generations return the concealed resource_not_found.',
    inputSchema: COMMUNITY_MCP_COMMENT_GET_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_SCHEMA),
    requiredScopes: Object.freeze([READ_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
    description: 'List all flattened descendants of a root community comment, createdAt-ascending, with opaque cursor pagination; current visibility is rechecked on every page.',
    inputSchema: COMMUNITY_MCP_COMMENT_REPLIES_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_PAGE_SCHEMA),
    requiredScopes: Object.freeze([READ_SCOPE]),
    compatOnly: true,
  }),
]);

export const COMMUNITY_COMMENT_MCP_TOOL_NAMES: readonly string[] = Object.freeze(
  COMMUNITY_COMMENT_MCP_TOOLS.map((tool) => tool.name),
);

const COMMENT_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  COMMUNITY_MCP_COMMENTS_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_GET_TOOL_NAME,
  COMMUNITY_MCP_COMMENT_REPLIES_TOOL_NAME,
]);

export function isCommunityCommentMcpTool(name: string): boolean {
  return (COMMUNITY_COMMENT_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Composition readiness per tool: the three reads need the query port plus
 * the cursor HMAC key; the mutation additionally needs the command port.
 * A half-configured comment surface lists nothing rather than a broken tool.
 */
export function communityCommentToolAvailable(
  options: Pick<CommunityMcpToolPortOptions,
    'commentQueryUnitOfWork' | 'commentCommandUnitOfWork' | 'commentCursorHmacKey'>,
  name: string,
): boolean {
  const readsReady = options.commentQueryUnitOfWork !== undefined
    && options.commentCursorHmacKey !== undefined;
  if (name === COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME) {
    return readsReady && options.commentCommandUnitOfWork !== undefined;
  }
  return COMMENT_READ_TOOL_NAMES.has(name) && readsReady;
}

export async function callCommunityCommentTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (name === COMMUNITY_MCP_COMMENTS_TOOL_NAME) {
    return await callCommentsTool(options, context, args);
  }
  if (name === COMMUNITY_MCP_COMMENT_CREATE_TOOL_NAME) {
    return await callCommentCreateTool(options, context, args);
  }
  if (name === COMMUNITY_MCP_COMMENT_GET_TOOL_NAME) {
    return await callCommentGetTool(options, context, args);
  }
  return await callCommentRepliesTool(options, context, args);
}

function commentViewer(context: McpApplicationContext) {
  return context.principal.kind === 'authenticated'
    ? {
        accountId: context.principal.principalId,
        subjectId: requireMcpAccountSubjectId(context.authorization),
      }
    : { accountId: null, subjectId: null };
}

function commentArgsRecord(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!keys.includes(key)) {
      throw new CommunityCommentError('invalid_query', 'The community comment arguments are invalid.');
    }
  }
}

function commentPathCommentId(args: Readonly<Record<string, unknown>>): string {
  const path = args.path;
  if (typeof path !== 'object' || path === null || Array.isArray(path)) {
    throw new CommunityCommentError('invalid_query', 'The community comment path is invalid.');
  }
  const record = path as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (key !== 'commentId') {
      throw new CommunityCommentError('invalid_query', 'The community comment path is invalid.');
    }
  }
  return parseCommunityCommentId(record.commentId);
}

async function callCommentsTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind === 'authenticated'
      && !grantsScope(context.scopes, READ_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.commentQueryUnitOfWork === undefined || options.commentCursorHmacKey === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community comments tool is not configured.');
  }
  commentArgsRecord(args, ['query']);
  const rawQuery = args.query;
  if (typeof rawQuery !== 'object' || rawQuery === null || Array.isArray(rawQuery)) {
    throw new CommunityCommentError('invalid_query', 'The community comments query is invalid.');
  }
  const query = parseCommunityCommentsQuery(rawQuery as Readonly<Record<string, unknown>>);
  const page = await options.commentQueryUnitOfWork.execute((ports) =>
    listCommunityComments(ports, {
      viewer: commentViewer(context),
      query,
      cursorCodec: createCommunityCommentCursorCodec(
        options.commentCursorHmacKey!, COMMUNITY_COMMENTS_ENDPOINT),
    }),
    { signal: context.abortSignal });
  return completeCommunityToolResult(page);
}

async function callCommentCreateTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind !== 'authenticated'
      || !grantsScope(context.scopes, WRITE_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.commentCommandUnitOfWork === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community comment create tool is not configured.');
  }
  commentArgsRecord(args, ['body', 'commandId']);
  const parsed = parseCommunityCommentCreateBody(args.body);
  const commandId = typeof args.commandId === 'string' && COMMUNITY_MCP_COMMAND_ID.test(args.commandId)
    ? args.commandId
    : (() => { throw new CommunityCommentError('invalid_request', 'commandId must be a canonical UUID v4.'); })();
  const outcome = await options.commentCommandUnitOfWork.execute((ports) =>
    createCommunityComment(ports, {
      actor: {
        principalId: context.principal.principalId,
        subjectId: requireMcpAccountSubjectId(context.authorization),
      },
      target: parsed.target,
      body: parsed.body,
      replyToId: parsed.replyToId,
      commandId,
    }), { signal: context.abortSignal });
  return mapCommentOutcome(context, outcome);
}

async function callCommentGetTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind === 'authenticated'
      && !grantsScope(context.scopes, READ_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.commentQueryUnitOfWork === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community comment get tool is not configured.');
  }
  commentArgsRecord(args, ['path']);
  const commentId = commentPathCommentId(args);
  const comment = await options.commentQueryUnitOfWork.execute((ports) =>
    getCommunityComment(ports, { viewer: commentViewer(context), commentId }),
    { signal: context.abortSignal });
  return completeCommunityToolResult(comment);
}

async function callCommentRepliesTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind === 'authenticated'
      && !grantsScope(context.scopes, READ_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.commentQueryUnitOfWork === undefined || options.commentCursorHmacKey === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community comment replies tool is not configured.');
  }
  commentArgsRecord(args, ['path', 'query']);
  const commentId = commentPathCommentId(args);
  const rawQuery = args.query;
  if (rawQuery !== undefined
      && (typeof rawQuery !== 'object' || rawQuery === null || Array.isArray(rawQuery))) {
    throw new CommunityCommentError('invalid_query', 'The community comment replies query is invalid.');
  }
  const query = parseCommunityCommentRepliesQuery(
    (rawQuery ?? {}) as Readonly<Record<string, unknown>>,
  );
  const page = await options.commentQueryUnitOfWork.execute((ports) =>
    listCommunityCommentReplies(ports, {
      viewer: commentViewer(context),
      commentId,
      query,
      cursorCodec: createCommunityCommentCursorCodec(
        options.commentCursorHmacKey!, COMMUNITY_COMMENT_REPLIES_ENDPOINT),
    }),
    { signal: context.abortSignal });
  return completeCommunityToolResult(page);
}

function mapCommentOutcome(
  context: McpApplicationContext,
  outcome: CommunityCommentCommandResult,
): McpApplicationToolResult {
  if (outcome.kind === 'succeeded') {
    return completeCommunityToolResult(outcome.comment);
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
