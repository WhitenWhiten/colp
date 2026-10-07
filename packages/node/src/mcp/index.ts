/**
 * Modern MCP Read package surface — default `/mcp` entry.
 *
 * This entry is the only supported place to import the completed Modern
 * `2026-07-28` Read + shared MCP surface. It deliberately does NOT export
 * the legacy Session binding, the legacy read server session, the
 * handshake method, old subscription methods, Legacy transport types, or
 * the pre-Modern adapter / factory signatures (those are removed or kept
 * internal-only). The explicit versioned entry
 * `@know-n/colp/mcp/2026-07-28` exposes the exact same
 * surface; see `src/mcp/2026-07-28/index.ts`.
 *
 * Package consumers must explicitly choose `/mcp` (or `/mcp/2026-07-28`);
 * the package root keeps only cross-profile stable metadata and
 * never re-exports MCP adapters (migration decision §8.2, development plan
 * §2).
 *
 * Surface families:
 * - stable version metadata (`protocol-version.js`)
 * - generic authorization bindings (`shared/authorization.js`)
 * - stateless shared Resource/Tool cores (`shared/resources|tools`)
 * - protocol-neutral change signals (`shared/change-signal.ts`)
 * - per-request context / discovery / results (`2026-07-28/*`)
 * - Modern Resource + Read Tool adapters (`2026-07-28/*`)
 * - subscriptions/listen (`2026-07-28/subscriptions.ts`)
 * - schema budget + pinned SDK boundary (`2026-07-28/schema-budget|sdk-boundary`)
 * - OAuth client security (`security/mcp-oauth-client.ts`)
 */
export {
  MCP_PROTOCOL_VERSION,
  supportedMcpProtocolVersions,
} from './protocol-version.js';

export {
  McpAuthorizationBindingError,
  RAW_SECRET_KEY_NAMES,
  RAW_SECRET_PREFIXES,
  assertAuthenticatedBinding,
  assertBindingMatchesResourceAudience,
  assertBindingMatchesSecurityEpoch,
  bindingMatchesResourceAudience,
  bindingMatchesSecurityEpoch,
  containsRawSecretMarker,
  createAnonymousPublicBinding,
  createAuthenticatedBinding,
  isMcpAnonymousAuthorizationBinding,
  isMcpAuthenticatedAuthorizationBinding,
  isMcpAuthorizationBinding,
  mapApiKeyEvidenceToAuthenticatedBinding,
  mapOAuthEvidenceToAuthenticatedBinding,
  mapServiceEvidenceToAuthenticatedBinding,
  mapStdioEvidenceToAuthenticatedBinding,
  requireAuthenticatedWriteBinding,
  snapshotMcpAuthorizationBinding,
  type McpAnonymousAuthorizationBinding,
  type McpAnonymousBindingInput,
  type McpApiKeyCredentialEvidence,
  type McpAuthenticatedAuthorizationBinding,
  type McpAuthorizationBinding,
  type McpAuthorizationBindingErrorCode,
  type McpCredentialKind,
  type McpHostCredentialEvidence,
  type McpOAuthCredentialEvidence,
  type McpServiceCredentialEvidence,
  type McpStdioCredentialEvidence,
} from './shared/authorization.js';

export {
  DEFAULT_MCP_RESOURCE_READ_BUDGET,
  McpReadRequestAbortedError,
  McpReadRequestContextError,
  McpResourceNotFoundError,
  McpResourceRequestError,
  createMcpStatelessReadCore,
  requireTrustedReadRequestContext,
  resolveMcpResourceReadBudget,
  type McpReadClockPort,
  type McpResourceContentProjection,
  type McpResourceListInput,
  type McpResourceListItem,
  type McpResourceListResult,
  type McpResourceProjectionPort,
  type McpResourceProvenance,
  type McpResourceReadBudget,
  type McpResourceReadResult,
  type McpStatelessReadCore,
  type McpStatelessReadCoreOptions,
  type McpTrustedReadRequestContext,
} from './shared/resources.js';

