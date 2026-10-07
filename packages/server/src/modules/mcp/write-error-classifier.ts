/**
 * MCP-CQ-04 shared write-error classifier (strict JSON-RPC + compat results).
 *
 * Maps `Phase4bMcpLowRiskNodeCreateError`, `Phase4bMcpChangePlanPlannerError`,
 * authoritative-state planning failures, and abort/timeout/unknown faults onto
 * existing COLP MCP wire kinds (`invalid_params`, `invalid_request`,
 * `internal_error`). Expected business rejects never use JSON-RPC `-32603`.
 * Outbound messages are frozen and low-sensitivity. Log fields are correlation
 * id, stable class, and outcome only. Optimistic-lock misses stay existence-
 * ambiguous: they do not include the current revision.
 */
import {
  MCP_WIRE_INTERNAL_ERROR_CODE,
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  MCP_WIRE_INVALID_REQUEST_ERROR_CODE,
  Mcp20260728RequestError,
  type Mcp20260728WireErrorKind,
} from '@know-n/colp/mcp';
import { COLLECTION_KINDS } from '../collections/index.js';
import type { McpApplicationRejectedResult } from './application-results.js';
import {
  Phase4bMcpChangePlanPlannerError,
  type Phase4bMcpChangePlanPlannerErrorCode,
} from './change-plan-planner.js';
import type { Phase4bMcpLowRiskNodeCreateErrorCode } from './low-risk-node-create.js';
import {
  Phase4bMcpLowRiskNodeCreateError,
  type Phase4bMcpWriteErrorHint,
} from './low-risk-node-create.js';
import {
  PHASE4B_MCP_NODE_CREATE_KINDS,
  PHASE4B_MCP_NODE_CREATE_VISIBILITIES,
} from './node-create-catalog.js';

/** `error.name` for host planning when revision/target/actor cannot be resolved. */
export const PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME =
  'AuthoritativeStateUnavailableError' as const;

export type Phase4bMcpWriteErrorClass =
  | 'invalid_params'
  | 'parent_invalid'
  | 'requires_plan_approval'
  | 'policy_rejected'
  | 'stale_revision'
  | 'budget_exceeded'
  | 'unknown_tool'
  | 'safe_input_rejected'
  | 'cancelled'
  | 'timeout'
  | 'internal_error';

export type Phase4bMcpWriteErrorOutcome = 'rejected' | 'cancelled' | 'dependency_error';

export type Phase4bMcpWriteErrorClassification = Readonly<{
  readonly stableClass: Phase4bMcpWriteErrorClass;
  readonly colpKind: Extract<
    Mcp20260728WireErrorKind,
    'invalid_params' | 'invalid_request' | 'internal_error'
  >;
  readonly jsonRpcCode:
    | typeof MCP_WIRE_INVALID_PARAMS_ERROR_CODE
    | typeof MCP_WIRE_INVALID_REQUEST_ERROR_CODE
    | typeof MCP_WIRE_INTERNAL_ERROR_CODE;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly outcome: Phase4bMcpWriteErrorOutcome;
}>;

