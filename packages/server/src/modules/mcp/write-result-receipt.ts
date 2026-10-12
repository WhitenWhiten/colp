import type { Mcp20260728Result } from '@know-n/colp/mcp';
import { createPhase4bMcpResult } from './results.js';

const DIRECT_WRITES = new Set([
  'collections.create', 'collections.update', 'nodes.create', 'nodes.update',
  'annotations.create', 'annotations.update',
]);

/** Add explicit application state without replacing established result fields. */
export function withWriteReceipt(result: Mcp20260728Result, name: string): Mcp20260728Result {
  if (!DIRECT_WRITES.has(name) || result.resultType !== 'complete' || result.isError) return result;
  const output = result.structuredContent as Readonly<Record<string, unknown>> | undefined;
  if (output === undefined) return result;
  const applied = output.resultType !== 'preview';
  const receipt = { ...output, applied, status: applied ? 'committed' : 'preview' };
  return createPhase4bMcpResult({ method: 'tools/call', fields: {
    structuredContent: receipt, content: [{ type: 'text', text: JSON.stringify(receipt) }],
  } }, true);
}

export function withWriteReceiptSchema(tool: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (typeof tool.name !== 'string' || !DIRECT_WRITES.has(tool.name)) return tool;
  const schema = tool.outputSchema as Record<string, unknown>;
  return { ...tool, outputSchema: { ...schema, properties: {
    ...schema.properties as Record<string, unknown>,
    applied: { type: 'boolean' }, status: { enum: ['committed', 'preview'] },
  } } };
}
