/**
 * COLP-MCP-13: compile-time contract for the minimal Write host example.
 *
 * Imports the Write host example so `npm run typecheck` compiles it as part
 * of the repository surface and proves:
 * - the example uses the Modern `/mcp` entry API for the request context, the
 *   Modern Write adapter, the stdio evidence mapper and the status/result
 *   types;
 * - the example handler returns the Modern result contract
 *   (`Mcp20260728Result` with the closed `resultType` discriminator).
 */
import type { Mcp20260728Result } from '../../src/mcp/index.js';
import {
  handleWriteToolCall,
  writeToolAdapter,
} from './examples/write-host.js';

export const writeAdapterType: typeof writeToolAdapter = null as never;

declare const writeResult: Awaited<ReturnType<typeof handleWriteToolCall>>;
export const writeResultType: Mcp20260728Result = writeResult as Mcp20260728Result;

// The example handler accepts the MRTR retry channel (requestState + inputResponses).
declare const retryInput: Parameters<typeof handleWriteToolCall>[2];
export const retryRequestStateType: string | undefined = retryInput.requestState;
export const retryInputResponsesType: Readonly<Record<string, unknown>> | undefined =
  retryInput.inputResponses;
