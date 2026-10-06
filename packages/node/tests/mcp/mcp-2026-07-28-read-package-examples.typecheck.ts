/**
 * COLP-MCP-12: compile-time contract for the minimal host examples.
 *
 * Imports both example hosts so `npm run typecheck` compiles them as part of
 * the repository surface and proves:
 * - the Resource-only example uses only the Modern /mcp entry API;
 * - the Read Tools example uses only the Modern /mcp entry API and the
 *   stdio evidence mapper (no old `createMcpStdioCredentialBinding`);
 * - both handlers return the Modern result contract.
 */
import type { Mcp20260728Result } from '../../src/mcp/index.js';
import {
  handleResourceList,
  resourceAdapter,
} from './examples/resource-only-host.js';
import {
  handleToolCall,
  readToolAdapter,
} from './examples/read-tools-host.js';

export const resourceAdapterType: typeof resourceAdapter = null as never;
export const readToolAdapterType: typeof readToolAdapter = null as never;

// The example handlers return the Modern result shape (`resultType` closed).
declare const resourceResult: Awaited<ReturnType<typeof handleResourceList>>;
export const resourceResultType: Mcp20260728Result = resourceResult as Mcp20260728Result;

declare const toolResult: Awaited<ReturnType<typeof handleToolCall>>;
export const toolResultType: Mcp20260728Result = toolResult as Mcp20260728Result;
