/**
 * MCP-CQ-04: planner and authoritative-state planning failures must not
 * collapse to JSON-RPC `-32603`. Stale/unknown targets stay existence-ambiguous
 * and never include the current revision.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MCP_WIRE_INTERNAL_ERROR_CODE, MCP_WIRE_INVALID_PARAMS_ERROR_CODE } from '@know-n/colp/mcp';
import {
  PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME,
  PHASE4B_MCP_CHANGE_PLAN_PLANNER_ERROR_CODES,
  Phase4bMcpChangePlanPlannerError,
  classifyPhase4bMcpWriteError,
  redactedPhase4bMcpWriteErrorLogFields,
  toPhase4bMcpWriteRequestError,
  type Phase4bMcpChangePlanPlannerErrorCode,
} from '../../../src/modules/mcp/index.js';

const CANARY = 'CANARY-cq04-plan-password=supersecret-revision-aEp7EkUp';

test('mapping table covers every Phase4bMcpChangePlanPlannerError code', () => {
  const expected: Record<Phase4bMcpChangePlanPlannerErrorCode, true> = {
    invalid_catalog_input: true,
    unknown_operation: true,
    open_payload_rejected: true,
    budget_exceeded: true,
    stale_revision: true,
    scope_invalid: true,
    impact_invalid: true,
    uri_rejected: true,
    secret_marker_rejected: true,
    authoritative_state_invalid: true,
  };
  assert.deepEqual(
    [...PHASE4B_MCP_CHANGE_PLAN_PLANNER_ERROR_CODES].sort(),
    Object.keys(expected).sort(),
  );
});

test('classifier maps planner codes off Internal error for client-correctable rejects', () => {
  const byCode = Object.fromEntries(
    PHASE4B_MCP_CHANGE_PLAN_PLANNER_ERROR_CODES.map((code) => {
      const error = new Phase4bMcpChangePlanPlannerError(code, `${code} ${CANARY}`);
      return [code, classifyPhase4bMcpWriteError(error)];
    }),
  ) as Record<Phase4bMcpChangePlanPlannerErrorCode, ReturnType<typeof classifyPhase4bMcpWriteError>>;

  assert.equal(byCode.invalid_catalog_input.stableClass, 'invalid_params');
  assert.equal(byCode.invalid_catalog_input.jsonRpcCode, MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
  assert.equal(byCode.unknown_operation.stableClass, 'invalid_params');
  assert.equal(byCode.open_payload_rejected.stableClass, 'safe_input_rejected');
  assert.equal(byCode.secret_marker_rejected.stableClass, 'safe_input_rejected');
  assert.equal(byCode.budget_exceeded.stableClass, 'budget_exceeded');
  assert.equal(byCode.stale_revision.stableClass, 'stale_revision');
  assert.equal(byCode.stale_revision.retryable, true);
  assert.equal(byCode.scope_invalid.stableClass, 'unknown_tool');
  assert.equal(byCode.impact_invalid.stableClass, 'internal_error');
  assert.equal(byCode.uri_rejected.stableClass, 'internal_error');
  assert.equal(byCode.authoritative_state_invalid.stableClass, 'internal_error');
  assert.equal(byCode.impact_invalid.jsonRpcCode, MCP_WIRE_INTERNAL_ERROR_CODE);

  for (const code of PHASE4B_MCP_CHANGE_PLAN_PLANNER_ERROR_CODES) {
    const classified = byCode[code];
    assert.equal(classified.safeMessage.includes(CANARY), false, code);
    assert.equal(JSON.stringify(classified).includes(CANARY), false, code);
    const wire = toPhase4bMcpWriteRequestError(classified);
    assert.equal(wire.message.includes(CANARY), false, code);
    assert.equal(JSON.stringify(wire.data ?? {}).includes('currentRevision'), false, code);
    assert.equal(JSON.stringify(wire.data ?? {}).includes(CANARY), false, code);
  }
});

test('authoritative-state planning failures map to stale_revision without leaking revision', () => {
  const error = new Error(`MCP-W03 could not resolve authoritative state ${CANARY}`);
  error.name = PHASE4B_MCP_AUTHORITATIVE_STATE_UNAVAILABLE_ERROR_NAME;
  Object.assign(error, { code: 'MCP-W10' });
  const classified = classifyPhase4bMcpWriteError(error);
  assert.equal(classified.stableClass, 'stale_revision');
  assert.equal(classified.jsonRpcCode, MCP_WIRE_INVALID_PARAMS_ERROR_CODE);
  assert.equal(classified.retryable, true);
  assert.equal(classified.outcome, 'rejected');
  assert.equal(classified.safeMessage, 'Collection or parent revision is stale.');
  assert.equal(classified.safeMessage.includes(CANARY), false);
  const wire = toPhase4bMcpWriteRequestError(classified);
  assert.deepEqual(wire.data, { code: 'stale_revision' });
  assert.equal(JSON.stringify(wire).includes(CANARY), false);
  assert.equal(JSON.stringify(wire).includes('currentRevision'), false);
  const log = redactedPhase4bMcpWriteErrorLogFields(classified, 'corr-plan');
  assert.deepEqual(log, {
    correlationId: 'corr-plan',
    errorClass: 'stale_revision',
    outcome: 'rejected',
  });
});
