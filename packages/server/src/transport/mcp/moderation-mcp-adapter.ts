import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  CollectionPreconditionError,
} from '../../modules/collections/index.js';
import {
  createModerationAction,
  GovernanceModerationError,
  hasOfficialRead,
  hasOfficialWrite,
  listModerationCases,
  listMyModerationReports,
  ModerationCursorExpiredError,
  parseActionInput,
  parseCasePatch,
  parseReportInput,
  parseRevokeReason,
  revokeModerationAction,
  submitModerationReport,
  updateModerationCase,
  type ModerationCommandPorts,
  type ModerationQueryPorts,
} from '../../modules/governance/index.js';
import type {
  McpApplicationContext,
  McpApplicationToolDescriptor,
  McpApplicationToolPort,
  McpApplicationToolResult,
} from '../../modules/mcp/index.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';
import {
  appealCreateTool,
  appealDecideTool,
  callAppealTool,
  isAppealToolName,
} from './moderation-mcp-appeals.js';

const REPORT_TOOL = 'known.moderation.report';
const MINE_TOOL = 'known.moderation.reports.mine';
const CASES_TOOL = 'known.moderation.cases';
const CASE_UPDATE_TOOL = 'known.moderation.case.update';
const ACTION_CREATE_TOOL = 'known.moderation.action.create';
const ACTION_REVOKE_TOOL = 'known.moderation.action.revoke';

export interface ModerationMcpIdentity {
  findAccountBySubject(subjectId: string): Promise<{
    readonly accountId: string;
    readonly subjectId: string;
  } | null>;
}

