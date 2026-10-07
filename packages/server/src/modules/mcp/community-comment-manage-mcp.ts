/**
 * CS-04 community comment management MCP compatibility tools
 * (`known.community.comment.edit`, `known.community.comment.delete`,
 * `known.community.comment.curate`, `known.community.comments.configure`).
 *
 * Each tool invokes the same application command and the same PostgreSQL
 * authority as the product HTTP routes — there is no HTTP loopback and no
 * arbitrary operation dispatcher. Identity comes only from the MCP
 * context (`context.principal.principalId` = accounts.id plus
 * `context.authorization.accountSubjectId`); actor fields are never read
 * from tool arguments. The frozen schemas mirror the HTTP contract:
 * `{path:{commentId}, body, commandId, ifMatch}` — `ifMatch` carries the
 * operation's OWN ETag domain (comment revision tag for edit/delete, the
 * independent curation tag for curate, the independent settings tag for
 * configure).
 */
import {
  CommunityCommentError,
  deleteCommunityComment,
  editCommunityComment,
  parseCommunityCommentId,
  setCommentCuration,
  setCommunityCommentSettings,
  type CommunityCommentManageResult,
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
  COMMUNITY_MCP_COMMENT_CURATE_INPUT,
  COMMUNITY_MCP_COMMENT_DELETE_INPUT,
  COMMUNITY_MCP_COMMENT_EDIT_INPUT,
  COMMUNITY_MCP_COMMENT_SCHEMA,
  COMMUNITY_MCP_COMMENT_SETTINGS_SCHEMA,
  COMMUNITY_MCP_COMMENTS_CONFIGURE_INPUT,
  COMMUNITY_MCP_CURATION_SCHEMA,
  communityToolOutputSchema,
} from './community-mcp-schemas.js';
import type { CommunityMcpToolPortOptions } from './community-mcp.js';
import { grantsScope } from './scope-implications.js';

export const COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME = 'known.community.comment.edit';
export const COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME = 'known.community.comment.delete';
export const COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME = 'known.community.comment.curate';
export const COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME = 'known.community.comments.configure';

const WRITE_SCOPE = 'product:write';

export const COMMUNITY_COMMENT_MANAGE_MCP_TOOLS: readonly McpApplicationToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME,
    description: "Edit the authenticated author's community comment body; conditional on the comment's own If-Match ETag and idempotent on commandId.",
    inputSchema: COMMUNITY_MCP_COMMENT_EDIT_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_SCHEMA),
    requiredScopes: Object.freeze([WRITE_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME,
    description: "Permanently soft-delete the authenticated author's community comment; returns the tombstone, preserves the reply tree, conditional on the comment's own If-Match ETag and idempotent on commandId.",
    inputSchema: COMMUNITY_MCP_COMMENT_DELETE_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_SCHEMA),
    requiredScopes: Object.freeze([WRITE_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME,
    description: 'Hide or unhide a community comment through the per-comment curation overlay (target owner/editor only); conditional on the independent curation If-Match ETag and idempotent on commandId.',
    inputSchema: COMMUNITY_MCP_COMMENT_CURATE_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_CURATION_SCHEMA),
    requiredScopes: Object.freeze([WRITE_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_COMMENTS_CONFIGURE_TOOL_NAME,
    description: 'Lock or unlock the comment area of a community target (target owner/editor only, generation-independent); conditional on the independent settings If-Match ETag and idempotent on commandId.',
    inputSchema: COMMUNITY_MCP_COMMENTS_CONFIGURE_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_COMMENT_SETTINGS_SCHEMA),
    requiredScopes: Object.freeze([WRITE_SCOPE]),
    compatOnly: true,
  }),
]);

export const COMMUNITY_COMMENT_MANAGE_MCP_TOOL_NAMES: readonly string[] = Object.freeze(
  COMMUNITY_COMMENT_MANAGE_MCP_TOOLS.map((tool) => tool.name),
);

