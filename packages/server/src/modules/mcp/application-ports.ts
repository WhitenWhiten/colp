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