export function createModerationMcpPort(input: {
  readonly hmacKey: string;
  readonly commandUnitOfWork: {
    execute<Result>(work: (ports: ModerationCommandPorts) => Promise<Result>): Promise<Result>;
  };
  readonly queryPorts: ModerationQueryPorts;
  readonly identity: ModerationMcpIdentity;
  readonly rateLimiter: ProductAdmissionRateLimiter;
  readonly actionRateLimiter: ProductAdmissionRateLimiter;
  readonly appealRateLimiter: ProductAdmissionRateLimiter;
}): McpApplicationToolPort {
  const reportTool = Object.freeze({
    name: REPORT_TOOL,
    description: 'Submit a moderation report against a currently readable target.',
    requiredScopes: Object.freeze(['product:write']),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['body', 'commandId'],
      properties: Object.freeze({
        body: Object.freeze({ type: 'object' }),
        commandId: Object.freeze({
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        }),
      }),
    }),
  }) satisfies McpApplicationToolDescriptor;
  const mineTool = Object.freeze({
    name: MINE_TOOL,
    description: 'List the current account moderation reports.',
    requiredScopes: Object.freeze(['product:read']),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        query: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            status: Object.freeze({
              type: 'string',
              enum: Object.freeze(['submitted', 'in_review', 'resolved', 'dismissed']),
            }),
            limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 20 }),
            cursor: Object.freeze({ type: 'string', minLength: 1, maxLength: 2048 }),
          }),
          required: Object.freeze([]),
        }),
      }),
      required: Object.freeze([]),
    }),
  }) satisfies McpApplicationToolDescriptor;
  const casesTool = Object.freeze({
    name: CASES_TOOL,
    description: 'List official moderation cases.',
    requiredScopes: Object.freeze(['product:read']),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        query: Object.freeze({
          type: 'object',
          additionalProperties: false,
          properties: Object.freeze({
            status: Object.freeze({
              type: 'string',
              enum: Object.freeze(['submitted', 'in_review', 'resolved', 'dismissed']),
            }),
            assignee: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }),
            limit: Object.freeze({ type: 'integer', minimum: 1, maximum: 100, default: 20 }),
            cursor: Object.freeze({ type: 'string', minLength: 1, maxLength: 2048 }),
          }),
          required: Object.freeze([]),
        }),
      }),
      required: Object.freeze([]),
    }),
  }) satisfies McpApplicationToolDescriptor;
  const caseUpdateTool = Object.freeze({
    name: CASE_UPDATE_TOOL,
    description: 'Update an official moderation case.',
    requiredScopes: Object.freeze(['product:write']),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'body', 'commandId', 'ifMatch'],
      properties: Object.freeze({
        path: Object.freeze({ type: 'object' }),
        body: Object.freeze({ type: 'object' }),
        commandId: Object.freeze({ type: 'string' }),
        ifMatch: Object.freeze({ type: 'string' }),
      }),
    }),
  }) satisfies McpApplicationToolDescriptor;
  const actionCreateTool = Object.freeze({
    name: ACTION_CREATE_TOOL,
    description: 'Create an official moderation action.',
    requiredScopes: Object.freeze(['product:write']),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['body', 'commandId'],
      properties: Object.freeze({
        body: Object.freeze({ type: 'object' }),
        commandId: Object.freeze({ type: 'string' }),
      }),
    }),
  }) satisfies McpApplicationToolDescriptor;
  const actionRevokeTool = Object.freeze({
    name: ACTION_REVOKE_TOOL,
    description: 'Revoke one official moderation action.',
    requiredScopes: Object.freeze(['product:write']),
    inputSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'body', 'commandId', 'ifMatch'],
      properties: Object.freeze({
        path: Object.freeze({ type: 'object' }),
        body: Object.freeze({ type: 'object' }),
        commandId: Object.freeze({ type: 'string' }),
        ifMatch: Object.freeze({ type: 'string' }),
      }),
    }),
  }) satisfies McpApplicationToolDescriptor;

  const port: McpApplicationToolPort = {
    listTools: async (context) => {
      if (context.principal.kind !== 'authenticated') return Object.freeze([]);
      const tools: McpApplicationToolDescriptor[] = [];
      if (context.scopes.includes('product:write')) tools.push(reportTool, appealCreateTool);
      if (context.scopes.includes('product:read')) tools.push(mineTool);
      if (context.scopes.includes('product:read')) {
        const account = await accountFrom(context, input.identity);
        if (account && hasOfficialRead(await input.queryPorts.roles.getRoles(account.accountId))) {
          tools.push(casesTool);
        }
        if (account && context.scopes.includes('product:write')
          && hasOfficialWrite(await input.queryPorts.roles.getRoles(account.accountId))) {
          tools.push(caseUpdateTool, actionCreateTool, actionRevokeTool, appealDecideTool);
        }
      }
      return Object.freeze(tools);
    },
    callTool: async (context, name, args) => {
      try {
        const account = await accountFrom(context, input.identity);
        if (!account) return errorResult(context, 401, 'authentication_required', 'Authentication is required.');
        if (name === REPORT_TOOL) {
          if (!context.scopes.includes('product:write')) {
            return errorResult(context, 403, 'insufficient_permission', 'product:write is required.');
          }
          return await callReport(input, context, account, args);
        }
        if (name === MINE_TOOL) {
          if (!context.scopes.includes('product:read')) {
            return errorResult(context, 403, 'insufficient_permission', 'product:read is required.');
          }
          const query = readQuery(args, ['status', 'limit', 'cursor']);
          const page = await listMyModerationReports(input.queryPorts, input.hmacKey, {
            accountId: account.accountId,
            query,
          });
          return complete(page);
        }
        if (name === CASES_TOOL) {
          if (!context.scopes.includes('product:read')) {
            return errorResult(context, 403, 'insufficient_permission', 'product:read is required.');
          }
          const query = readQuery(args, ['status', 'assignee', 'limit', 'cursor']);
          const page = await listModerationCases(input.queryPorts, input.hmacKey, {
            accountId: account.accountId,
            query,
          });
          return complete(page);
        }
        if (name === CASE_UPDATE_TOOL || name === ACTION_CREATE_TOOL || name === ACTION_REVOKE_TOOL) {
          if (!context.scopes.includes('product:write')) {
            return errorResult(context, 403, 'insufficient_permission', 'product:write is required.');
          }
          return await callWriteTool(input, context, account, name, args);
        }
        if (isAppealToolName(name)) {
          if (!context.scopes.includes('product:write')) {
            return errorResult(context, 403, 'insufficient_permission', 'product:write is required.');
          }
          return await callAppealTool({
            commandUnitOfWork: input.commandUnitOfWork,
            appealRateLimiter: input.appealRateLimiter,
            queryRoles: (accountId) => input.queryPorts.roles.getRoles(accountId),
          }, context, account, name, args, {
            assertClosed, complete, errorResult, writeOutcome,
          });
        }
        return {
          kind: 'rejected' as const,
          stableCode: 'unknown_tool',
          safeMessage: 'Unknown tool.',
          retryable: false,
        };
      } catch (error: unknown) {
        return mapMcpError(context, error);
      }
    },
  };
  return Object.freeze(port);
}

export function isModerationToolName(name: string): boolean {
  return name === REPORT_TOOL || name === MINE_TOOL || name === CASES_TOOL
    || name === CASE_UPDATE_TOOL || name === ACTION_CREATE_TOOL || name === ACTION_REVOKE_TOOL
    || isAppealToolName(name);
}