export {
  createCanonicalMcpSchemaReference,
  materializeClosedMcpToolSchema,
  type CanonicalMcpSchemaReference,
} from './schema-ref.js';

export {
  McpInvalidToolNameError,
  McpToolOutputUnavailableError,
  McpUnknownToolError,
  createMcpStatelessToolCore,
  type McpReadToolResult,
  type McpStatelessToolCore,
  type McpStatelessToolCoreOptions,
  type McpToolDefinition,
  type McpToolExecutionPort,
  type McpToolRegistration,
} from './shared/tools.js';

export {
  McpChangeSignalError,
  isMcpChangeSignal,
  isMcpChangeSignalType,
  requireMcpChangeSignal,
  snapshotMcpChangeSignal,
  type McpChangeSignal,
  type McpChangeSignalListener,
  type McpChangeSignalSourcePort,
  type McpChangeSignalSubscription,
  type McpChangeSignalType,
} from './shared/change-signal.js';

export {
  MCP_20260728_EXPECTED_ENVELOPE_HINT,
  MCP_20260728_REQUIRED_HEADERS_HINT,
  MCP_PARAM_BASE64_SENTINEL_PREFIX,
  MCP_PARAM_BASE64_SENTINEL_SUFFIX,
  MCP_WIRE_HEADER_MISMATCH_ERROR_CODE,
  MCP_WIRE_INTERNAL_ERROR_CODE,
  MCP_WIRE_INVALID_PARAMS_ERROR_CODE,
  MCP_WIRE_INVALID_REQUEST_ERROR_CODE,
  MCP_WIRE_MISSING_REQUIRED_CLIENT_CAPABILITY_ERROR_CODE,
  MCP_WIRE_UNSUPPORTED_PROTOCOL_VERSION_ERROR_CODE,
  Mcp20260728RequestError,
  createMcp20260728RequestContext,
  decodeMcp20260728ParamValue,
  encodeMcp20260728ParamValue,
  isMcp20260728Rfc9110Token,
  mayEmitMcp20260728LogNotification,
  needsMcp20260728Base64Encoding,
  parseMcp20260728RequestHeaders,
  requireMcp20260728ClientCapability,
  requireMcp20260728RequestContext,
  scanMcp20260728XMcpHeaderDeclarations,
  validateMcp20260728ParamHeaders,
  type Mcp20260728ClientInfo,
  type Mcp20260728ExtensionBudget,
  type Mcp20260728HeaderField,
  type Mcp20260728LogLevel,
  type Mcp20260728OriginEvidence,
  type Mcp20260728RequestContext,
  type Mcp20260728RequestContextInput,
  type Mcp20260728RequestHeaders,
  type Mcp20260728TraceBudget,
  type Mcp20260728TraceContext,
  type Mcp20260728TransportEvidence,
  type Mcp20260728WireErrorKind,
  type Mcp20260728XMcpHeaderDeclaration,
  type Mcp20260728XMcpHeaderScanResult,
} from './2026-07-28/request-context.js';

export {
  createMcp20260728DiscoverResult,
  validateMcp20260728DiscoverRequest,
  type Mcp20260728DiscoverInput,
  type Mcp20260728DiscoverResult,
  type Mcp20260728ServerCapabilities,
} from './2026-07-28/discovery.js';

export {
  MCP_20260728_CACHEABLE_RESULT_METHODS,
  MCP_20260728_EXTENDED_RESULT_TYPE_METHODS,
  createMcp20260728Result,
  normalizeMcp20260728Error,
  type Mcp20260728CacheMetadata,
  type Mcp20260728CacheScope,
  type Mcp20260728Result,
  type Mcp20260728ResultInput,
  type Mcp20260728ResultType,
  type Mcp20260728ServerInfo,
  type Mcp20260728WireError,
} from './2026-07-28/results.js';

