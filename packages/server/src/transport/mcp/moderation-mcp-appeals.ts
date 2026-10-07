import { canonicalCommandFingerprint } from '../../modules/commands/index.js';
import {
  createModerationAppeal,
  decideModerationAppeal,
  GovernanceModerationError,
  hasOfficialWrite,
  parseAppealDecision,
  parseAppealInput,
  type ModerationCommandPorts,
} from '../../modules/governance/index.js';
import type {
  McpApplicationContext,
  McpApplicationToolDescriptor,
  McpApplicationToolResult,
} from '../../modules/mcp/index.js';
import { consumeProductAdmission, type ProductAdmissionRateLimiter } from '../http-security.js';
import { httpCommandScopeV1 } from '../http-command-scope.js';

export const APPEAL_CREATE_TOOL = 'known.moderation.appeal.create';
export const APPEAL_DECIDE_TOOL = 'known.moderation.appeal.decide';

export const appealCreateTool = Object.freeze({
  name: APPEAL_CREATE_TOOL,
  description: 'Create a moderation appeal for an action affecting the current account.',
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

export const appealDecideTool = Object.freeze({
  name: APPEAL_DECIDE_TOOL,
  description: 'Decide a moderation appeal.',
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

export function isAppealToolName(name: string): boolean {
  return name === APPEAL_CREATE_TOOL || name === APPEAL_DECIDE_TOOL;
}

export async function callAppealTool(
  input: {
    readonly commandUnitOfWork: {
      execute<Result>(work: (ports: ModerationCommandPorts) => Promise<Result>): Promise<Result>;
    };
    readonly appealRateLimiter: ProductAdmissionRateLimiter;
    readonly queryRoles: (accountId: string) => Promise<ReadonlySet<'reviewer' | 'moderator'>>;
  },
  context: McpApplicationContext,
  account: { readonly accountId: string; readonly subjectId: string },
  name: string,
  args: Readonly<Record<string, unknown>>,
  helpers: {
    assertClosed(record: Readonly<Record<string, unknown>>, allowed: readonly string[]): void;
    complete(value: unknown): McpApplicationToolResult;
    errorResult(
      context: McpApplicationContext,
      status: number,
      code: string,
      message: string,
      extra?: { readonly retryAfterSeconds?: number },
    ): McpApplicationToolResult;
    writeOutcome(
      context: McpApplicationContext,
      outcome: {
        readonly kind: string;
        readonly view?: unknown;
        readonly body?: Uint8Array;
        readonly retryAfterSeconds?: number;
      },
    ): McpApplicationToolResult;
  },
): Promise<McpApplicationToolResult> {
  if (typeof args.commandId !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'commandId is invalid');
  }
  if (name === APPEAL_CREATE_TOOL) {
    helpers.assertClosed(args, ['body', 'commandId']);
    const body = parseAppealInput(args.body);
    const decision = await consumeProductAdmission(input.appealRateLimiter, `account:${account.accountId}`);
    if (decision.kind === 'failed') {
      return helpers.errorResult(context, 503, 'feature_temporarily_unavailable', 'The service is temporarily unavailable.');
    }
    if (decision.kind === 'denied') {
      return helpers.errorResult(context, 429, 'rate_limited', 'Too many moderation appeals. Please try again later.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
    const route = '/api/v1/moderation/appeals';
    const fingerprint = canonicalCommandFingerprint({
      method: 'POST', route, mediaType: 'application/json', body, query: {},
    });
    const outcome = await input.commandUnitOfWork.execute((ports) =>
      createModerationAppeal(ports, {
        actor: { accountId: account.accountId, principalId: account.accountId },
        commandId: args.commandId as string,
        fingerprint,
        commandScope: httpCommandScopeV1('POST', route),
        body,
      }));
    return helpers.writeOutcome(context, outcome);
  }
  helpers.assertClosed(args, ['path', 'body', 'commandId', 'ifMatch']);
  if (!hasOfficialWrite(await input.queryRoles(account.accountId))) {
    throw new GovernanceModerationError(
      'insufficient_permission',
      'official moderator role is required',
      'deny',
    );
  }
  const ifMatch = args.ifMatch;
  if (typeof ifMatch !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'ifMatch is invalid');
  }
  if (typeof args.path !== 'object' || args.path === null || Array.isArray(args.path)) {
    throw new GovernanceModerationError('invalid_request', 'path is invalid');
  }
  const pathRecord = args.path as Record<string, unknown>;
  helpers.assertClosed(pathRecord, ['appealId']);
  const appealId = pathRecord.appealId;
  if (typeof appealId !== 'string') {
    throw new GovernanceModerationError('invalid_request', 'appealId is invalid');
  }
  const body = parseAppealDecision(args.body);
  const route = `/api/v1/moderation/appeals/${appealId}/decision`;
  const fingerprint = canonicalCommandFingerprint({
    method: 'POST', route, mediaType: 'application/json', body, query: {},
    conditions: { ifMatch },
  });
  const outcome = await input.commandUnitOfWork.execute((ports) =>
    decideModerationAppeal(ports, {
      actor: { accountId: account.accountId, principalId: account.accountId },
      commandId: args.commandId as string,
      fingerprint,
      commandScope: httpCommandScopeV1('POST', route),
      appealId,
      ifMatch,
      body,
    }));
  return helpers.writeOutcome(context, outcome);
}
