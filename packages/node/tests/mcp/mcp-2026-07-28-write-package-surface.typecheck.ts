/**
 * COLP-MCP-13: compile-time contract for the Modern MCP Write package surface.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves:
 *
 * - the default `/mcp` entry exposes the Modern Write adapter factory and its
 *   options/status/result types;
 * - the explicit `/mcp/2026-07-28` entry exposes the same Write surface;
 * - the internal Write Gateway factory and the trusted write context type stay
 *   off the `/mcp` entries, while the Change Plan service and its public port
 *   types are deliberately exported for host composition (COLP-MCP-06/07
 *   surface).
 */
import type {
  Mcp20260728WriteToolAdapter,
  Mcp20260728WriteToolAdapterOptions,
  Mcp20260728WritePlanStatusPort,
  Mcp20260728PlanResolution,
  Mcp20260728PlanStatus,
  Mcp20260728WriteRequestStateError,
  createMcp20260728WriteToolAdapter,
} from '../../src/mcp/index.js';
import type {
  McpChangePlanService,
  McpChangePlanServiceOptions,
  McpChangePlanStoredDigestPort,
  McpPlanCommitResult,
  McpStoredPlan,
  createChangePlanService,
} from '../../src/mcp/index.js';
import type {
  createMcp20260728WriteToolAdapter as versionedCreateWriteToolAdapter,
  Mcp20260728WriteToolAdapter as VersionedWriteAdapter,
} from '../../src/mcp/2026-07-28/index.js';

export const writeAdapterType: Mcp20260728WriteToolAdapter = null as never;
export const versionedWriteAdapter: VersionedWriteAdapter = null as never;
export const writeOptionsType: Mcp20260728WriteToolAdapterOptions = null as never;
export const statusPortType: Mcp20260728WritePlanStatusPort = null as never;
export const planResolutionType: Mcp20260728PlanResolution = null as never;
export const planStatusType: Mcp20260728PlanStatus = 'pending';
export const requestStateErrorType: typeof Mcp20260728WriteRequestStateError = null as never;
export const writeFactory: typeof createMcp20260728WriteToolAdapter = null as never;
export const versionedWriteFactory: typeof versionedCreateWriteToolAdapter = null as never;
export const changePlanFactory: typeof createChangePlanService = null as never;
export const changePlanServiceType: McpChangePlanService = null as never;
export const changePlanOptionsType: McpChangePlanServiceOptions = null as never;
export const storedPlanType: McpStoredPlan = null as never;
export const commitResultType: McpPlanCommitResult = null as never;
export const storedDigestPortType: McpChangePlanStoredDigestPort = null as never;

// --- The internal write core stays off /mcp (COLP-MCP-12 boundary) ----
// @ts-expect-error McpTrustedWriteRequestContext is internal, never on /mcp
import { McpTrustedWriteRequestContext } from '../../src/mcp/index.js';
// @ts-expect-error createMcpWriteToolGateway is the internal COLP-MCP-06 factory
import { createMcpWriteToolGateway } from '../../src/mcp/index.js';
// @ts-expect-error createInMemoryPlanStore stays internal
import { createInMemoryPlanStore } from '../../src/mcp/index.js';
// @ts-expect-error the old write exposure factory stays internal
import { createMcpWriteExposure } from '../../src/mcp/index.js';
