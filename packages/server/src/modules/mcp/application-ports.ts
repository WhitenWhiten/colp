/**
 * Protocol-neutral MCP tool ports (MCP-CQ-08).
 *
 * Application services call these ports with {@link McpApplicationContext}.
 * Strict/compat adapters convert wire headers and `_meta` at their boundary.
 * This module must not import Fastify, the official MCP SDK, or COLP MCP wire.
 */
import type { McpApplicationContext } from './application-context.js';
import type { McpApplicationToolDescriptor } from './application-catalog.js';
import type { McpApplicationToolResult } from './application-results.js';

export interface McpApplicationToolPort {
  /** Optional direct lookup; visibility is evaluated for the current request. */
  readonly getTool?: (
    context: McpApplicationContext,
    name: string,
  ) => Promise<McpApplicationToolDescriptor | undefined>;
  readonly listTools: (
    context: McpApplicationContext,
    cursor?: string,
  ) => Promise<readonly McpApplicationToolDescriptor[]>;
  readonly callTool: (
    context: McpApplicationContext,
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Promise<McpApplicationToolResult>;
}

export type McpApplicationReadPort = McpApplicationToolPort;
export type McpApplicationWritePort = McpApplicationToolPort;

export async function findMcpApplicationTool(
  catalog: Pick<McpApplicationToolPort, 'getTool'> & {
    readonly listTools: (context: McpApplicationContext) => Promise<
      readonly McpApplicationToolDescriptor[] | { readonly tools: readonly McpApplicationToolDescriptor[] }
    >;
  },
  context: McpApplicationContext,
  name: string,
): Promise<McpApplicationToolDescriptor | undefined> {
  if (catalog.getTool !== undefined) return catalog.getTool(context, name);
  const listed = await catalog.listTools(context);
  const tools = 'tools' in listed ? listed.tools : listed;
  return tools.find((tool) => tool.name === name);
}
