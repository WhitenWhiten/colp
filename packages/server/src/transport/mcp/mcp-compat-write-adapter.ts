/**
 * T-06 legacy write-tool schema and CallToolResult mapping for
 * `/collections/-/mcp-compat`.
 *
 * Registers real `inputSchema` from facade descriptors. Compat `tools/list`
 * compiles a clone with `x-mcp-header` stripped (MCP 2026-07-28 extension);
 * the facade object is not mutated so strict `/collections/-/mcp` still
 * advertises the header. Maps the era-neutral result union to 2025-11-25
 * CallToolResult. Read tools advertise their structured JSON output schema;
 * community compat tools carry the contract's success-or-`ProductErrorEnvelope`
 * union. Other write tools retain their schema-less listing and legacy
 * approval result shape. Approval stays
 * out-of-band: no elicitation, sampling, or server requests.
 */
import { fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import { materializeClosedMcpToolSchema } from '@know-n/colp/mcp';
import type {
  McpApplicationToolDescriptor,
  McpApplicationToolResult,
} from '../../modules/mcp/index.js';

const MCP_COMPAT_TOOL_ARGS_SCHEMA = fromJsonSchema({
  type: 'object',
  additionalProperties: true,
});

const compiledInputSchemas = new WeakMap<object, ReturnType<typeof fromJsonSchema>>();
const compiledOutputSchemas = new WeakMap<object, ReturnType<typeof fromJsonSchema>>();
const X_MCP_HEADER_KEY = 'x-mcp-header';

/** JSON Schema → SDK input schema. Compiles a stripped clone; facade `inputSchema` is unchanged. */
export function compatListedToolInputSchema(
  tool: McpApplicationToolDescriptor,
): ReturnType<typeof fromJsonSchema> {
  const schema = tool.inputSchema;
  if (schema === undefined || typeof schema !== 'object' || Array.isArray(schema)) {
    return MCP_COMPAT_TOOL_ARGS_SCHEMA;
  }
  const cached = compiledInputSchemas.get(schema);
  if (cached !== undefined) return cached;
  const compiled = fromJsonSchema(
    schemaForCompatValidator(schema) as Parameters<typeof fromJsonSchema>[0],
  );
  compiledInputSchemas.set(schema, compiled);
  return compiled;
}

/**
 * Read tools already return object-shaped structuredContent, so publish their
 * declared schema alongside it. Community compat tools also publish their
 * success-or-ProductErrorEnvelope union. Other write tools keep their legacy
 * schema-less listing because pending approval may have a different shape.
 */
export function compatListedToolOutputSchema(
  tool: McpApplicationToolDescriptor,
): ReturnType<typeof fromJsonSchema> | undefined {
  const schema = tool.compatOnly === true || tool.annotations?.readOnlyHint === true
    ? tool.outputSchema : undefined;
  if (schema === undefined) return undefined;
  const cached = compiledOutputSchemas.get(schema);
  if (cached !== undefined) return cached;
  const compiled = fromJsonSchema(
    schemaForCompatValidator(schema) as Parameters<typeof fromJsonSchema>[0],
  );
  compiledOutputSchemas.set(schema, compiled);
  return compiled;
}

/** Facade/tool result → SDK/execution class. `awaiting_approval` is a successful mapping. */
export function legacyCallToolExecutionClass(
  result: McpApplicationToolResult,
): 'ok' | 'rejected' {
  if (result.kind === 'rejected') return 'rejected';
  if (result.kind === 'complete' && result.isError === true) return 'rejected';
  return 'ok';
}

/**
 * §3.4 legacy mapping. Complete is an ordinary CallToolResult. Awaiting
 * approval is a non-error complete result whose text and structuredContent
 * both carry status/planId/approvalUri/expiresAt. Rejected is isError plus
 * the stable safeMessage. 07-28 envelope keys stay off this era.
 */
export function mapLegacyCallToolResult(
  result: McpApplicationToolResult,
  toolName?: string,
): CallToolResult {
  if (result.kind === 'complete') {
    const content = Array.isArray(result.content)
      ? (result.content as CallToolResult['content'])
        // The snapshot JSON (including pagination) is already inline. Its
        // companion resource link can send ChatGPT down a file delivery path.
        // Keep explicit resources/read and other tools' resource blocks intact.
        .filter(block => !(toolName === 'collections.get_snapshot'
          && result.structuredContent !== undefined && block.type === 'resource_link'))
        .map(omitCompatFractionalPriority)
      : [{ type: 'text' as const, text: '' }];
    return {
      content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent as Record<string, unknown> }),
      ...(result.isError === true ? { isError: true } : {}),
    };
  }
  if (result.kind === 'rejected') {
    return {
      isError: true,
      content: [{ type: 'text', text: result.safeMessage }],
    };
  }
  const awaiting = Object.freeze({
    status: 'awaiting_approval',
    planId: result.planId,
    approvalUri: result.approvalUri,
    expiresAt: result.expiresAt,
  });
  return {
    content: [{ type: 'text', text: JSON.stringify(awaiting) }],
    structuredContent: { ...awaiting },
  };
}

/**
 * Codex 0.162.1 rejects fractional annotation priorities with `Unexpected
 * response type`. Omit this optional hint at the compat boundary without
 * changing the shared result used by the strict endpoint.
 */
function omitCompatFractionalPriority(
  block: CallToolResult['content'][number],
): CallToolResult['content'][number] {
  if (block.annotations?.priority === undefined || Number.isInteger(block.annotations.priority)) {
    return block;
  }
  const annotations = { ...block.annotations };
  delete annotations.priority;
  return { ...block, annotations };
}

function schemaForCompatValidator(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return stripXMcpHeaderKey(materializeClosedMcpToolSchema(schema)) as Record<string, unknown>;
}

/** Clone-walk that drops `x-mcp-header` from properties, items, combinators, and `$defs`. */
function stripXMcpHeaderKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripXMcpHeaderKey);
  if (value === null || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === X_MCP_HEADER_KEY) continue;
    next[key] = stripXMcpHeaderKey(child);
  }
  return next;
}