async function callReport(
  input: {
    readonly commandUnitOfWork: {
      execute<Result>(work: (ports: ModerationCommandPorts) => Promise<Result>): Promise<Result>;
    };
    readonly rateLimiter: ProductAdmissionRateLimiter;
  },
  context: McpApplicationContext,
  account: { readonly accountId: string; readonly subjectId: string },
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  assertClosed(args, ['body', 'commandId']);
  if (typeof args.commandId !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'commandId is invalid');
  }
  const report = parseReportInput(args.body);
  const decision = await consumeProductAdmission(input.rateLimiter, `account:${account.accountId}`);
  if (decision.kind === 'failed') {
    return errorResult(context, 503, 'feature_temporarily_unavailable', 'The service is temporarily unavailable.');
  }
  if (decision.kind === 'denied') {
    return errorResult(context, 429, 'rate_limited', 'Too many moderation reports. Please try again later.', {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }
  const route = '/api/v1/moderation/reports';
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST',
    route,
    mediaType: 'application/json',
    body: report,
    query: {},
  });
  const outcome = await input.commandUnitOfWork.execute((ports) =>
    submitModerationReport(ports, {
      actor: { accountId: account.accountId, subjectId: account.subjectId, principalId: account.accountId },
      commandId: args.commandId as string,
      fingerprint,
      commandScope: httpCommandScopeV1('POST', route),
      report,
    }));
  if (outcome.kind === 'created' || outcome.kind === 'deduped') return complete(outcome.case);
  if (outcome.kind === 'replay') {
    const body = JSON.parse(new TextDecoder().decode(outcome.body)) as unknown;
    return complete(body);
  }
  if (outcome.kind === 'reused') {
    return errorResult(context, 409, 'command_id_reused', 'This command id was already used with a different request.');
  }
  if (outcome.kind === 'in_progress') {
    return errorResult(context, 409, 'command_in_progress', 'This command is still in progress.', {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  return errorResult(context, 410, 'command_result_expired', 'The stored result for this command has expired.');
}

async function callWriteTool(
  input: {
    readonly commandUnitOfWork: {
      execute<Result>(work: (ports: ModerationCommandPorts) => Promise<Result>): Promise<Result>;
    };
    readonly actionRateLimiter: ProductAdmissionRateLimiter;
  },
  context: McpApplicationContext,
  account: { readonly accountId: string; readonly subjectId: string },
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpApplicationToolResult> {
  if (typeof args.commandId !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'commandId is invalid');
  }
  if (name === ACTION_CREATE_TOOL) {
    assertClosed(args, ['body', 'commandId']);
    const body = parseActionInput(args.body);
    const decision = await consumeProductAdmission(input.actionRateLimiter, `account:${account.accountId}`);
    if (decision.kind === 'failed') {
      return errorResult(context, 503, 'feature_temporarily_unavailable', 'The service is temporarily unavailable.');
    }
    if (decision.kind === 'denied') {
      return errorResult(context, 429, 'rate_limited', 'Too many moderation actions. Please try again later.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    const route = '/api/v1/moderation/actions';
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route, mediaType: 'application/json', body, query: {},
    });
    const outcome = await input.commandUnitOfWork.execute((ports) =>
      createModerationAction(ports, {
        actor: { accountId: account.accountId, principalId: account.accountId },
        commandId: args.commandId as string,
        fingerprint,
        commandScope: httpCommandScopeV1('POST', route),
        body,
      }));
    return writeOutcome(context, outcome);
  }
  const ifMatch = args.ifMatch;
  if (typeof ifMatch !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'ifMatch is invalid');
  }
  if (name === CASE_UPDATE_TOOL) {
    assertClosed(args, ['path', 'body', 'commandId', 'ifMatch']);
    const path = requirePath(args.path, 'caseId');
    const patch = parseCasePatch(args.body);
    const route = `/api/v1/moderation/cases/${path.caseId}`;
    const fingerprint = canonicalCommandFingerprint({
      method: 'PATCH', route, mediaType: 'application/json', body: patch, query: {},
      conditions: { ifMatch },
    });
    const outcome = await input.commandUnitOfWork.execute((ports) =>
      updateModerationCase(ports, {
        actor: { accountId: account.accountId, principalId: account.accountId },
        commandId: args.commandId as string,
        fingerprint,
        commandScope: httpCommandScopeV1('PATCH', route),
        caseId: path.caseId,
        ifMatch,
        patch,
      }));
    if (outcome.kind === 'updated') return complete(outcome.view);
    return writeOutcome(context, outcome);
  }
  assertClosed(args, ['path', 'body', 'commandId', 'ifMatch']);
  const path = requirePath(args.path, 'actionId');
  const reason = parseRevokeReason(args.body);
  const route = `/api/v1/moderation/actions/${path.actionId}/revoke`;
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST', route, mediaType: 'application/json', body: { reason }, query: {},
    conditions: { ifMatch },
  });
  const outcome = await input.commandUnitOfWork.execute((ports) =>
    revokeModerationAction(ports, {
      actor: { accountId: account.accountId, principalId: account.accountId },
      commandId: args.commandId as string,
      fingerprint,
      commandScope: httpCommandScopeV1('POST', route),
      actionId: path.actionId,
      ifMatch,
      reason,
    }));
  return writeOutcome(context, outcome);
}

