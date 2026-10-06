/**
 * COLP's explicit upstream MCP SDK boundary.
 *
 * This module is the single production place where `@modelcontextprotocol`
 * packages are imported and their allowlisted surface is re-exported, so the
 * dependency lock and the public type boundary are source-bound: if the
 * pinned SDK changes its exports, `npm run typecheck` fails loudly.
 *
 * - `@modelcontextprotocol/core` is a regular production dependency (future
 *   `src/mcp/2026-07-28` adapters import the allowlisted schemas/constants
 *   through here and packed consumers must be able to resolve it).
 * - `@modelcontextprotocol/client` / `@modelcontextprotocol/server` are
 *   devDependencies used only by the test harness under
 *   `tests/fixtures/mcp-2026-07-28/` and never enter the production tarball.
 *
 * Additions (OAuth client security adapter):
 * - The SDK's OAuth client vocabulary schemas (OAuthClientInformationSchema,
 *   OAuthClientMetadataSchema, OAuthMetadataSchema, OAuthTokensSchema, ...)
 *   are allowlisted and re-exported for the security/client adapter
 *   src/security/mcp-oauth-client.ts so COLP's OAuth client surface stays
 *   pinned to the SDK (docs/MCP_SDK_POLICY.md 3). OAuthClientMetadataSchema
 *   is used at runtime to validate the DCR body; the rest are the pinned OAuth
 *   vocabulary for the client adapter. The security module hand-rolls its
 *   wire security validation and never imports the dev-only client package.
 *
 * Additions (subscriptions/listen adapter):
 * - `SubscriptionsListenResultSchema` / `SubscriptionsListenResultMetaSchema`
 *   validate the empty listen result and its `_meta` (the result is only sent
 *   on graceful teardown; `_meta` carries the subscription id).
 * - `SubscriptionsAcknowledgedNotificationSchema` validates the leading
 *   `notifications/subscriptions/acknowledged` stream message.
 * - `SubscriptionFilterSchema` validates the request `notifications` opt-in
 *   filter (toolsListChanged / promptsListChanged / resourcesListChanged /
 *   resourceSubscriptions).
 * - `ResourceUpdatedNotificationSchema`, `ResourceListChangedNotificationSchema`,
 *   `ToolListChangedNotificationSchema` and `PromptListChangedNotificationSchema`
 *   validate every notification the listen adapter streams to the client.
 *
 * Additions (request/discovery/result adapters):
 * - `ImplementationSchema` validates the exact MCP implementation info shape
 *   used for `_meta` clientInfo / result serverInfo.
 * - `ResultMetaObjectSchema` validates the result `_meta` shape (the
 *   `2026-07-28` `ResultMetaObject`).
 * - `LOG_LEVEL_META_KEY`, `TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`,
 *   `BAGGAGE_META_KEY` are the remaining reserved `_meta` keys the per-request
 *   context adapter recognises (log-level opt-in and bounded trace context).
 * - The modern `_meta` envelope itself (protocolVersion + clientCapabilities
 *   requiredness, extension/trace budgets) is NOT exported by the core SDK —
 *   the SDK's `RequestMetaSchema` is the legacy 2025-11-25 shape, and the
 *   modern `RequestMetaEnvelopeSchema` lives inside the dev-only
 *   client/server codec. The adapter therefore implements envelope validation
 *   itself (contract layer), pinned to the same reserved keys and the SDK
 *   codec's `outboundEnvelope`/`validateEnvelopeMeta` behavior; see
 *   `src/mcp/2026-07-28/request-context.ts` and `docs/MCP_SDK_POLICY.md`.
 *
 * Deliberately NOT exported here:
 * - `SUPPORTED_PROTOCOL_VERSIONS` / `LATEST_PROTOCOL_VERSION` — the SDK's
 *   public constants are the legacy `initialize` interop list (the modern
 *   `2026-07-28` era is negotiated through `server/discover`, not through
 *   those constants). COLP's `MCP_PROTOCOL_VERSION` is authoritative.
 * - SDK private types, transport instances and request objects — those never
 *   cross COLP's shared/application ports.
 *
 * This neutral shared location prevents the Security package from depending
 * on an MCP adapter directory while keeping one SDK identity for both domains.
 *
 * @see ../../docs/MCP_SDK_POLICY.md
 */
import {
  DiscoverRequestSchema,
  DiscoverResultSchema,
  ImplementationSchema,
  ResultMetaObjectSchema,
  RequestMetaSchema,
  ResultSchema,
  SubscriptionsListenRequestSchema,
  SubscriptionsListenResultSchema,
  SubscriptionsListenResultMetaSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionFilterSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  ToolSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  OAuthClientInformationSchema,
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
  OAuthClientRegistrationErrorSchema,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokenRevocationRequestSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OpenIdProviderMetadataSchema,
} from '@modelcontextprotocol/core';
import {
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  SERVER_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
} from '@modelcontextprotocol/core/internal';

