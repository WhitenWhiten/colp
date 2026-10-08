/**
 * Era-neutral MCP application result union (plan §3.4).
 *
 * Wire adapters encode this union per era. Strict 2026-07-28 keeps
 * `resultType: complete | input_required`, `requestState`, and `_meta`.
 * Legacy CallToolResult mapping lives in the compat write adapter.
 */
import type {
  McpApplicationResourceDescriptor,
  McpApplicationResourceTemplateDescriptor,
  McpApplicationToolDescriptor,
} from './application-catalog.js';

export type McpApplicationCompleteResult = Readonly<{
  readonly kind: 'complete';
  readonly content: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}>;

export type McpApplicationAwaitingApprovalResult = Readonly<{
  readonly kind: 'awaiting_approval';
  readonly planId: string;
  readonly approvalUri: string;
  readonly expiresAt: string;
  readonly bindingSummary: string;
}>;

export type McpApplicationRejectedResult = Readonly<{
  readonly kind: 'rejected';
  readonly stableCode: string;
  readonly safeMessage: string;
  readonly retryable: boolean;
}>;

export type McpApplicationToolResult =
  | McpApplicationCompleteResult
  | McpApplicationAwaitingApprovalResult
  | McpApplicationRejectedResult;

export interface McpApplicationToolList {
  readonly tools: readonly McpApplicationToolDescriptor[];
  readonly nextCursor?: string;
}

export interface McpApplicationResourceList {
  readonly resources: readonly McpApplicationResourceDescriptor[];
  readonly nextCursor?: string;
}

export interface McpApplicationResourceTemplateList {
  readonly resourceTemplates: readonly McpApplicationResourceTemplateDescriptor[];
  readonly nextCursor?: string;
}

export interface McpApplicationResourceContents {
  readonly contents: readonly Readonly<{
    readonly uri?: string;
    readonly mimeType: string;
    readonly text?: string;
    readonly blob?: string;
  }>[];
}

export function isMcpApplicationCompleteResult(
  result: McpApplicationToolResult,
): result is McpApplicationCompleteResult {
  return result.kind === 'complete';
}

export function isMcpApplicationAwaitingApprovalResult(
  result: McpApplicationToolResult,
): result is McpApplicationAwaitingApprovalResult {
  return result.kind === 'awaiting_approval';
}

export function isMcpApplicationRejectedResult(
  result: McpApplicationToolResult,
): result is McpApplicationRejectedResult {
  return result.kind === 'rejected';
}
