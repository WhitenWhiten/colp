/**
 * COLP-MCP-12: compile-time contract for the Modern MCP Read package surface.
 *
 * This file is never executed (vitest only discovers `*.test.ts`); it is
 * type-checked by `npm run typecheck`. Every `@ts-expect-error` below must
 * actually error, so `tsc --noEmit` passing proves:
 *
 * - the default `/mcp` entry (`src/mcp/index.ts`) exposes the Modern
 *   Read/shared types (request context, discovery/result, Resource/Read Tool
 *   adapters, listen, authorization, OAuth client) as public types;
 * - the explicit `/mcp/2026-07-28` entry exposes the same surface;
 * - `McpSessionBinding`, `McpReadResourceServerSession`, the old stdio
 *   factory and the old read/write adapter factories no longer exist on the
 *   `/mcp` entry;
 * - the package root no longer re-exports MCP adapters or the MCP
 *   wire-version constants, so importing them from the root is a compile
 *   error.
 */
import type {
  Mcp20260728RequestContext,
  createMcp20260728RequestContext,
} from '../../src/mcp/index.js';
import type {
  McpChangePlanService,
  McpChangePlanServiceOptions,
  McpChangePlanStoredDigestPort,
  createChangePlanService,
} from '../../src/mcp/index.js';
import type {
  Mcp20260728DiscoverResult,
  Mcp20260728Result,
  createMcp20260728DiscoverResult,
  createMcp20260728Result,
} from '../../src/mcp/index.js';
import type {
  Mcp20260728ResourceAdapter,
  Mcp20260728ReadToolAdapter,
  Mcp20260728SubscriptionsListenAdapter,
  createMcp20260728ResourceAdapter,
  createMcp20260728ReadToolAdapter,
  createMcp20260728SubscriptionsListenAdapter,
} from '../../src/mcp/index.js';
import type {
  McpAuthorizationBinding,
  McpStatelessReadCore,
  McpStatelessToolCore,
  createAnonymousPublicBinding,
  createMcpStatelessReadCore,
  createMcpStatelessToolCore,
  mapStdioEvidenceToAuthenticatedBinding,
} from '../../src/mcp/index.js';
import type { enforceOAuthPkce, OAuthClientMetadataDocument } from '../../src/mcp/index.js';
import type { MCP_PROTOCOL_VERSION, supportedMcpProtocolVersions } from '../../src/mcp/index.js';

// The versioned entry must expose the same Modern surface.
import type {
  Mcp20260728RequestContext as VersionedRequestContext,
  createMcp20260728ResourceAdapter as versionedCreateResourceAdapter,
  enforceOAuthPkce as versionedEnforceOAuthPkce,
} from '../../src/mcp/2026-07-28/index.js';

// The Modern surface is usable as public types.
export const requestContextType: Mcp20260728RequestContext = null as never;
export const changePlanFactory: typeof createChangePlanService = null as never;
export const changePlanServiceType: McpChangePlanService = null as never;
export const changePlanOptionsType: McpChangePlanServiceOptions = null as never;
export const storedDigestPortType: McpChangePlanStoredDigestPort = null as never;
export const versionedContext: VersionedRequestContext = null as never;
export const discoverResult: Mcp20260728DiscoverResult = null as never;
export const result: Mcp20260728Result = null as never;
export const resourceAdapter: Mcp20260728ResourceAdapter = null as never;
export const readToolAdapter: Mcp20260728ReadToolAdapter = null as never;
export const listenAdapter: Mcp20260728SubscriptionsListenAdapter = null as never;
export const binding: McpAuthorizationBinding = null as never;
export const readCore: McpStatelessReadCore = null as never;
export const toolCore: McpStatelessToolCore = null as never;
export const oauthDocument: OAuthClientMetadataDocument = null as never;

// The factories/constants exist as values.
export const requestContextFactory: typeof createMcp20260728RequestContext = null as never;
export const discoverFactory: typeof createMcp20260728DiscoverResult = null as never;
export const resultFactory: typeof createMcp20260728Result = null as never;
export const resourceFactory: typeof createMcp20260728ResourceAdapter = null as never;
export const readToolFactory: typeof createMcp20260728ReadToolAdapter = null as never;
export const listenFactory: typeof createMcp20260728SubscriptionsListenAdapter = null as never;
export const anonymousFactory: typeof createAnonymousPublicBinding = null as never;
export const readCoreFactory: typeof createMcpStatelessReadCore = null as never;
export const toolCoreFactory: typeof createMcpStatelessToolCore = null as never;
export const stdioMapper: typeof mapStdioEvidenceToAuthenticatedBinding = null as never;
export const oauthPkce: typeof enforceOAuthPkce = null as never;
export const versionedResourceFactory: typeof versionedCreateResourceAdapter = null as never;
export const versionedOauthPkce: typeof versionedEnforceOAuthPkce = null as never;
export const protocolVersion: typeof MCP_PROTOCOL_VERSION = '2026-07-28';
export const supportedVersions: typeof supportedMcpProtocolVersions = ['2026-07-28'];

// --- Legacy / Session-oriented / old-factory symbols are gone from /mcp ----
// @ts-expect-error McpSessionBinding was removed in COLP-MCP-12
import { McpSessionBinding } from '../../src/mcp/index.js';
// @ts-expect-error McpReadResourceServerSession was removed in COLP-MCP-12
import { McpReadResourceServerSession } from '../../src/mcp/index.js';
// @ts-expect-error createMcpStdioCredentialBinding was removed in COLP-MCP-12
import { createMcpStdioCredentialBinding } from '../../src/mcp/index.js';
// @ts-expect-error createMcpReadToolGateway is an old pre-Modern factory, not on /mcp
import { createMcpReadToolGateway } from '../../src/mcp/index.js';
// @ts-expect-error createMcpReadExposure is an old pre-Modern factory, not on /mcp
import { createMcpReadExposure } from '../../src/mcp/index.js';
// @ts-expect-error createMcpWriteExposure is an old pre-Modern factory, not on /mcp
import { createMcpWriteExposure } from '../../src/mcp/index.js';
// @ts-expect-error the old stdio credential configuration error is gone
import { McpStdioCredentialConfigurationError } from '../../src/mcp/index.js';
// @ts-expect-error the old read mount adapter is not on /mcp
import { createMcpReadMountAdapter } from '../../src/mcp/index.js';

// --- The package root no longer re-exports MCP adapters or wire metadata ----
// @ts-expect-error the root no longer re-exports MCP adapters
import { createMcpReadToolGateway as rootReadGateway } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports MCP adapters
import { createMcpStdioCredentialBinding as rootStdioBinding } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports MCP adapters
import { createMcpWriteExposure as rootWriteExposure } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports MCP adapters
import { McpSessionBinding as rootSessionBinding } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports the MCP wire-version constant
import { MCP_PROTOCOL_VERSION as rootProtocolVersion } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports the MCP wire-version list
import { supportedMcpProtocolVersions as rootSupportedVersions } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports Modern MCP adapters
import { createMcp20260728ResourceAdapter as rootResourceAdapter } from '../../src/index.js';
// @ts-expect-error the root no longer re-exports Modern MCP adapters
import { createMcp20260728SubscriptionsListenAdapter as rootListenAdapter } from '../../src/index.js';
