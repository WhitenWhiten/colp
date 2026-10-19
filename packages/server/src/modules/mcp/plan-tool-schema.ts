import { isOrganizePlanRequest } from './organize-plan.js';
import { createCanonicalMcpSchemaReference, Mcp20260728RequestError } from '@know-n/colp/mcp';

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._~-]+$' };
const destination = { parentId: id, parentRef: id };
const organizeOperations = [
  { type: 'object', additionalProperties: false, properties: { type: { const: 'create_node' }, ref: id, ...destination,
    node: createCanonicalMcpSchemaReference('nodeCreate') }, required: ['type', 'node'],
    oneOf: [{ required: ['parentId'] }, { required: ['parentRef'] }] },
  { type: 'object', additionalProperties: false, properties: { type: { const: 'move_node' }, nodeId: id, ...destination,
    position: { type: 'integer', minimum: 0 } }, required: ['type', 'nodeId'],
    oneOf: [{ required: ['parentId'] }, { required: ['parentRef'] }] },
  { type: 'object', additionalProperties: false, properties: { type: { const: 'delete_subtree' }, nodeId: id }, required: ['type', 'nodeId'] },
];

/** Visibility plans retain their contract; organize plans use one collection and earlier-created folder references. */
export function narrowHostPlanSchema(tool: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (tool.name !== 'changes.plan') return tool;
  const schema = tool.inputSchema as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown>;
  const operations = properties.operations as Record<string, unknown>;
  const visibility = { ...schema, properties: { ...properties,
    operations: { ...operations, items: createCanonicalMcpSchemaReference('setVisibilityPlanOperation') },
  } };
  const organize = { ...schema, properties: { ...properties, collectionId: id,
    operations: { type: 'array', minItems: 1, maxItems: 50, items: { oneOf: organizeOperations } } },
    required: ['collectionId', 'operations', 'reason', 'dryRun'] };
  return { ...tool, inputSchema: { type: 'object', oneOf: [visibility, organize] } };
}

export function assertHostPlanOperations(args: unknown): void {
  if (typeof args !== 'object' || args === null) return; // Full shape validation belongs to the gateway.
  const operations = (args as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return;
  for (const operation of operations) {
    const allowed = isOrganizePlanRequest(args) ? ['create_node', 'move_node', 'delete_subtree'] : ['set_visibility'];
    if (typeof operation === 'object' && operation !== null && !allowed.includes(operation.type as string)) {
      throw new Mcp20260728RequestError('invalid_params',
        'Use visibility operations, or supply collectionId with create_node, move_node and delete_subtree operations.',
        { code: 'unsupported_operation' });
    }
  }
}
