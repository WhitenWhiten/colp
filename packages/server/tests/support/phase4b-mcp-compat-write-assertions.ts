/**
 * Pure response assertions shared by the MCP compat unit and PostgreSQL
 * lifecycle suites. Keep this module free of in-memory Write fixtures: those
 * fixtures execute COLP source directly and therefore require the COLP
 * workspace's development dependency closure.
 */
import assert from 'node:assert/strict';
import {
  assertCompatCallToolEnvelope,
  compatJsonRpc,
} from './phase4b-mcp-compat-admission.js';

export function listedToolNames(response: {
  readonly headers: Record<string, unknown>;
  readonly payload: string;
}): string[] {
  const tools = compatJsonRpc(response).result?.tools as
    | readonly { readonly name: string }[]
    | undefined;
  return (tools ?? []).map((tool) => tool.name);
}

export function listedTool(
  response: { readonly headers: Record<string, unknown>; readonly payload: string },
  name: string,
): {
  readonly name: string;
  readonly inputSchema?: {
    readonly type?: string;
    readonly additionalProperties?: unknown;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, unknown>>;
  };
  readonly outputSchema?: unknown;
} | undefined {
  const tools = compatJsonRpc(response).result?.tools as
    | readonly Record<string, unknown>[]
    | undefined;
  return tools?.find((tool) => tool.name === name) as ReturnType<typeof listedTool>;
}

export function assertAwaitingApproval(
  result: Record<string, unknown> | undefined,
  expectedPlanId?: string,
): {
  readonly planId: string;
  readonly approvalUri: string;
  readonly expiresAt: string;
} {
  assertCompatCallToolEnvelope(result);
  assert.equal(result?.isError === true, false, 'awaiting_approval must not set isError');
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  assert.ok(structured, 'awaiting_approval structuredContent is required');
  assert.equal(structured.status, 'awaiting_approval');
  assert.equal(typeof structured.planId, 'string');
  assert.ok(String(structured.planId).length > 0);
  assert.equal(typeof structured.approvalUri, 'string');
  assert.ok(String(structured.approvalUri).length > 0);
  assert.equal(typeof structured.expiresAt, 'string');
  if (expectedPlanId !== undefined) assert.equal(structured.planId, expectedPlanId);
  const text = (result?.content as readonly { readonly text?: string }[] | undefined)?.[0]?.text ?? '';
  assert.match(text, /awaiting_approval/u);
  assert.match(text, new RegExp(String(structured.planId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(text, /approvalUri/u);
  assert.match(text, new RegExp(String(structured.expiresAt).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  const payload = JSON.stringify(result);
  assert.doesNotMatch(payload, /bindingSummary|requestState|inputRequests|elicitation/u);
  return {
    planId: String(structured.planId),
    approvalUri: String(structured.approvalUri),
    expiresAt: String(structured.expiresAt),
  };
}

export function assertRejectedWrite(result: Record<string, unknown> | undefined): void {
  assertCompatCallToolEnvelope(result);
  assert.equal(result?.isError, true);
  const text = JSON.stringify(result?.content ?? []);
  assert.ok(text.length > 0);
  assert.doesNotMatch(text, /McpChangePlanError|relation |SELECT |Bearer |eyJ/u);
}

export function assertNoMrtrOrElicitation(payload: string): void {
  assert.doesNotMatch(payload, /"requestState"|"inputRequests"|"elicitationId"|"elicitation\/create"/u);
}