export function isCommunityCommentManageMcpTool(name: string): boolean {
  return (COMMUNITY_COMMENT_MANAGE_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** All four CS-04 tools dispatch through the one manage write port. */
export function communityCommentManageToolAvailable(
  options: Pick<CommunityMcpToolPortOptions, 'commentManageUnitOfWork'>,
  name: string,
): boolean {
  return isCommunityCommentManageMcpTool(name) && options.commentManageUnitOfWork !== undefined;
}

export async function callCommunityCommentManageTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind !== 'authenticated'
      || !grantsScope(context.scopes, WRITE_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.commentManageUnitOfWork === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community comment management tool is not configured.');
  }
  const actor = {
    principalId: context.principal.principalId,
    subjectId: requireMcpAccountSubjectId(context.authorization),
  } as const;
  switch (name) {
    case COMMUNITY_MCP_COMMENT_EDIT_TOOL_NAME:
      return await callCommentEditTool(options, context, actor, args);
    case COMMUNITY_MCP_COMMENT_DELETE_TOOL_NAME:
      return await callCommentDeleteTool(options, context, actor, args);
    case COMMUNITY_MCP_COMMENT_CURATE_TOOL_NAME:
      return await callCommentCurateTool(options, context, actor, args);
    default:
      return await callCommentsConfigureTool(options, context, actor, args);
  }
}

function manageArgsRecord(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): void {
  for (const key of Object.keys(args)) {
    if (!keys.includes(key)) {
      throw new CommunityCommentError('invalid_query', 'The community comment arguments are invalid.');
    }
  }
}

function managePathCommentId(args: Readonly<Record<string, unknown>>): string {
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

function manageCommandId(value: unknown): string {
  if (typeof value !== 'string' || !COMMUNITY_MCP_COMMAND_ID.test(value)) {
    throw new CommunityCommentError('invalid_request', 'commandId must be a canonical UUID v4.');
  }
  return value;
}

function manageIfMatch(value: unknown): string {
  if (typeof value !== 'string' || !/^"[^"\r\n]+"$/u.test(value)) {
    throw new CommunityCommentError('invalid_request', 'If-Match must be a single strong entity-tag.');
  }
  return value;
}

/** Closed `body` argument: an object with exactly the allowed keys. */
function closedBodyField(
  value: unknown,
  keys: readonly string[],
  message = 'The community comment body is invalid.',
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommunityCommentError('invalid_request', message);
  }
  const record = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new CommunityCommentError('invalid_request', message);
    }
  }
  return record;
}

type ManageActor = Readonly<{ principalId: string; subjectId: string }>;

async function callCommentEditTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  actor: ManageActor,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  manageArgsRecord(args, ['path', 'body', 'commandId', 'ifMatch']);
  const outcome = await options.commentManageUnitOfWork!.execute((ports) =>
    editCommunityComment(ports, {
      actor,
      commentId: managePathCommentId(args),
      // `body` is the closed EditComment object; the command unwraps and
      // re-validates the body field itself.
      body: closedBodyField(args.body, ['body']).body,
      ifMatch: manageIfMatch(args.ifMatch),
      commandId: manageCommandId(args.commandId),
    }), { signal: context.abortSignal });
  return mapManageOutcome(context, outcome);
}

async function callCommentDeleteTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  actor: ManageActor,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  manageArgsRecord(args, ['path', 'commandId', 'ifMatch']);
  const outcome = await options.commentManageUnitOfWork!.execute((ports) =>
    deleteCommunityComment(ports, {
      actor,
      commentId: managePathCommentId(args),
      ifMatch: manageIfMatch(args.ifMatch),
      commandId: manageCommandId(args.commandId),
    }), { signal: context.abortSignal });
  return mapManageOutcome(context, outcome);
}

async function callCommentCurateTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  actor: ManageActor,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  manageArgsRecord(args, ['path', 'body', 'commandId', 'ifMatch']);
  const fields = closedBodyField(
    args.body, ['hidden', 'reason'], 'The comment curation body is invalid.');
  const outcome = await options.commentManageUnitOfWork!.execute((ports) =>
    setCommentCuration(ports, {
      actor,
      commentId: managePathCommentId(args),
      hidden: fields.hidden,
      reason: fields.reason,
      ifMatch: manageIfMatch(args.ifMatch),
      commandId: manageCommandId(args.commandId),
    }), { signal: context.abortSignal });
  return mapManageOutcome(context, outcome);
}

async function callCommentsConfigureTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  actor: ManageActor,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  manageArgsRecord(args, ['body', 'commandId', 'ifMatch']);
  const fields = closedBodyField(
    args.body, ['target', 'locked', 'reason'], 'The community comment settings body is invalid.');
  const outcome = await options.commentManageUnitOfWork!.execute((ports) =>
    setCommunityCommentSettings(ports, {
      actor,
      target: fields.target,
      locked: fields.locked,
      reason: fields.reason,
      ifMatch: manageIfMatch(args.ifMatch),
      commandId: manageCommandId(args.commandId),
    }), { signal: context.abortSignal });
  return mapManageOutcome(context, outcome);
}

function mapManageOutcome<Value>(
  context: McpApplicationContext,
  outcome: CommunityCommentManageResult<Value>,
): McpApplicationToolResult {
  if (outcome.kind === 'succeeded') {
    return completeCommunityToolResult(outcome.value);
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
