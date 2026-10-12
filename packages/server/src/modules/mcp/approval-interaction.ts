import type { Mcp20260728RequestContext, Mcp20260728Result } from '@know-n/colp/mcp';
import { createPhase4bMcpResult } from './results.js';

const pendingSchema = {
  type: 'object', additionalProperties: false,
  properties: { status: { const: 'awaiting_approval' }, planId: { type: 'string' },
    approvalUri: { type: 'string' }, expiresAt: { type: 'string' } },
  required: ['status', 'planId', 'approvalUri', 'expiresAt'],
};

/** Keep deployment interoperable with the currently pinned, published COLP SDK. */
export function withApprovalSchema(tool: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (tool.name !== 'changes.plan' && tool.name !== 'changes.commit') return tool;
  const schema = tool.outputSchema as Record<string, unknown>;
  const branches = schema.anyOf as typeof pendingSchema[] | undefined;
  if (branches?.some((branch) => branch.properties?.status?.const === 'awaiting_approval')) return tool;
  return { ...tool, outputSchema: { anyOf: [schema, pendingSchema] } };
}

/** Translate the older SDK's empty MRTR request into standard URL interaction. */
export function withApprovalInteraction(
  result: Mcp20260728Result,
  context: Mcp20260728RequestContext,
  inputResponses: unknown,
): Mcp20260728Result {
  if (result.resultType !== 'input_required') return result;
  const requests = result.inputRequests as Record<string, unknown> | undefined;
  if (requests && Object.keys(requests).length > 0) return result; // Newer SDK already supplied the standard prompt.
  const plan = result.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan.planId !== 'string' || typeof plan.approvalUri !== 'string' || typeof plan.expiresAt !== 'string') {
    throw new TypeError('Pending approval is missing its plan, URL or expiry.');
  }
  const capability = context.clientCapabilities.elicitation as { url?: unknown } | undefined;
  const answered = typeof inputResponses === 'object' && inputResponses !== null && Object.hasOwn(inputResponses, 'approval');
  if (!capability?.url || answered) {
    const pending = { status: 'awaiting_approval', planId: plan.planId, approvalUri: plan.approvalUri, expiresAt: plan.expiresAt };
    return createPhase4bMcpResult({ method: 'tools/call', fields: {
      structuredContent: pending, content: [{ type: 'text', text: JSON.stringify(pending) }],
    } }, true);
  }
  return createPhase4bMcpResult({ method: 'tools/call', resultType: 'input_required', fields: {
    plan, requestState: result.requestState,
    inputRequests: { approval: { method: 'elicitation/create', params: {
      mode: 'url', message: 'Review this change at the approval link. Only the owner can approve it.',
      url: plan.approvalUri, elicitationId: plan.planId,
    } } },
  } }, true);
}