export {
  createMcp20260728ResourceAdapter,
  type Mcp20260728CacheableResourceMethod,
  type Mcp20260728ResourceAdapter,
  type Mcp20260728ResourceAdapterOptions,
} from './2026-07-28/resources.js';

export {
  createMcpResourceUriCodec,
  type McpReadResource,
  type McpResourceUriCodec,
} from './resource-uri.js';
export {
  createMcpResourceTemplates,
  type McpResourceTemplate,
  type McpResourceTemplates,
} from './resource-templates.js';

export {
  Mcp20260728ReadToolSecretMarkerError,
  createMcp20260728ReadToolAdapter,
  type Mcp20260728ReadToolAdapter,
  type Mcp20260728ReadToolAdapterOptions,
} from './2026-07-28/tools.js';

export {
  DEFAULT_MCP_LISTEN_MAX_LIFETIME_MS,
  DEFAULT_MCP_LISTEN_MAX_NOTIFICATIONS,
  DEFAULT_MCP_LISTEN_MAX_QUEUE_SIZE,
  DEFAULT_MCP_LISTEN_MAX_RATE_PER_WINDOW,
  DEFAULT_MCP_LISTEN_RATE_WINDOW_MS,
  MCP_20260728_LISTEN_NOTIFICATION_METHODS,
  createMcp20260728SubscriptionsListenAdapter,
  isMcp20260728ListenTypeSupported,
  type Mcp20260728AuthorizationRecheckPort,
  type Mcp20260728ListenClosedReason,
  type Mcp20260728ListenNotification,
  type Mcp20260728ListenNotificationMethod,
  type Mcp20260728ListenOptInType,
  type Mcp20260728ListenResult,
  type Mcp20260728ListenTeardown,
  type Mcp20260728SubscriptionFilter,
  type Mcp20260728SubscriptionsListenAdapter,
  type Mcp20260728SubscriptionsListenAdapterOptions,
  type Mcp20260728SubscriptionsListenSession,
} from './2026-07-28/subscriptions.js';

export {
  DEFAULT_MCP_SCHEMA_BUDGET,
  McpSchemaBudgetError,
  assertMcpSchemaWithinBudget,
  resolveMcpSchemaBudget,
  type McpSchemaBudget,
} from './2026-07-28/schema-budget.js';
export {
  createMcp20260728WriteToolAdapter,
  Mcp20260728WriteRequestStateError,
  type Mcp20260728PlanResolution,
  type Mcp20260728PlanStatus,
  type Mcp20260728WritePlanStatusPort,
  type Mcp20260728WriteRequestStateErrorCode,
  type Mcp20260728WriteToolAdapter,
  type Mcp20260728WriteToolAdapterOptions,
  type McpApiKeyApplicationPort,
  type McpLowRiskToolDefinition,
  type McpWriteInputBudget,
  type McpWriteTransportRequirements,
} from './2026-07-28/write.js';

export {
  McpChangePlanError,
  createChangePlanService,
  type McpApprovalBeginResult,
  type McpApprovalStorePort,
  type McpChangePlanAuthorizationPolicyPort,
  type McpChangePlanClockPort,
  type McpChangePlanCommitApprovalStorePort,
  type McpChangePlanCommitCoordinatorPort,
  type McpChangePlanCommitPlanStorePort,
  type McpChangePlanCommitTransaction,
  type McpChangePlanExecutorPort,
  type McpChangePlanIdPort,
  type McpChangePlanImpactPort,
  type McpChangePlanRateLimitPort,
  type McpChangePlanRevisionMap,
  type McpChangePlanRevisionPort,
  type McpChangePlanScopePort,
  type McpChangePlanService,
  type McpChangePlanServiceOptions,
  type McpChangePlanStoredDigestPort,
  type McpChangePlanStorePort,
  type McpPlanCommitResult,
  type McpStoredPlan,
} from './2026-07-28/write.js';
export type { McpHttpUriPolicyPort } from './http-uri-policy.js';

