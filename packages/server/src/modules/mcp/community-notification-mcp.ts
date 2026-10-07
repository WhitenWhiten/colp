/**
 * CS-05 community notification MCP compatibility tools
 * (`known.community.notifications`, `known.community.notifications.read`).
 *
 * Each tool invokes the same application service and the same PostgreSQL
 * authority as the product HTTP routes — there is no HTTP loopback and no
 * arbitrary operation dispatcher. Identity comes only from the MCP
 * context (`context.principal.principalId` = accounts.id plus
 * `context.authorization.accountSubjectId`); actor/recipient fields are
 * never read from tool arguments. The frozen schemas mirror the HTTP
 * contract: `{query}` for the inbox and `{body:{ids}, commandId}` for the
 * durable bulk read.
 */
import {
  CommunityNotificationError,
  createCommunityNotificationCursorCodec,
  listCommunityNotifications,
  markCommunityNotificationsRead,
  parseCommunityNotificationReadBody,
  parseCommunityNotificationsQuery,
  type CommunityNotificationCommandResult,
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
  COMMUNITY_MCP_INBOX_SCHEMA,
  COMMUNITY_MCP_NOTIFICATION_READ_SCHEMA,
  COMMUNITY_MCP_NOTIFICATIONS_INPUT,
  COMMUNITY_MCP_NOTIFICATIONS_READ_INPUT,
  communityToolOutputSchema,
} from './community-mcp-schemas.js';
import type { CommunityMcpToolPortOptions } from './community-mcp.js';
import { grantsScope } from './scope-implications.js';

export const COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME = 'known.community.notifications';
export const COMMUNITY_MCP_NOTIFICATIONS_READ_TOOL_NAME = 'known.community.notifications.read';

const READ_SCOPE = 'product:read';
const WRITE_SCOPE = 'product:write';

export const COMMUNITY_NOTIFICATION_MCP_TOOLS: readonly McpApplicationToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME,
    description: 'Page the authenticated account\u2019s community reply-notification inbox (comment_reply kind) with read=all|unread filtering and opaque cursor pagination; unreadCount counts only still-servable rows.',
    inputSchema: COMMUNITY_MCP_NOTIFICATIONS_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_INBOX_SCHEMA),
    requiredScopes: Object.freeze([READ_SCOPE]),
    compatOnly: true,
  }),
  Object.freeze({
    name: COMMUNITY_MCP_NOTIFICATIONS_READ_TOOL_NAME,
    description: 'Mark community reply notifications read; foreign, absent, or concealed ids are ignored and the result reports the transitioned ids plus the servable unread count. Durable and idempotent on commandId.',
    inputSchema: COMMUNITY_MCP_NOTIFICATIONS_READ_INPUT,
    outputSchema: communityToolOutputSchema(COMMUNITY_MCP_NOTIFICATION_READ_SCHEMA),
    requiredScopes: Object.freeze([WRITE_SCOPE]),
    compatOnly: true,
  }),
]);

export const COMMUNITY_NOTIFICATION_MCP_TOOL_NAMES: readonly string[] = Object.freeze(
  COMMUNITY_NOTIFICATION_MCP_TOOLS.map((tool) => tool.name),
);

export function isCommunityNotificationMcpTool(name: string): boolean {
  return (COMMUNITY_NOTIFICATION_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Availability per tool: the inbox needs the query port + cursor key; read needs the command port. */
export function communityNotificationToolAvailable(
  options: Pick<CommunityMcpToolPortOptions,
    'notificationQueryUnitOfWork' | 'notificationCommandUnitOfWork' | 'notificationCursorHmacKey'>,
  name: string,
): boolean {
  if (name === COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME) {
    return options.notificationQueryUnitOfWork !== undefined
      && options.notificationCursorHmacKey !== undefined;
  }
  if (name === COMMUNITY_MCP_NOTIFICATIONS_READ_TOOL_NAME) {
    return options.notificationCommandUnitOfWork !== undefined;
  }
  return false;
}

export async function callCommunityNotificationTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (name === COMMUNITY_MCP_NOTIFICATIONS_TOOL_NAME) {
    return await callNotificationsTool(options, context, args);
  }
  return await callNotificationsReadTool(options, context, args);
}

async function callNotificationsTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind !== 'authenticated'
      || !grantsScope(context.scopes, READ_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.notificationQueryUnitOfWork === undefined
      || options.notificationCursorHmacKey === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community notifications tool is not configured.');
  }
  for (const key of Object.keys(args)) {
    if (key !== 'query') {
      throw new CommunityNotificationError('invalid_query', 'The community notifications arguments are invalid.');
    }
  }
  const rawQuery = args.query;
  if (rawQuery !== undefined
      && (typeof rawQuery !== 'object' || rawQuery === null || Array.isArray(rawQuery))) {
    throw new CommunityNotificationError('invalid_query', 'The community notifications query is invalid.');
  }
  const query = parseCommunityNotificationsQuery(
    (rawQuery ?? {}) as Readonly<Record<string, unknown>>,
  );
  const inbox = await options.notificationQueryUnitOfWork.execute((ports) =>
    listCommunityNotifications(ports, {
      viewer: {
        accountId: context.principal.principalId,
        subjectId: requireMcpAccountSubjectId(context.authorization),
      },
      query,
      cursorCodec: createCommunityNotificationCursorCodec(options.notificationCursorHmacKey!),
    }), { signal: context.abortSignal });
  return completeCommunityToolResult(inbox);
}

async function callNotificationsReadTool(
  options: CommunityMcpToolPortOptions,
  context: McpApplicationContext,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (context.principal.kind !== 'authenticated'
      || !grantsScope(context.scopes, WRITE_SCOPE)) {
    return rejectedCommunityTool('insufficient_scope', 'Insufficient scope.');
  }
  if (options.notificationCommandUnitOfWork === undefined) {
    return communityToolProductError(context, 'internal_error', 'The community notifications read tool is not configured.');
  }
  for (const key of Object.keys(args)) {
    if (key !== 'body' && key !== 'commandId') {
      throw new CommunityNotificationError('invalid_query', 'The community notifications arguments are invalid.');
    }
  }
  const commandId = typeof args.commandId === 'string' && COMMUNITY_MCP_COMMAND_ID.test(args.commandId)
    ? args.commandId
    : (() => { throw new CommunityNotificationError('invalid_request', 'commandId must be a canonical UUID v4.'); })();
  const outcome = await options.notificationCommandUnitOfWork.execute((ports) =>
    markCommunityNotificationsRead(ports, {
      actor: {
        principalId: context.principal.principalId,
        subjectId: requireMcpAccountSubjectId(context.authorization),
      },
      ids: parseCommunityNotificationReadBody(args.body),
      commandId,
    }), { signal: context.abortSignal });
  return mapReadOutcome(context, outcome);
}

function mapReadOutcome(
  context: McpApplicationContext,
  outcome: CommunityNotificationCommandResult<{ readonly changedIds: readonly string[]; readonly unreadCount: number }>,
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