const INVALID_PARAMS = Object.freeze({
  stableClass: 'invalid_params',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Invalid tool arguments.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const PARENT_INVALID = Object.freeze({
  stableClass: 'parent_invalid',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Parent is not a live folder in this collection.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const REQUIRES_PLAN_APPROVAL = Object.freeze({
  stableClass: 'requires_plan_approval',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'This create requires Plan approval.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const POLICY_REJECTED = Object.freeze({
  stableClass: 'policy_rejected',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Write policy rejected this request.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const STALE_REVISION = Object.freeze({
  stableClass: 'stale_revision',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Collection or parent revision is stale.',
  retryable: true,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const BUDGET_EXCEEDED = Object.freeze({
  stableClass: 'budget_exceeded',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Request exceeded the resource budget.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const UNKNOWN_TOOL = Object.freeze({
  stableClass: 'unknown_tool',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Unknown tool.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const SAFE_INPUT_REJECTED = Object.freeze({
  stableClass: 'safe_input_rejected',
  colpKind: 'invalid_params',
  jsonRpcCode: MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  safeMessage: 'Request contained disallowed input.',
  retryable: false,
  outcome: 'rejected',
}) satisfies Phase4bMcpWriteErrorClassification;

const CANCELLED = Object.freeze({
  stableClass: 'cancelled',
  colpKind: 'invalid_request',
  jsonRpcCode: MCP_WIRE_INVALID_REQUEST_ERROR_CODE,
  safeMessage: 'Request cancelled.',
  retryable: true,
  outcome: 'cancelled',
}) satisfies Phase4bMcpWriteErrorClassification;

const TIMED_OUT = Object.freeze({
  stableClass: 'timeout',
  colpKind: 'invalid_request',
  jsonRpcCode: MCP_WIRE_INVALID_REQUEST_ERROR_CODE,
  safeMessage: 'Request timed out.',
  retryable: true,
  outcome: 'cancelled',
}) satisfies Phase4bMcpWriteErrorClassification;

const INTERNAL_ERROR = Object.freeze({
  stableClass: 'internal_error',
  colpKind: 'internal_error',
  jsonRpcCode: MCP_WIRE_INTERNAL_ERROR_CODE,
  safeMessage: 'Internal error',
  retryable: false,
  outcome: 'dependency_error',
}) satisfies Phase4bMcpWriteErrorClassification;

/**
 * `parent_invalid` keeps JSON-RPC `invalid_params` (`-32602`); there is no
 * COLP not-found wire kind. The stable class `parent_invalid` is the
 * discriminator in `data.code` / result `stableCode`.
 */
const NODE_CREATE_CODE_MAPPING = Object.freeze({
  invalid_catalog_input: INVALID_PARAMS,
  unknown_operation: INVALID_PARAMS,
  parent_invalid: PARENT_INVALID,
  open_payload_rejected: SAFE_INPUT_REJECTED,
  secret_marker_rejected: SAFE_INPUT_REJECTED,
  prompt_injection_rejected: SAFE_INPUT_REJECTED,
  budget_exceeded: BUDGET_EXCEEDED,
  scope_invalid: UNKNOWN_TOOL,
  stale_revision: STALE_REVISION,
  policy_denied: POLICY_REJECTED,
  commit_unknown: INTERNAL_ERROR,
  output_invalid: INTERNAL_ERROR,
  authoritative_state_invalid: INTERNAL_ERROR,
}) satisfies Record<Phase4bMcpLowRiskNodeCreateErrorCode, Phase4bMcpWriteErrorClassification>;

const PLANNER_CODE_MAPPING = Object.freeze({
  invalid_catalog_input: INVALID_PARAMS,
  unknown_operation: INVALID_PARAMS,
  open_payload_rejected: SAFE_INPUT_REJECTED,
  secret_marker_rejected: SAFE_INPUT_REJECTED,
  budget_exceeded: BUDGET_EXCEEDED,
  stale_revision: STALE_REVISION,
  scope_invalid: UNKNOWN_TOOL,
  impact_invalid: INTERNAL_ERROR,
  uri_rejected: INTERNAL_ERROR,
  authoritative_state_invalid: INTERNAL_ERROR,
}) satisfies Record<Phase4bMcpChangePlanPlannerErrorCode, Phase4bMcpWriteErrorClassification>;

export const PHASE4B_MCP_LOW_RISK_NODE_CREATE_ERROR_CODES = Object.freeze(
  Object.keys(NODE_CREATE_CODE_MAPPING) as Phase4bMcpLowRiskNodeCreateErrorCode[],
);

export const PHASE4B_MCP_CHANGE_PLAN_PLANNER_ERROR_CODES = Object.freeze(
  Object.keys(PLANNER_CODE_MAPPING) as Phase4bMcpChangePlanPlannerErrorCode[],
);

export const PHASE4B_MCP_WRITE_ERROR_CLASSES = Object.freeze([
  'invalid_params',
  'parent_invalid',
  'requires_plan_approval',
  'policy_rejected',
  'stale_revision',
  'budget_exceeded',
  'unknown_tool',
  'safe_input_rejected',
  'cancelled',
  'timeout',
  'internal_error',
] as const satisfies readonly Phase4bMcpWriteErrorClass[]);

const STABLE_CLASS_SET: ReadonlySet<string> = new Set(PHASE4B_MCP_WRITE_ERROR_CLASSES);

const CLASSIFICATION_BY_STABLE_CLASS = Object.freeze({
  invalid_params: INVALID_PARAMS,
  parent_invalid: PARENT_INVALID,
  requires_plan_approval: REQUIRES_PLAN_APPROVAL,
  policy_rejected: POLICY_REJECTED,
  stale_revision: STALE_REVISION,
  budget_exceeded: BUDGET_EXCEEDED,
  unknown_tool: UNKNOWN_TOOL,
  safe_input_rejected: SAFE_INPUT_REJECTED,
  cancelled: CANCELLED,
  timeout: TIMED_OUT,
  internal_error: INTERNAL_ERROR,
}) satisfies Record<Phase4bMcpWriteErrorClass, Phase4bMcpWriteErrorClassification>;

export function classifyPhase4bMcpWriteError(error: unknown): Phase4bMcpWriteErrorClassification {
  if (error instanceof Phase4bMcpLowRiskNodeCreateError) {
    return classifyPhase4bMcpLowRiskNodeCreateError(error);
  }
  if (error instanceof Phase4bMcpChangePlanPlannerError) {
    return PLANNER_CODE_MAPPING[error.code];
  }
  if (isPhase4bMcpAuthoritativeStateUnavailableError(error)) {
    return STALE_REVISION;
  }
  if (error instanceof Mcp20260728RequestError) {
    const fromData = classificationFromRequestErrorData(error);
    if (fromData !== undefined) return fromData;
  }
  const cancelled = classifyCancelledError(error);
  if (cancelled !== undefined) return cancelled;
  return INTERNAL_ERROR;
}

/** Keep package-sanitized dependency failures on the host's internal-error path. */
export function rethrowPhase4bMcpWriteAdapterError(error: unknown): never {
  if (error instanceof Mcp20260728RequestError && error.kind === 'internal_error') {
    throw new Error('Internal error');
  }
  throw error;
}

export function isPhase4bMcpAuthoritativeStateUnavailableError(error: unknown): boolean {
  return error instanceof Error
    && error.name === PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME;
}

export function classifyPhase4bMcpLowRiskNodeCreateError(
  error: Phase4bMcpLowRiskNodeCreateError,
): Phase4bMcpWriteErrorClassification {
  // `changes.get` deliberately uses the generic policy-denied service code so
  // storage visibility stays fail-closed, but its exact concealment copy must
  // survive the strict -> facade -> compat round-trip as an unknown Tool.
  if (error.code === 'policy_denied' && error.message === 'Unknown tool.') {
    return UNKNOWN_TOOL;
  }
  return NODE_CREATE_CODE_MAPPING[error.code];
}

const NODE_CREATE_HINT = Object.freeze({
  allowedKinds: PHASE4B_MCP_NODE_CREATE_KINDS,
  allowedVisibilities: PHASE4B_MCP_NODE_CREATE_VISIBILITIES,
  nextTool: 'nodes.create' as const,
});

const NODE_UPDATE_HINT = Object.freeze({
  allowedKinds: PHASE4B_MCP_NODE_CREATE_KINDS,
  allowedVisibilities: PHASE4B_MCP_NODE_CREATE_VISIBILITIES,
  nextTool: 'nodes.update' as const,
});

const COLLECTION_CREATE_HINT = Object.freeze({
  allowedKinds: COLLECTION_KINDS,
  allowedVisibilities: Object.freeze(['private'] as const),
  nextTool: 'collections.create' as const,
});

const COLLECTION_UPDATE_HINT = Object.freeze({
  allowedKinds: COLLECTION_KINDS,
  allowedVisibilities: Object.freeze(['private'] as const),
  nextTool: 'collections.update' as const,
});

const ANNOTATION_CREATE_HINT = Object.freeze({
  allowedKinds: Object.freeze(['note', 'tldr', 'summary'] as const),
  allowedVisibilities: Object.freeze(['private', 'protected'] as const),
  nextTool: 'annotations.create' as const,
});

const ANNOTATION_UPDATE_HINT = Object.freeze({
  allowedKinds: Object.freeze(['note', 'tldr', 'summary'] as const),
  allowedVisibilities: Object.freeze(['private', 'protected'] as const),
  nextTool: 'annotations.update' as const,
});

export function writeErrorHintFrom(error: unknown): Phase4bMcpWriteErrorHint | undefined {
  if (!(error instanceof Phase4bMcpLowRiskNodeCreateError)) return undefined;
  const hint: { field?: string; nextTool?: Phase4bMcpWriteErrorHint['nextTool'] } = {};
  if (error.field !== undefined) hint.field = error.field;
  if (error.nextTool !== undefined) hint.nextTool = error.nextTool;
  return Object.keys(hint).length === 0 ? undefined : Object.freeze(hint);
}

export function toPhase4bMcpWriteRequestError(
  classification: Phase4bMcpWriteErrorClassification,
  hint?: Phase4bMcpWriteErrorHint,
): Mcp20260728RequestError {
  if (classification.outcome === 'dependency_error') {
    return new Mcp20260728RequestError(classification.colpKind, classification.safeMessage);
  }
  const data: Record<string, unknown> = { code: classification.stableClass };
  if (
    classification.stableClass === 'invalid_params'
    || classification.stableClass === 'parent_invalid'
  ) {
    const catalogHint = hint?.nextTool === 'collections.create'
      ? COLLECTION_CREATE_HINT
      : hint?.nextTool === 'collections.update'
        ? COLLECTION_UPDATE_HINT
        : hint?.nextTool === 'nodes.update'
          ? NODE_UPDATE_HINT
          : hint?.nextTool === 'annotations.create'
            ? ANNOTATION_CREATE_HINT
            : hint?.nextTool === 'annotations.update'
              ? ANNOTATION_UPDATE_HINT
              : NODE_CREATE_HINT;
    data.allowedKinds = catalogHint.allowedKinds;
    data.allowedVisibilities = catalogHint.allowedVisibilities;
    data.nextTool = catalogHint.nextTool;
    if (hint?.field !== undefined) data.field = hint.field;
    else if (classification.stableClass === 'parent_invalid') data.field = 'parentId';
  }
  return new Mcp20260728RequestError(
    classification.colpKind,
    classification.safeMessage,
    Object.freeze(data),
  );
}

export function toPhase4bMcpWriteRejectedResult(
  classification: Phase4bMcpWriteErrorClassification,
): McpApplicationRejectedResult {
  return Object.freeze({
    kind: 'rejected',
    stableCode: classification.stableClass,
    safeMessage: classification.safeMessage,
    retryable: classification.retryable,
  });
}

export function redactedPhase4bMcpWriteErrorLogFields(
  classification: Phase4bMcpWriteErrorClassification,
  correlationId: string,
): Readonly<{
  readonly correlationId: string;
  readonly errorClass: Phase4bMcpWriteErrorClass;
  readonly outcome: Phase4bMcpWriteErrorOutcome;
}> {
  return Object.freeze({
    correlationId,
    errorClass: classification.stableClass,
    outcome: classification.outcome,
  });
}

export function isPhase4bMcpWriteErrorClass(value: unknown): value is Phase4bMcpWriteErrorClass {
  return typeof value === 'string' && STABLE_CLASS_SET.has(value);
}

function classificationFromRequestErrorData(
  error: Mcp20260728RequestError,
): Phase4bMcpWriteErrorClassification | undefined {
  const data = error.data;
  if (data === undefined || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const code = (data as { readonly code?: unknown }).code;
  if (!isPhase4bMcpWriteErrorClass(code)) return undefined;
  return CLASSIFICATION_BY_STABLE_CLASS[code];
}

function classifyCancelledError(error: unknown): Phase4bMcpWriteErrorClassification | undefined {
  if (error instanceof DOMException && error.name === 'TimeoutError') return TIMED_OUT;
  if (error instanceof DOMException && error.name === 'AbortError') return CANCELLED;
  if (!(error instanceof Error)) return undefined;
  if (error.name === 'TimeoutError') return TIMED_OUT;
  if (error.name === 'AbortError' || error.name === 'McpReadRequestAbortedError') return CANCELLED;
  if (error.message === 'aborted') return CANCELLED;
  return undefined;
}
