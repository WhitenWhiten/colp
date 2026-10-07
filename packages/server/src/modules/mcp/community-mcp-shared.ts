/**
 * Shared helpers for the community MCP compatibility tool modules
 * (`community-mcp.ts` for CS-01/CS-02 target/vote/ranking,
 * `community-comment-mcp.ts` for the CS-03 comment tools,
 * `community-comment-manage-mcp.ts` for CS-04 management, and
 * `community-notification-mcp.ts` for CS-05). Kept in one bounded module so
 * every community tool serializes identical result envelopes and maps
 * identical domain errors — never a second wire convention.
 *
 * Error results are the contract `ProductErrorEnvelope`: the same complete
 * object lands in `structuredContent` and in the JSON text block, with
 * `isError=true`. Recovery/retry/precondition metadata mirrors the
 * contract `x-error-recovery` table and the product HTTP mapping in
 * `transport/product/community-routes.ts`.
 */
import {
  CommunityCommentError,
  CommunityNotificationError,
  CommunityRankingError,
  CommunityTargetError,
  CommunityVoteCommandError,
} from '../community/index.js';
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolResult } from './application-results.js';

/** Canonical UUID v4 command id accepted by the mutation tools. */
export const COMMUNITY_MCP_COMMAND_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Per-code wire metadata, contract `x-error-recovery` (lines 2877–2898). */
interface CommunityErrorWireMeta {
  readonly recovery: 'same_request' | 'refresh_and_retry'
    | 'restart_from_first_page' | 'user_action' | 'none';
  readonly sameRequestRetrySafe: boolean;
  readonly precondition?: 'resource' | 'content';
  readonly retryAfterSeconds?: number;
}

const COMMUNITY_ERROR_WIRE_META: Readonly<Record<string, CommunityErrorWireMeta>> = Object.freeze({
  invalid_cursor: Object.freeze({ recovery: 'restart_from_first_page', sameRequestRetrySafe: false }),
  resource_not_found: Object.freeze({ recovery: 'none', sameRequestRetrySafe: false }),
  command_in_progress: Object.freeze({
    recovery: 'same_request', sameRequestRetrySafe: true, retryAfterSeconds: 1,
  }),
  revision_conflict: Object.freeze({
    recovery: 'refresh_and_retry', sameRequestRetrySafe: false, precondition: 'content',
  }),
  snapshot_expired: Object.freeze({
    recovery: 'restart_from_first_page', sameRequestRetrySafe: false,
  }),
  precondition_failed: Object.freeze({
    recovery: 'refresh_and_retry', sameRequestRetrySafe: false, precondition: 'resource',
  }),
  precondition_required: Object.freeze({ recovery: 'refresh_and_retry', sameRequestRetrySafe: false }),
  rate_limited: Object.freeze({
    recovery: 'same_request', sameRequestRetrySafe: true, retryAfterSeconds: 1,
  }),
  feature_temporarily_unavailable: Object.freeze({
    recovery: 'same_request', sameRequestRetrySafe: true, retryAfterSeconds: 1,
  }),
  internal_error: Object.freeze({ recovery: 'none', sameRequestRetrySafe: false }),
});

const COMMUNITY_ERROR_DEFAULT_META: CommunityErrorWireMeta = Object.freeze({
  recovery: 'user_action',
  sameRequestRetrySafe: false,
});

/** Extra wire fields a caller or thrown error may carry into the envelope. */
export interface CommunityToolErrorDetails {
  readonly currentEtag?: string | null;
  readonly retryAfterSeconds?: number;
  readonly fieldErrors?: readonly { path: string; code: string; message: string }[];
}

/** Map a thrown domain/transport error to the stable product error envelope. */
export function mapCommunityToolError(
  context: McpApplicationContext,
  error: unknown,
): McpApplicationToolResult {
  if (error instanceof CommunityTargetError || error instanceof CommunityVoteCommandError
      || error instanceof CommunityRankingError || error instanceof CommunityCommentError
      || error instanceof CommunityNotificationError) {
    return communityToolProductError(context, error.code, error.message, {
      ...((error instanceof CommunityCommentError || error instanceof CommunityNotificationError)
        && error.currentEtag !== null
        ? { currentEtag: error.currentEtag }
        : {}),
    });
  }
  if (error instanceof TypeError) {
    return communityToolProductError(context, 'invalid_request', 'The community request is invalid.');
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '57014' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
    return communityToolProductError(
      context, 'feature_temporarily_unavailable', 'Community voting is temporarily unavailable.',
    );
  }
  const kind = (error as { kind?: unknown } | null)?.kind;
  if (kind === 'serialization_failure' || kind === 'deadlock' || kind === 'lock_timeout' || kind === 'unavailable') {
    return communityToolProductError(
      context, 'feature_temporarily_unavailable', 'Community voting is temporarily unavailable.',
    );
  }
  return communityToolProductError(
    context, 'internal_error', 'The community request could not be completed.',
  );
}

/** Success: structuredContent is the exact JSON the HTTP operation returns. */
export function completeCommunityToolResult(body: unknown): McpApplicationToolResult {
  return Object.freeze({
    kind: 'complete',
    content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(body) })]),
    structuredContent: body,
  });
}

/**
 * Domain error: the complete `ProductErrorEnvelope` with isError=true per
 * contract — `requestId` is the request's MCP correlation id, recovery and
 * retry metadata come from `x-error-recovery`, and the 412/428 fields carry
 * the precondition kind plus the current ETag when the authority knew it.
 */
export function communityToolProductError(
  context: McpApplicationContext,
  code: string,
  message: string,
  details: CommunityToolErrorDetails = {},
): McpApplicationToolResult {
  const meta = COMMUNITY_ERROR_WIRE_META[code] ?? COMMUNITY_ERROR_DEFAULT_META;
  const envelope = Object.freeze({
    error: Object.freeze({
      code,
      message,
      requestId: context.correlationId,
      recovery: meta.recovery,
      sameRequestRetrySafe: meta.sameRequestRetrySafe,
      precondition: meta.precondition ?? null,
      currentEtag: details.currentEtag ?? null,
      retryAfterSeconds: details.retryAfterSeconds ?? meta.retryAfterSeconds ?? null,
      fieldErrors: Object.freeze(details.fieldErrors ?? []),
    }),
  });
  return Object.freeze({
    kind: 'complete',
    isError: true,
    content: Object.freeze([Object.freeze({ type: 'text', text: JSON.stringify(envelope) })]),
    structuredContent: envelope,
  });
}

/** Transport-level rejection (unknown tool / missing scope). */
export function rejectedCommunityTool(stableCode: string, safeMessage: string): McpApplicationToolResult {
  return Object.freeze({ kind: 'rejected', stableCode, safeMessage, retryable: false });
}