export {
  BAGGAGE_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LOG_LEVEL_META_KEY,
  MCP_SDK_CORE_VERSION,
  MCP_SDK_META_KEY_ALLOWLIST,
  MCP_SDK_PROTOCOL_VERSION,
  MCP_SDK_PUBLIC_TYPE_ALLOWLIST,
  MCP_SDK_SCHEMA_ALLOWLIST,
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthClientMetadataSchema,
  OAuthClientRegistrationErrorSchema,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokenRevocationRequestSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OpenIdProviderMetadataSchema,
  PROTOCOL_VERSION_META_KEY,
  PromptListChangedNotificationSchema,
  RequestMetaSchema,
  ResourceListChangedNotificationSchema,
  ResourceSchema,
  ResourceTemplateSchema,
  ResultMetaObjectSchema,
  SERVER_INFO_META_KEY,
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenRequestSchema,
  SubscriptionsListenResultMetaSchema,
  SubscriptionsListenResultSchema,
  ToolListChangedNotificationSchema,
  ToolSchema,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  CallToolResultSchema,
  DiscoverRequestSchema,
  DiscoverResultSchema,
  ImplementationSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
  ResourceUpdatedNotificationSchema,
  ResultSchema,
} from '../shared/mcp-sdk-boundary.js';

export {
  OAUTH_CLIENT_SECURITY_REASON_CODES,
  OAUTH_SECRET_REDACTION,
  buildOAuthDcrClientMetadata,
  canonicalOAuthIssuer,
  classifyOAuthClientApplicability,
  enforceOAuthAuthorizationResponseIss,
  enforceOAuthAuthorizationServerMetadata,
  enforceOAuthCredentialIssuerIsolation,
  enforceOAuthDcrApplicationType,
  enforceOAuthPkce,
  enforceOAuthRedirectUri,
  enforceOAuthTokenExchangeIssuer,
  formatOAuthLogContext,
  oauthCredentialStoreKey,
  redactOAuthCredential,
  resolveOAuthApplicationType,
  rotateOAuthRefreshToken,
  selectOAuthClientCredentialForIssuer,
  selectOAuthRefreshStateForIssuer,
  type OAuthAuthorizationResponseIssDecision,
  type OAuthAuthorizationResponseIssDenialReason,
  type OAuthAuthorizationResponseIssInput,
  type OAuthAuthorizationServerMetadataDecision,
  type OAuthAuthorizationServerMetadataDenialReason,
  type OAuthAuthorizationServerMetadataOptions,
  type OAuthAuthorizationServerMetadataSnapshot,
  type OAuthClientApplicabilityDecision,
  type OAuthClientCredentialVaultPort,
  type OAuthClientDeploymentType,
  type OAuthClientHostKind,
  type OAuthClientMetadataDocument,
  type OAuthClientNotApplicableReason,
  type OAuthClientTokenStorePort,
  type OAuthCredentialIssuerIsolationDecision,
  type OAuthCredentialIssuerIsolationDenialReason,
  type OAuthDcrApplicationTypeDecision,
  type OAuthDcrApplicationTypeDenialReason,
  type OAuthDcrClientMetadataInput,
  type OAuthIssuerKeyedClientCredential,
  type OAuthIssuerKeyedRefreshState,
  type OAuthLogOperation,
  type OAuthLogSafeContext,
  type OAuthPkceDecision,
  type OAuthPkceDenialReason,
  type OAuthPkceInput,
  type OAuthRedirectUriDecision,
  type OAuthRedirectUriDenialReason,
  type OAuthRefreshRotationDecision,
  type OAuthRefreshRotationDenialReason,
  type OAuthStoredClientCredentials,
  type OAuthStoredTokens,
  type OAuthTokenExchangeIssuerDecision,
  type OAuthTokenExchangeIssuerDenialReason,
  type OAuthTokenExchangeIssuerInput,
} from '../security/mcp-oauth-client.js';