function requirePath(value: unknown, field: 'caseId'): { readonly caseId: string };
function requirePath(value: unknown, field: 'actionId'): { readonly actionId: string };
function requirePath(value: unknown, field: 'caseId' | 'actionId'): { readonly caseId?: string; readonly actionId?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GovernanceModerationError('invalid_request', 'path is invalid');
  }
  const record = value as Record<string, unknown>;
  assertClosed(record, [field]);
  const id = record[field];
  if (typeof id !== 'string') {
    throw new GovernanceModerationError('invalid_request', `${field} is invalid`);
  }
  return { [field]: id };
}

function writeOutcome(
  context: McpApplicationContext,
  outcome: {
    readonly kind: string;
    readonly status?: number;
    readonly view?: unknown;
    readonly case?: unknown;
    readonly body?: Uint8Array;
    readonly retryAfterSeconds?: number;
  },
): McpApplicationToolResult {
  if (outcome.kind === 'written' && outcome.view !== undefined) return complete(outcome.view);
  if (outcome.kind === 'updated' && outcome.view !== undefined) return complete(outcome.view);
  if (outcome.kind === 'replay' && outcome.body) {
    return complete(JSON.parse(new TextDecoder().decode(outcome.body)) as unknown);
  }
  if (outcome.kind === 'reused') {
    return errorResult(context, 409, 'command_id_reused', 'This command id was already used with a different request.');
  }
  if (outcome.kind === 'in_progress') {
    return errorResult(context, 409, 'command_in_progress', 'This command is still in progress.', {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  return errorResult(context, 410, 'command_result_expired', 'The stored result for this command has expired.');
}

async function accountFrom(
  context: McpApplicationContext,
  identity: ModerationMcpIdentity,
): Promise<{ accountId: string; subjectId: string } | null> {
  if (context.principal.kind !== 'authenticated') return null;
  const subject = context.authorization.accountSubjectId;
  if (typeof subject !== 'string' || subject.length < 1) return null;
  return identity.findAccountBySubject(subject);
}

function readQuery(
  args: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): Record<string, string> {
  assertClosed(args, ['query']);
  if (args.query === undefined) return {};
  if (typeof args.query !== 'object' || args.query === null || Array.isArray(args.query)) {
    throw new GovernanceModerationError('invalid_request', 'query is invalid');
  }
  const query = args.query as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw new GovernanceModerationError('invalid_query', `unknown field ${key}`);
  }
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = query[key];
    if (value === undefined) continue;
    if (key === 'limit') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new GovernanceModerationError('invalid_query', 'limit is invalid');
      }
      out.limit = String(value);
      continue;
    }
    if (typeof value !== 'string') throw new GovernanceModerationError('invalid_query', `${key} is invalid`);
    out[key] = value;
  }
  return out;
}

function assertClosed(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new GovernanceModerationError('invalid_request', `unknown field ${key}`);
  }
}

function complete(value: unknown): McpApplicationToolResult {
  return {
    kind: 'complete',
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(
  context: McpApplicationContext,
  status: number,
  code: string,
  message: string,
  extra: { readonly retryAfterSeconds?: number } = {},
): McpApplicationToolResult {
  void status;
  const envelope = {
    error: {
      code,
      message,
      requestId: context.correlationId,
      recovery: extra.retryAfterSeconds === undefined ? 'user_action' : 'same_request',
      sameRequestRetrySafe: extra.retryAfterSeconds !== undefined,
      precondition: null,
      currentEtag: null,
      retryAfterSeconds: extra.retryAfterSeconds ?? null,
      fieldErrors: [],
    },
  };
  return {
    kind: 'complete',
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

function mapMcpError(context: McpApplicationContext, error: unknown): McpApplicationToolResult {
  if (error instanceof CollectionPreconditionError) {
    return errorResult(context, 412, 'precondition_failed', error.message);
  }
  if (error instanceof ModerationCursorExpiredError) {
    return errorResult(context, 409, 'snapshot_expired', 'The cursor snapshot has expired.');
  }
  if (error instanceof GovernanceModerationError) {
    if (error.code === 'resource_not_found' || error.outcome === 'conceal') {
      return errorResult(context, 404, 'resource_not_found', 'The requested resource was not found.');
    }
    if (error.code === 'insufficient_permission' || error.outcome === 'deny') {
      return errorResult(context, 403, 'insufficient_permission', 'You do not have permission to perform this action.');
    }
    if (error.code === 'invalid_cursor') {
      return errorResult(context, 400, 'invalid_cursor', 'The cursor is invalid.');
    }
    if (error.code === 'revision_conflict') {
      return errorResult(context, 409, 'revision_conflict', error.message);
    }
    return errorResult(context, 400, error.code, error.message);
  }
  return errorResult(context, 500, 'internal_error', 'An internal error occurred.');
}
