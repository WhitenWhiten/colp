/**
 * Era-neutral MCP tool and resource catalog descriptors (T-01).
 *
 * Descriptors wrap the existing frozen schemas in `read-tools.ts` /
 * `write-tools.ts` and host resource MIME constants. Do not paste a second
 * copy of those schemas or resource templates here.
 */
import type { McpApplicationContext } from './application-context.js';
import {
  NODES_SEARCH_DESCRIPTION,
  NODES_SEARCH_PROFILE_CLAIM,
  NODES_SEARCH_TOOL_NAME,
  nodesSearchDefinition,
} from './nodes-search.js';
import {
  collectionsGetDefinition,
  collectionsGetSnapshotDefinition,
  nodesGetDefinition,
  PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES,
  hasAnyPhase4bMcpReadScope,
} from './read-tools.js';
import {
  PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES,
  PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES,
  hasAnyPhase4bMcpWriteScope,
  type Phase4bMcpWriteToolName,
} from './write-tools.js';
import {
  PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE,
} from './collection-resources.js';
import {
  PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE,
} from './node-resources.js';

export interface McpApplicationToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly requiredScopes: readonly string[];
  /** Optional mcp-read tool (F1): servers MAY implement it; risk is none. */
  readonly optional?: true;
  readonly risk?: 'none';
  readonly profileClaim?: typeof NODES_SEARCH_PROFILE_CLAIM;
  /**
   * True when the tool exists only on the compat surface
   * (`/collections/-/mcp-compat`); strict `/collections/-/mcp` never lists
   * it and the strict tools/call adapters never dispatch it. Facade call
   * dispatch stays endpoint-neutral — the compat adapter is the only wire
   * path that reaches these names.
   */
  readonly compatOnly?: true;
}

export interface McpApplicationResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface McpApplicationResourceTemplateDescriptor {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

const readRequiredScopes = PHASE4B_MCP_READ_TOOL_REQUIRED_SCOPES;

export const PHASE4B_MCP_READ_TOOL_CATALOG: readonly McpApplicationToolDescriptor[] = Object.freeze([
  Object.freeze({
    name: collectionsGetDefinition.name,
    description: collectionsGetDefinition.description,
    inputSchema: collectionsGetDefinition.inputSchema,
    outputSchema: collectionsGetDefinition.outputSchema,
    requiredScopes: readRequiredScopes,
  }),
  Object.freeze({
    name: collectionsGetSnapshotDefinition.name,
    description: collectionsGetSnapshotDefinition.description,
    inputSchema: collectionsGetSnapshotDefinition.inputSchema,
    outputSchema: collectionsGetSnapshotDefinition.outputSchema,
    requiredScopes: readRequiredScopes,
  }),
  Object.freeze({
    name: nodesGetDefinition.name,
    description: nodesGetDefinition.description,
    inputSchema: nodesGetDefinition.inputSchema,
    outputSchema: nodesGetDefinition.outputSchema,
    requiredScopes: readRequiredScopes,
  }),
]);

/** Optional read-profile tool. Not part of the frozen three-tool P4B list. */
export const NODES_SEARCH_TOOL_DESCRIPTOR: McpApplicationToolDescriptor = Object.freeze({
  name: NODES_SEARCH_TOOL_NAME,
  description: NODES_SEARCH_DESCRIPTION,
  inputSchema: nodesSearchDefinition.inputSchema,
  outputSchema: nodesSearchDefinition.outputSchema,
  requiredScopes: Object.freeze([NODES_SEARCH_PROFILE_CLAIM.scope]),
  optional: true,
  risk: NODES_SEARCH_PROFILE_CLAIM.risk,
  profileClaim: NODES_SEARCH_PROFILE_CLAIM,
});

export const PHASE4B_MCP_WRITE_TOOL_SCOPE_CATALOG: Readonly<
  Record<Phase4bMcpWriteToolName, readonly string[]>
> = PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES;

export const PHASE4B_MCP_COLLECTION_TEMPLATE_MIME_TYPE = PHASE4B_MCP_COLLECTION_RESOURCE_MIME_TYPE;
export const PHASE4B_MCP_NODE_TEMPLATE_MIME_TYPE = PHASE4B_MCP_NODE_RESOURCE_MIME_TYPE;

export function canListApplicationReadTools(context: McpApplicationContext): boolean {
  if (context.principal.kind === 'anonymous') return true;
  return hasAnyPhase4bMcpReadScope(context.scopes);
}

export function canListApplicationWriteTools(context: McpApplicationContext): boolean {
  if (context.principal.kind !== 'authenticated') return false;
  return hasAnyPhase4bMcpWriteScope(context.scopes);
}

export function isApplicationWriteToolName(name: string): boolean {
  return (PHASE4B_MCP_WRITE_MOUNTED_TOOL_NAMES as readonly string[]).includes(name);
}

export function canCallApplicationWriteTool(
  context: McpApplicationContext,
  name: string,
): boolean {
  if (context.principal.kind !== 'authenticated') return false;
  if (!isApplicationWriteToolName(name)) return false;
  const required = PHASE4B_MCP_WRITE_TOOL_REQUIRED_SCOPES[name as Phase4bMcpWriteToolName];
  return required.every((scope) => context.scopes.includes(scope));
}

export function wireToolFromDescriptor(
  descriptor: McpApplicationToolDescriptor,
): Readonly<Record<string, unknown>> {
  const tool: Record<string, unknown> = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  };
  if (descriptor.outputSchema !== undefined) tool.outputSchema = descriptor.outputSchema;
  if (descriptor.title !== undefined) tool.title = descriptor.title;
  if (descriptor.annotations !== undefined) tool.annotations = descriptor.annotations;
  return Object.freeze(tool);
}
