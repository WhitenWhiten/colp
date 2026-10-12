import { createCanonicalMcpSchemaReference, Mcp20260728RequestError } from '@know-n/colp/mcp';

/** The generic host revision/execution ports implement visibility plans only. */
export function narrowHostPlanSchema(tool: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (tool.name !== 'changes.plan') return tool;
  const schema = tool.inputSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  const operations = properties.operations as Record<string, unknown>;
  return { ...tool, inputSchema: { ...schema, properties: { ...properties,
    operations: { ...operations, items: createCanonicalMcpSchemaReference('setVisibilityPlanOperation') },
  } } };
}

export function assertHostPlanOperations(args: unknown): void {
  if (typeof args !== 'object' || args === null) return; // Full shape validation belongs to the gateway.
  const operations = (args as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    if (typeof operation === 'object' && operation !== null && operation.type !== 'set_visibility') {
      throw new Mcp20260728RequestError('invalid_params',
        'changes.plan supports visibility changes. Use nodes.move or nodes.delete_subtree for moves and deletions.',
        { code: 'unsupported_operation' });
    }
  }
}