/** Exact pinned `@modelcontextprotocol/core` version (package.json dependency). */
export const MCP_SDK_CORE_VERSION = '2.3.1' as const;

/** The only MCP protocol revision COLP accepts; mirrors `MCP_PROTOCOL_VERSION`. */
export const MCP_SDK_PROTOCOL_VERSION = '2026-07-28' as const;

/**
 * Runtime schema symbols allowed to cross COLP's public boundary. COLP
 * derives its public request/result types structurally from these schemas
 * (the named `*Request`/`*Result` types exported by the harness packages are
 * test-only and never cross a production port).
 */
export const MCP_SDK_SCHEMA_ALLOWLIST = Object.freeze([
  'DiscoverRequestSchema',
  'DiscoverResultSchema',
  'SubscriptionsListenRequestSchema',
  'SubscriptionsListenResultSchema',
  'SubscriptionsListenResultMetaSchema',
  'SubscriptionsAcknowledgedNotificationSchema',
  'SubscriptionFilterSchema',
  'ResourceUpdatedNotificationSchema',
  'ResourceListChangedNotificationSchema',
  'ToolListChangedNotificationSchema',
  'PromptListChangedNotificationSchema',
  'RequestMetaSchema',
  'ResultSchema',
  'ImplementationSchema',
  'ResultMetaObjectSchema',
  'ToolSchema',
  'ResourceSchema',
  'ResourceTemplateSchema',
  'ListResourcesResultSchema',
  'ListResourceTemplatesResultSchema',
  'ReadResourceResultSchema',
  'ListToolsResultSchema',
  'CallToolResultSchema',
  'OAuthClientInformationSchema',
  'OAuthClientInformationFullSchema',
  'OAuthClientMetadataSchema',
  'OAuthClientRegistrationErrorSchema',
  'OAuthErrorResponseSchema',
  'OAuthMetadataSchema',
  'OAuthProtectedResourceMetadataSchema',
  'OAuthTokenRevocationRequestSchema',
  'OAuthTokensSchema',
  'OpenIdProviderDiscoveryMetadataSchema',
  'OpenIdProviderMetadataSchema',
] as const);

/**
 * Reserved `_meta` keys COLP recognises. Kept frozen so the runtime constant
 * set cannot be widened accidentally. The request adapter adds the log-level opt-in
 * and W3C trace-context keys used by the per-request context adapter.
 */
export const MCP_SDK_META_KEY_ALLOWLIST = Object.freeze([
  'PROTOCOL_VERSION_META_KEY',
  'SUBSCRIPTION_ID_META_KEY',
  'CLIENT_CAPABILITIES_META_KEY',
  'CLIENT_INFO_META_KEY',
  'SERVER_INFO_META_KEY',
  'LOG_LEVEL_META_KEY',
  'TRACEPARENT_META_KEY',
  'TRACESTATE_META_KEY',
  'BAGGAGE_META_KEY',
] as const);

/**
 * Public type names COLP permits in its public API, derived from the
 * allowlisted schemas above (documented in docs/MCP_SDK_POLICY.md §Public
 * type allowlist). Kept frozen and asserted against the policy document.
 */
export const MCP_SDK_PUBLIC_TYPE_ALLOWLIST = Object.freeze([
  'DiscoverRequest',
  'DiscoverResult',
  'SubscriptionsListenRequest',
  'SubscriptionsListenResult',
  'SubscriptionsAcknowledgedNotification',
  'ResourceUpdatedNotification',
  'ResourceListChangedNotification',
  'ToolListChangedNotification',
  'PromptListChangedNotification',
  'RequestMeta',
  'ResultMetaObject',
  'Implementation',
  'Tool',
  'Resource',
  'ResourceTemplate',
  'ListResourcesResult',
  'ListResourceTemplatesResult',
  'ReadResourceResult',
  'ListToolsResult',
  'CallToolResult',
] as const);

export {
  DiscoverRequestSchema,
  DiscoverResultSchema,
  SubscriptionsListenRequestSchema,
  SubscriptionsListenResultSchema,
  SubscriptionsListenResultMetaSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionFilterSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  RequestMetaSchema,
  ResultSchema,
  ImplementationSchema,
  ResultMetaObjectSchema,
  PROTOCOL_VERSION_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  SERVER_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  BAGGAGE_META_KEY,
  ToolSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  ListToolsResultSchema,
  CallToolResultSchema,
  OAuthClientInformationSchema,
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
  OAuthClientRegistrationErrorSchema,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokenRevocationRequestSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OpenIdProviderMetadataSchema,
};
